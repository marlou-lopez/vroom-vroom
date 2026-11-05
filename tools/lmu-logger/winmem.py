"""Windows-only access to LMU's shared memory. Everything that touches the Win32 API lives here.

Importing this module is safe on any OS; opening a source on a non-Windows system raises
UnsupportedPlatform. Only public object names and the general mechanism are used: a named file
mapping holding the data, plus two named events that signal "writer busy" and "new data".
The mapping is opened and mapped read-only and nothing is ever written to it.

The game also has a cross-process lock that readers may take. That needs an atomic
compare-and-swap on memory shared with the game; see the README for why we do not take it.
"""
from __future__ import annotations

import ctypes
import sys

MAP_NAME = "LMU_Data"
HOLD_EVENT = b"LMU_Data_HoldEvent"
DATA_EVENT = b"LMU_Data_DataEvent"

FILE_MAP_READ = 0x0004
SYNCHRONIZE = 0x00100000
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 0x102


class UnsupportedPlatform(RuntimeError):
    pass


def _api():
    if sys.platform != "win32":
        raise UnsupportedPlatform("the shared-memory source only works on Windows")
    from ctypes import wintypes as w
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.OpenFileMappingW.argtypes = [w.DWORD, w.BOOL, w.LPCWSTR]
    k.OpenFileMappingW.restype = w.HANDLE
    k.MapViewOfFile.argtypes = [w.HANDLE, w.DWORD, w.DWORD, w.DWORD, ctypes.c_size_t]
    k.MapViewOfFile.restype = ctypes.c_void_p
    k.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
    k.UnmapViewOfFile.restype = w.BOOL
    k.OpenEventA.argtypes = [w.DWORD, w.BOOL, w.LPCSTR]
    k.OpenEventA.restype = w.HANDLE
    k.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
    k.WaitForSingleObject.restype = w.DWORD
    k.CloseHandle.argtypes = [w.HANDLE]
    k.CloseHandle.restype = w.BOOL

    class MBI(ctypes.Structure):  # MEMORY_BASIC_INFORMATION (public Win32 type)
        _fields_ = [("BaseAddress", ctypes.c_void_p), ("AllocationBase", ctypes.c_void_p),
                    ("AllocationProtect", w.DWORD), ("PartitionId", w.WORD),
                    ("RegionSize", ctypes.c_size_t), ("State", w.DWORD),
                    ("Protect", w.DWORD), ("Type", w.DWORD)]
    k.VirtualQuery.argtypes = [ctypes.c_void_p, ctypes.POINTER(MBI), ctypes.c_size_t]
    k.VirtualQuery.restype = ctypes.c_size_t
    return k, MBI


class LmuSource:
    """An open, read-only view of the game's shared memory plus its update events."""

    def __init__(self, k, mbi, h_map, view, size, h_hold, h_data):
        self._k, self._mbi = k, mbi
        self._h_map, self._view, self.region_size = h_map, view, size
        self._h_hold, self._h_data = h_hold, h_data

    @classmethod
    def try_open(cls):
        """Return a source, or None if LMU's mapping or events do not exist (yet)."""
        k, MBI = _api()
        h_map = k.OpenFileMappingW(FILE_MAP_READ, False, MAP_NAME)
        if not h_map:
            return None
        h_hold = h_data = view = None
        try:
            h_hold = k.OpenEventA(SYNCHRONIZE, False, HOLD_EVENT)
            h_data = k.OpenEventA(SYNCHRONIZE, False, DATA_EVENT)
            view = k.MapViewOfFile(h_map, FILE_MAP_READ, 0, 0, 0)
            if not (h_hold and h_data and view):
                raise OSError
            info = MBI()
            if not k.VirtualQuery(view, ctypes.byref(info), ctypes.sizeof(info)):
                raise OSError
            return cls(k, MBI, h_map, view, int(info.RegionSize), h_hold, h_data)
        except OSError:
            for h in (h_hold, h_data):
                if h:
                    k.CloseHandle(h)
            if view:
                k.UnmapViewOfFile(view)
            k.CloseHandle(h_map)
            return None

    def wait_update(self, timeout_ms: int = 200) -> bool:
        """Wait for the game to finish a frame: Hold event first, then Data event."""
        if self._k.WaitForSingleObject(self._h_hold, timeout_ms) != WAIT_OBJECT_0:
            return False
        return self._k.WaitForSingleObject(self._h_data, timeout_ms) == WAIT_OBJECT_0

    def read_into(self, buf: bytearray) -> None:
        """Copy the whole region into buf (len(buf) must equal region_size)."""
        dst = (ctypes.c_char * len(buf)).from_buffer(buf)
        ctypes.memmove(dst, self._view, len(buf))

    def still_there(self) -> bool:
        """Release our handles and look the mapping up again.

        While we hold a handle the name stays alive even after the game exits, so the only
        reliable test is to let go and see whether the game's mapping still exists.
        Returns False if it is gone or its size changed (treat as a new session).
        """
        size = self.region_size
        self.close()
        again = LmuSource.try_open()
        if again is None:
            return False
        self.__dict__.update(again.__dict__)
        again._h_map = again._view = again._h_hold = again._h_data = None  # ownership moved
        return self.region_size == size

    def close(self) -> None:
        k = self._k
        if self._view:
            k.UnmapViewOfFile(self._view)
        for h in (self._h_hold, self._h_data, self._h_map):
            if h:
                k.CloseHandle(h)
        self._view = self._h_hold = self._h_data = self._h_map = None
