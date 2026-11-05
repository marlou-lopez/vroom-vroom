import tempfile
import unittest
from pathlib import Path

import _path  # noqa: F401
import capture
import layout as lay
import lmu_logger
import playerfilter
import winmem


class FakeSource:
    def __init__(self, frames, gone_after_idle=True):
        self.frames, self.i = frames, 0
        self.region_size = len(frames[0])
        self.closed = False

    def wait_update(self, timeout_ms=200):
        return self.i < len(self.frames)

    def read_into(self, buf):
        buf[:] = self.frames[self.i]
        self.i += 1

    def still_there(self):
        return False


class LoggerTests(unittest.TestCase):
    def test_session_records_and_ends_when_game_gone(self):
        frames = [bytes([i]) * 64 for i in range(10)]
        t = [0.0]

        def clock():
            t[0] += 5.0  # every call advances time so the idle check fires
            return t[0]

        with tempfile.TemporaryDirectory() as d:
            src = FakeSource(frames)
            path = lmu_logger.run_session(src, Path(d), "hello", lambda: False,
                                          log=lambda *_: None, clock=clock)
            self.assertEqual([f[2] for f in capture.iter_frames(path)], frames)
            self.assertTrue(path.name.startswith("lmu-") and path.suffix == ".lmucap")

    def test_empty_session_leaves_no_file(self):
        with tempfile.TemporaryDirectory() as d:
            src = FakeSource([b"\0" * 8])
            src.i = 1  # nothing to deliver
            t = [0.0]

            def clock():
                t[0] += 20.0
                return t[0]

            self.assertIsNone(lmu_logger.run_session(src, Path(d), "", lambda: False,
                                                     log=lambda *_: None, clock=clock))
            self.assertEqual(list(Path(d).iterdir()), [])


# a synthetic region: header bytes (idx at 1, present flag at 2), 4 slots of 8 bytes at 4, a tail


def synthetic_filter():
    return playerfilter.PlayerOnly(tel_offset=4, slot_size=8, slot_count=4, idx_offset=1, has_offset=2)


def synthetic_region(idx, has):
    b = bytearray(b"\xff" * 40)
    b[0], b[1], b[2], b[3] = 4, idx, has, 0xEE
    return b


class PlayerOnlyTests(unittest.TestCase):
    def test_zeroes_other_slots_and_keeps_player_and_rest(self):
        b = synthetic_region(2, 1)
        synthetic_filter().apply(b)
        self.assertEqual(bytes(b[4:20]), bytes(16))
        self.assertEqual(bytes(b[20:28]), b"\xff" * 8)
        self.assertEqual(bytes(b[28:36]), bytes(8))
        self.assertEqual((b[0], b[1], b[2], b[3]), (4, 2, 1, 0xEE))
        self.assertEqual(bytes(b[36:]), b"\xff" * 4)
        self.assertEqual(len(b), 40)

    def test_first_and_last_slot(self):
        for idx, kept in ((0, slice(4, 12)), (3, slice(28, 36))):
            b = synthetic_region(idx, 1)
            synthetic_filter().apply(b)
            self.assertEqual(bytes(b[kept]), b"\xff" * 8)
            self.assertEqual(sum(b[4:36]), 8 * 255)

    def test_no_player_zeroes_everything(self):
        b = synthetic_region(1, 0)
        synthetic_filter().apply(b)
        self.assertEqual(bytes(b[4:36]), bytes(32))
        self.assertEqual(b[36], 0xFF)

    def test_out_of_range_index_zeroes_everything(self):
        b = synthetic_region(9, 1)
        synthetic_filter().apply(b)
        self.assertEqual(bytes(b[4:36]), bytes(32))

    def test_build_from_layout_and_size_check(self):
        L = lay.parse_text(
            "struct TelemInfoV01 { double a; double b; };"
            "struct Tel { unsigned char activeVehicles; unsigned char playerVehicleIdx; bool playerHasVehicle;"
            " TelemInfoV01 telemInfo[3]; };"
            "struct SharedMemoryObjectOut { char pre[10]; Tel telemetry; };")
        size = L.sizeof("SharedMemoryObjectOut")
        pf, why = playerfilter.build(size + 100, layout_obj=L)
        self.assertEqual(why, "")
        self.assertEqual((pf.slot_size, pf.slot_count, pf.idx_offset, pf.has_offset), (16, 3, 17, 18))
        self.assertEqual(pf.tel_offset, L.offsetof("SharedMemoryObjectOut", "telemetry.telemInfo"))
        pf, why = playerfilter.build(size - 1, layout_obj=L)
        self.assertIsNone(pf)
        self.assertIn("headers do not match", why)

    def test_fallback_when_no_headers(self):
        import os
        old = os.environ.get("LMU_DIR")
        try:
            os.environ["LMU_DIR"] = "/nonexistent/lmu"
            pf, why = playerfilter.build(327680)
        finally:
            if old is None:
                os.environ.pop("LMU_DIR")
            else:
                os.environ["LMU_DIR"] = old
        self.assertIsNone(pf)
        self.assertIn("headers not found", why)

    def test_steam_vdf_parsing(self):
        vdf = '"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t}\n' \
              '\t"1"\n\t{\n\t\t"path"\t\t"D:\\\\Steam"\n\t}\n}\n'
        self.assertEqual(lay.steam_library_dirs(vdf), ["C:\\Program Files (x86)\\Steam", "D:\\Steam"])


class HeaderModeTests(unittest.TestCase):
    def run_mode(self, pf):
        frames = [synthetic_region(1, 1) for _ in range(3)]
        for i, f in enumerate(frames):
            f[12] = i  # player slot changes
            f[28] = 100 + i  # another car's slot changes
        t = [0.0]

        def clock():
            t[0] += 5.0
            return t[0]

        with tempfile.TemporaryDirectory() as d:
            path = lmu_logger.run_session(FakeSource([bytes(f) for f in frames]), Path(d), "", lambda: False,
                                          log=lambda *_: None, clock=clock, player_filter=pf)
            with open(path, "rb") as fp:
                meta = capture.read_header(fp)
            return meta, [f[2] for f in capture.iter_frames(path)]

    def test_player_only_header_and_content(self):
        meta, out = self.run_mode(synthetic_filter())
        self.assertEqual(meta["mode"], "player_only")
        self.assertEqual((meta["telemetry_offset"], meta["telemetry_slot_size"], meta["telemetry_slot_count"]), (4, 8, 4))
        self.assertEqual([f[12] for f in out], [0, 1, 2])
        self.assertEqual([f[28] for f in out], [0, 0, 0])

    def test_all_cars_header_and_content(self):
        meta, out = self.run_mode(None)
        self.assertEqual(meta["mode"], "all_cars")
        self.assertEqual([f[28] for f in out], [100, 101, 102])

    def test_old_files_without_mode_still_read(self):
        import io
        fp = io.BytesIO()
        capture.CaptureWriter(fp, 8, start_wall_ns=0, start_perf_ns=0)
        fp.seek(0)
        self.assertNotIn("mode", capture.read_header(fp))


class WinmemGuardTests(unittest.TestCase):
    def test_import_ok_and_guarded_off_windows(self):
        import sys
        if sys.platform == "win32":
            self.skipTest("Windows")
        with self.assertRaises(winmem.UnsupportedPlatform):
            winmem.LmuSource.try_open()

    def test_names(self):
        self.assertEqual(winmem.MAP_NAME, "LMU_Data")


if __name__ == "__main__":
    unittest.main()
