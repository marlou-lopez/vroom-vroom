"""Capture file format (.lmucap): writer, reader and an `info` command.

The logger stores whole-region snapshots of a shared-memory block without knowing what is in
it. This module only deals in opaque bytes: it never interprets the layout.

File layout
-----------
  header   : 8-byte magic b"LMUCAP\\x00\\x01", u32 little-endian JSON length, JSON metadata
  records  : repeated, each a fixed 25-byte head followed by a compressed payload

Record head (little-endian, struct "<BIQQI"):
  flags       u8   bit 0 = keyframe (payload is the raw frame, new zstd frame starts here)
  comp_len    u32  length of the compressed payload that follows
  perf_ns     u64  time.perf_counter_ns() when the frame was copied
  wall_ns     u64  time.time_ns() when the frame was copied
  crc         u32  zlib.crc32 of the compressed payload

Payload: zstd data for one frame. A keyframe starts a fresh compressor; every other record is
the XOR of this frame against the previous one, compressed with the same compressor and flushed
at a block boundary, so each record can be decoded as soon as it is on disk. A crash therefore
loses at most the record being written, and readers stop cleanly at a short or corrupt record.
Every `keyframe_interval` frames a keyframe resets the chain.
"""
from __future__ import annotations

import json
import struct
import sys
import zlib
from compression import zstd

MAGIC = b"LMUCAP\x00\x01"
FORMAT_VERSION = 1
HEAD = struct.Struct("<BIQQI")
FLAG_KEY = 1
DEFAULT_KEYFRAME_INTERVAL = 300
DEFAULT_LEVEL = 1


class CaptureError(Exception):
    pass


def xor_bytes(a: bytes, b: bytes) -> bytes:
    """XOR two equal-length buffers using big-int arithmetic (one C-speed pass each)."""
    n = len(a)
    return (int.from_bytes(a, "little") ^ int.from_bytes(b, "little")).to_bytes(n, "little")


class CaptureWriter:
    def __init__(self, fp, region_size: int, *, start_wall_ns: int, start_perf_ns: int,
                 note: str = "", logger_version: str = "",
                 keyframe_interval: int = DEFAULT_KEYFRAME_INTERVAL, level: int = DEFAULT_LEVEL,
                 extra: dict | None = None):
        self.fp = fp
        self.region_size = region_size
        self.keyframe_interval = keyframe_interval
        self.level = level
        self.frames = 0
        self.bytes_in = 0
        self.bytes_out = 0
        self._comp = None
        self._prev = 0  # previous frame as an int
        meta = {
            "format_version": FORMAT_VERSION,
            "region_size": region_size,
            "start_wall_ns": start_wall_ns,
            "start_perf_ns": start_perf_ns,
            "note": note,
            "logger_version": logger_version,
            "keyframe_interval": keyframe_interval,
            "zstd_level": level,
        }
        if extra:  # e.g. the logger's recording mode; readers ignore keys they don't know
            meta.update(extra)
        blob = json.dumps(meta, sort_keys=True).encode()
        fp.write(MAGIC + struct.pack("<I", len(blob)) + blob)
        fp.flush()
        self.bytes_out += len(MAGIC) + 4 + len(blob)

    def write_frame(self, perf_ns: int, wall_ns: int, data) -> int:
        """Append one frame; returns bytes written for it."""
        if len(data) != self.region_size:
            raise CaptureError(f"frame is {len(data)} bytes, expected {self.region_size}")
        cur = int.from_bytes(data, "little")
        key = self.frames % self.keyframe_interval == 0
        if key:
            self._comp = zstd.ZstdCompressor(level=self.level)
            payload = bytes(data)
        else:
            payload = (cur ^ self._prev).to_bytes(self.region_size, "little")
        comp = self._comp.compress(payload, zstd.ZstdCompressor.FLUSH_BLOCK)
        rec = HEAD.pack(FLAG_KEY if key else 0, len(comp), perf_ns, wall_ns, zlib.crc32(comp)) + comp
        self.fp.write(rec)
        self.fp.flush()
        self._prev = cur
        self.frames += 1
        self.bytes_in += self.region_size
        self.bytes_out += len(rec)
        return len(rec)


