import io
import os
import random
import struct
import tempfile
import time
import unittest
from pathlib import Path

import _path  # noqa: F401
import capture

SIZE = 4096


def make_frames(n, size=SIZE, seed=1):
    rnd = random.Random(seed)
    cur = bytearray(rnd.randbytes(size))
    out = []
    for _ in range(n):
        for _ in range(8):
            cur[rnd.randrange(size)] = rnd.randrange(256)
        out.append(bytes(cur))
    return out


def write(path, frames, **kw):
    with open(path, "wb") as fp:
        w = capture.CaptureWriter(fp, len(frames[0]), start_wall_ns=5, start_perf_ns=6,
                                  note="n", logger_version="t", **kw)
        for i, f in enumerate(frames):
            w.write_frame(1000 + i, 2000 + i, f)
    return w


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "x.lmucap"

    def tearDown(self):
        self.dir.cleanup()

    def test_round_trip_with_keyframes(self):
        frames = make_frames(25)
        write(self.path, frames, keyframe_interval=10)
        got = list(capture.iter_frames(self.path))
        self.assertEqual([g[2] for g in got], frames)
        self.assertEqual([g[0] for g in got], [1000 + i for i in range(25)])
        self.assertEqual([g[1] for g in got], [2000 + i for i in range(25)])
        self.assertEqual(capture.info(self.path)["keyframes"], 3)  # frames 0, 10, 20

    def test_header(self):
        write(self.path, make_frames(1))
        with open(self.path, "rb") as fp:
            m = capture.read_header(fp)
        self.assertEqual((m["region_size"], m["note"], m["start_wall_ns"], m["logger_version"]),
                         (SIZE, "n", 5, "t"))
        self.assertEqual(m["format_version"], capture.FORMAT_VERSION)

    def test_bad_magic(self):
        self.path.write_bytes(b"nope" * 10)
        with self.assertRaises(capture.CaptureError):
            list(capture.iter_frames(self.path))

    def test_truncated_every_cut_point_yields_a_prefix(self):
        frames = make_frames(12)
        write(self.path, frames, keyframe_interval=5)
        data = self.path.read_bytes()
        for cut in range(len(data) - 1, len(data) - 600, -37):
            self.path.write_bytes(data[:cut])
            got = [g[2] for g in capture.iter_frames(self.path)]
            self.assertEqual(got, frames[:len(got)])
            self.assertLess(len(got), 12)
        self.path.write_bytes(data[:-3])
        self.assertTrue(capture.info(self.path)["truncated"])

    def test_corrupt_record_stops_cleanly(self):
        frames = make_frames(6)
        write(self.path, frames, keyframe_interval=100)
        data = bytearray(self.path.read_bytes())
        data[-5] ^= 0xFF
        self.path.write_bytes(data)
        got = [g[2] for g in capture.iter_frames(self.path)]
        self.assertEqual(got, frames[:5])

    def test_wrong_frame_size_rejected(self):
        with self.assertRaises(capture.CaptureError):
            with open(self.path, "wb") as fp:
                w = capture.CaptureWriter(fp, 8, start_wall_ns=0, start_perf_ns=0)
                w.write_frame(0, 0, b"123")

    def test_unchanged_frames_are_tiny(self):
        f = make_frames(1)[0]
        w = write(self.path, [f] * 50)
        self.assertLess(w.bytes_out, len(f) * 2)  # 50 frames cost about one keyframe

    def test_info_cli(self):
        write(self.path, make_frames(5))
        self.assertEqual(capture.main(["info", str(self.path)]), 0)
        self.assertEqual(capture.main(["info", str(self.path) + ".missing"]), 1)

    def test_cost_per_frame(self):
        """Report the cost of XOR + compress for a ~400 KB region with sparse changes."""
        size = 400_000
        rnd = random.Random(3)
        # telemetry-like: mostly structured/repetitive floats with some noise
        base = bytearray(b"".join(struct.pack("<d", rnd.random()) for _ in range(size // 8)))
        frames = []
        cur = bytearray(base)
        for _ in range(60):
            for _ in range(300):  # ~300 changed bytes per frame
                cur[rnd.randrange(size)] = rnd.randrange(256)
            frames.append(bytes(cur))
        fp = io.BytesIO()
        w = capture.CaptureWriter(fp, size, start_wall_ns=0, start_perf_ns=0, keyframe_interval=300)
        w.write_frame(0, 0, frames[0])
        t = time.perf_counter()
        for i, f in enumerate(frames[1:], 1):
            w.write_frame(i, i, f)
        per = (time.perf_counter() - t) / (len(frames) - 1)
        x = time.perf_counter()
        for i in range(1, len(frames)):
            capture.xor_bytes(frames[i], frames[i - 1])
        xor_only = (time.perf_counter() - x) / (len(frames) - 1)
        print(f"\n[bench] 400 KB delta frame: {per * 1e3:.2f} ms total, "
              f"xor_bytes alone {xor_only * 1e3:.2f} ms, "
              f"{(fp.tell() - 0) / len(frames):.0f} B/frame average")
        self.assertLess(per, 0.05)  # generous guard; the real figure is printed above


if __name__ == "__main__":
    unittest.main()
