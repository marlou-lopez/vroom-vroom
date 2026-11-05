import struct
import unittest

import _path  # noqa: F401
import decode
import layout as lay


class StructForTests(unittest.TestCase):
    def test_reads_scalars_with_padding(self):
        L = lay.parse_text("struct R { int a; double b; unsigned char tag[2]; short s; char name[4]; };")
        sc = decode.scalar_list(L.record("R"))
        self.assertEqual([s.name for s in sc], ["a", "b", "tag_0", "tag_1", "s"])
        st = decode.struct_for(sc)
        raw = struct.pack("<i4xd", 7, 2.5) + bytes([9, 8]) + struct.pack("<h", -3) + b"abcd"
        self.assertEqual(st.unpack_from(raw.ljust(40, b"\0")), (7, 2.5, 9, 8, -3))

    def test_wheels_renamed_and_expansion_skipped(self):
        L = lay.parse_text("struct W { float t; }; struct R { W mWheel[2]; unsigned char mExpansion[4]; };")
        self.assertEqual([s.name for s in decode.scalar_list(L.record("R"))], ["w0_t", "w1_t"])


class ResampleTests(unittest.TestCase):
    def test_straight_line_every_metre_with_interpolated_height(self):
        r = decode.resample([(0, 0, 0), (0, 10.5, 10.5), (0, 10.5, 10.5)])
        self.assertEqual(len(r), 11)
        self.assertAlmostEqual(r[5][1], 5.0)
        self.assertAlmostEqual(r[5][2], 5.0)

    def test_stationary_points_dropped(self):
        self.assertEqual(len(decode.resample([(1, 1, 0)] * 5)), 1)

    def test_turn_length_is_path_length(self):
        r = decode.resample([(0, 0, 0), (3, 0, 0), (3, 4, 0)])
        self.assertEqual(len(r), 8)  # 7 m of path -> 0..7


class BuildTrackTests(unittest.TestCase):
    def samples(self):
        out = []
        et = 0.0
        # lap 0: 20 m, lap 1: 30 m taking 5 s, lap 2: 10 m; scoring lags: lap-2 samples still read 5.0
        for lap, n, llt in ((0, 20, -1.0), (1, 30, -1.0), (2, 10, 5.0)):
            for i in range(n + 1):
                out.append((lap, float(i), 0.0, 1.0 * i, llt, et))
                et += 5.0 / 31
        return out

    def test_laps_and_indices(self):
        d = decode.build_track(self.samples(), "src", "Spa")
        self.assertEqual(d["track"], "Spa")
        self.assertEqual([lp["lap"] for lp in d["laps"]], [0, 1, 2])
        self.assertEqual(d["laps"][0]["start_index"], 0)
        self.assertEqual(d["laps"][1]["start_index"], d["laps"][0]["end_index"])
        self.assertEqual(d["laps"][-1]["end_index"], len(d["points"]))
        self.assertEqual(d["points"][1], [1.0, 0.0, 1.0])  # [x, z, y]

    def test_lap_time_needs_to_match_elapsed_time(self):
        d = decode.build_track(self.samples(), "src", "Spa")
        self.assertAlmostEqual(d["laps"][1]["lap_time_s"], 5.0)
        self.assertIsNone(d["laps"][0]["lap_time_s"])  # scoring said -1
        self.assertIsNone(d["laps"][2]["lap_time_s"])  # no later lap

    def test_stale_lap_time_is_rejected(self):
        s = self.samples() + [(3, 0.0, 0.0, 0.0, 5.0, 100.0), (3, 1.0, 0.0, 0.0, 5.0, 100.1)]
        d = decode.build_track(s, "src", None)
        self.assertIsNone(d["laps"][2]["lap_time_s"])  # lap 3 started ~long after; 5.0 is stale


if __name__ == "__main__":
    unittest.main()