def read_header(fp) -> dict:
    head = fp.read(len(MAGIC) + 4)
    if len(head) < len(MAGIC) + 4 or head[:len(MAGIC)] != MAGIC:
        raise CaptureError("not an lmucap file (bad magic or too short)")
    (n,) = struct.unpack("<I", head[len(MAGIC):])
    blob = fp.read(n)
    if len(blob) < n:
        raise CaptureError("truncated header")
    meta = json.loads(blob)
    if meta.get("format_version") != FORMAT_VERSION:
        raise CaptureError(f"unsupported format version {meta.get('format_version')}")
    return meta


def _iter(fp, meta, stats=None):
    size = meta["region_size"]
    dec = None
    prev = 0
    while True:
        head = fp.read(HEAD.size)
        if len(head) < HEAD.size:
            if stats is not None and head:
                stats["truncated"] = True
            return
        flags, clen, perf, wall, crc = HEAD.unpack(head)
        comp = fp.read(clen)
        if len(comp) < clen or zlib.crc32(comp) != crc:
            if stats is not None:
                stats["truncated"] = True
            return
        key = bool(flags & FLAG_KEY)
        if key:
            dec = zstd.ZstdDecompressor()
        if dec is None:
            return  # chain never started
        try:
            raw = dec.decompress(comp)
        except zstd.ZstdError:
            if stats is not None:
                stats["truncated"] = True
            return
        if len(raw) != size:
            if stats is not None:
                stats["truncated"] = True
            return
        cur = int.from_bytes(raw, "little") if key else prev ^ int.from_bytes(raw, "little")
        prev = cur
        if stats is not None:
            stats["keyframes"] += key
        yield perf, wall, cur.to_bytes(size, "little")


def iter_frames(path):
    """Yield (perf_ns, wall_ns, frame_bytes). Stops quietly at a truncated or corrupt tail."""
    with open(path, "rb") as fp:
        meta = read_header(fp)
        yield from _iter(fp, meta)


def info(path) -> dict:
    import os
    with open(path, "rb") as fp:
        meta = read_header(fp)
        stats = {"truncated": False, "keyframes": 0}
        n = 0
        first = last = None
        for perf, _wall, _data in _iter(fp, meta, stats):
            n += 1
            first = perf if first is None else first
            last = perf
    dur = (last - first) / 1e9 if n > 1 else 0.0
    size = os.path.getsize(path)
    raw = n * meta["region_size"]
    return {"meta": meta, "frames": n, "keyframes": stats["keyframes"],
            "truncated": stats["truncated"], "duration_s": dur,
            "rate_hz": (n - 1) / dur if dur > 0 else 0.0,
            "file_bytes": size, "raw_bytes": raw,
            "ratio": raw / size if size else 0.0}


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 2 or argv[0] != "info":
        print("usage: python capture.py info FILE", file=sys.stderr)
        return 2
    try:
        r = info(argv[1])
    except (OSError, CaptureError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    m = r["meta"]
    print(f"format version : {m['format_version']}   logger {m.get('logger_version', '')}")
    print(f"note           : {m.get('note', '')}")
    print(f"mode           : {m.get('mode', 'all_cars (older file without a mode)')}")
    print(f"region size    : {m['region_size']} bytes")
    print(f"frames         : {r['frames']} ({r['keyframes']} keyframes)"
          + ("   [file ends in a truncated record]" if r["truncated"] else ""))
    print(f"duration       : {r['duration_s']:.1f} s   rate {r['rate_hz']:.1f} frames/s")
    print(f"file size      : {r['file_bytes'] / 1e6:.2f} MB   raw {r['raw_bytes'] / 1e6:.1f} MB"
          f"   ratio {r['ratio']:.1f}x")
    return 0


if __name__ == "__main__":
    sys.exit(main())
