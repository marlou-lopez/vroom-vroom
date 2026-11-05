import struct
import unittest

import _path  # noqa: F401
import contacts as ct
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


SURVEY_HEADER = """
struct V3 { double x; double y; double z; };
struct TelemWheelV01 { double mSuspensionDeflection; char mTerrainName[16]; unsigned char mSurfaceType; };
struct TelemInfoV01 { int mID; double mElapsedTime; V3 mPos; V3 mOri[3]; char mTrackName[16]; TelemWheelV01 mWheel[4]; };
struct VehicleScoringInfoV01 {
  int mID; double mLapDist; double mTrackEdge; unsigned char mInPits; unsigned char mInGarageStall;
  unsigned char mIsPlayer; V3 mPos;
};
struct ScoringInfoV01 { int mNumVehicles; };
struct Tel { unsigned char activeVehicles; unsigned char playerVehicleIdx; unsigned char playerHasVehicle;
  TelemInfoV01 telemInfo[3]; };
struct Sco { ScoringInfoV01 scoringInfo; VehicleScoringInfoV01 vehScoringInfo[3]; };
struct SharedMemoryObjectOut { Tel telemetry; Sco scoring; };
"""


IDENTITY = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
ROAD, PAINT, RAZOR, DRAIN = "RDRACEOLD,ROAD,", "RDPAINT", "RMBLRAZOR", "COBL,DRAIN"


class SurveyTests(unittest.TestCase):
    def setUp(self):
        self.L = lay.parse_text(SURVEY_HEADER)
        self.sc = decode.Schema(self.L)

    def frame(self, vehicles=(), slots=()):
        """vehicles: (lapdist, edge, x, z, pits, garage[, id]); slots: (x, z, [terrain names for 4 wheels][, extras]).
        extras: {"et": elapsed time, "ori": 3 rows of 3, "id": vehicle id}."""
        sc = self.sc
        f = bytearray(sc.out_size)
        struct.pack_into("<i", f, sc.o_nveh, len(vehicles))
        srec, trec, wrec = self.L.record(decode.SCOR), self.L.record(decode.TELEM), self.L.record("TelemWheelV01")
        for k, veh in enumerate(vehicles):
            ld, edge, x, z, pits, garage = veh[:6]
            v = sc.o_veh + k * sc.ssize
            struct.pack_into("<i", f, v + srec.offsetof("mID"), veh[6] if len(veh) > 6 else k)
            struct.pack_into("<d", f, v + srec.offsetof("mLapDist"), ld)
            struct.pack_into("<d", f, v + srec.offsetof("mTrackEdge"), edge)
            struct.pack_into("<3d", f, v + srec.offsetof("mPos"), x, 0.0, z)
            f[v + srec.offsetof("mInPits")] = pits
            f[v + srec.offsetof("mInGarageStall")] = garage
        for k, slot in enumerate(slots):
            x, z, names = slot[:3]
            extra = slot[3] if len(slot) > 3 else {}
            t0 = sc.o_tel + k * sc.tsize
            struct.pack_into("<i", f, t0 + trec.offsetof("mID"), extra.get("id", k))
            struct.pack_into("<d", f, t0 + trec.offsetof("mElapsedTime"), extra.get("et", 0.0))
            struct.pack_into("<9d", f, t0 + trec.offsetof("mOri"), *[c for row in extra.get("ori", IDENTITY) for c in row])
            struct.pack_into("<3d", f, t0 + trec.offsetof("mPos"), x, 0.0, z)
            f[t0 + trec.offsetof("mTrackName"):t0 + trec.offsetof("mTrackName") + 3] = b"Spa"
            for w, n in enumerate(names):
                o = t0 + trec.offsetof("mWheel") + w * wrec.size + wrec.offsetof("mTerrainName")
                f[o:o + len(n)] = n.encode()
        return bytes(f)

    def test_edges_median_per_side_and_metre_and_skips_pits(self):
        sv = decode.Survey(self.sc)
        sv.add_frame(self.frame([(10.2, -5.0, 100.0, 0.0, 0, 0), (10.7, 6.0, 100.0, 4.0, 0, 0), (10.4, -7.0, 0.0, 0.0, 1, 0)]))
        sv.add_frame(self.frame([(10.9, -7.0, 102.0, 0.0, 0, 0), (50.0, 0.0, 1.0, 1.0, 0, 0), (10.5, -9.0, 0, 0, 0, 1)]))
        sv.add_frame(self.frame([(10.9, -7.0, 102.0, 0.0, 0, 0)]))  # unchanged scoring values: not counted again
        sv.add_frame(self.frame([(10.1, -9.0, 104.0, 0.0, 0, 0)]))  # same slot 0, new values
        r = sv.result(["a.lmucap"])
        left = [e for e in r["edges"] if e[2] == 0]
        right = [e for e in r["edges"] if e[2] == 1]
        self.assertEqual(len(left), 1)
        self.assertEqual(left[0], [102.0, 0.0, 0, 7.0])  # median of 5, 7, 9; mean x of 100, 102, 104
        self.assertEqual(right, [[100.0, 4.0, 1, 6.0]])

    def test_kerbs_kind_side_dedupe_and_track(self):
        sv = decode.Survey(self.sc)
        names = ["RMBLFLAT", "RDRACEOLD,ROAD,", "RMBLRAZOR", "RMBLOTHER"]
        for _ in range(3):
            sv.add_frame(self.frame(slots=[(10.0, 20.0, names), (0.0, 5.0, names)]))  # slot 2 empty (x == 0), slot 1 too
        r = sv.result([])
        self.assertEqual(r["track"], "Spa")
        got = sorted((k[2], k[3]) for k in r["kerbs"])
        self.assertEqual(got, [(0, "flat"), (0, "razor"), (1, "other")])
        self.assertEqual(len(r["kerbs"]), 3)
        self.assertEqual(r["kerbs"][0][:2], [10.0, 20.0])


class ContactTests(SurveyTests):
    """Wheel surface changes -> edge contacts. Identity orientation: vehicle +x = world +x (left), vehicle +z = world +z (back)."""

    def survey(self):
        sv = decode.Survey(self.sc, ct.Geometry(0.85, -1.35, 1.35), fit=False)
        sv.start_file()
        return sv

    def run_slot(self, sv, samples, vehicles=()):
        """samples: (et, x, z, names, ori?) for slot 0, one frame each."""
        for et, x, z, *rest in samples:
            names = rest[0]
            extra = {"et": et, **({"ori": rest[1]} if len(rest) > 1 else {})}
            sv.add_frame(self.frame(vehicles=vehicles, slots=[(x, z, names, extra)]))
        return sv.result([])

    def test_classify(self):
        self.assertEqual(ct.classify(b"RDRACEOLD,ROAD,"), ct.TARMAC)
        self.assertEqual(ct.classify(b"RDPAINT"), ct.TARMAC)
        self.assertEqual(ct.classify(b"RMBLFLAT"), ct.KERB)
        self.assertEqual(ct.classify(b"RMBLWHATEVER"), ct.KERB)
        for off in (b"COBL,DRAIN", b"CRETE", b"RDCP,CONC", b"RDRUNOFF", b"GRVL", b"GRAS"):
            self.assertEqual(ct.classify(off), ct.OFF)
        self.assertIsNone(ct.classify(b""))

    def test_tarmac_to_off_and_back_is_an_edge_at_the_wheel_position_midpoint(self):
        sv = self.survey()
        # The car moves in -z (forward). Only the front-left wheel leaves the tarmac, between samples at z = 100 and 99.
        on = [ROAD] * 4
        left_off = [DRAIN, ROAD, ROAD, ROAD]
        r = self.run_slot(sv, [(1.00, 50.0, 100.0, on), (1.01, 50.0, 99.0, left_off), (1.02, 50.0, 98.0, left_off),
                               (1.03, 50.0, 97.0, on)])
        # FL offset (+0.85, -1.35): world (50.85, z - 1.35); the crossing is the midpoint of z = 100 and 99
        pos = sorted((c[0], c[1], c[2]) for c in r["contacts"])
        self.assertEqual(pos, [(50.85, 96.15, "edge"), (50.85, 98.15, "edge")])  # leaving at 99.5, returning at 97.5

    def test_kerb_boundaries(self):
        sv = self.survey()
        r = self.run_slot(sv, [(1.00, 20.0, 10.0, [ROAD] * 4), (1.01, 20.0, 9.0, [ROAD, RAZOR, ROAD, ROAD]),
                               (1.02, 20.0, 8.0, [ROAD, DRAIN, ROAD, ROAD])])
        # FR (x -0.85, z -1.35): tarmac -> kerb at z 9.5 is an edge; kerb -> off at z 8.5 is the kerb's outer boundary
        self.assertEqual(sorted(r["contacts"]), [[19.15, 7.15, "kerb_outer"], [19.15, 8.15, "edge"]])

    def test_unknown_names_and_no_change_make_nothing(self):
        sv = self.survey()
        r = self.run_slot(sv, [(1.00, 20.0, 10.0, [ROAD] * 4), (1.01, 20.0, 9.0, ["", ROAD, ROAD, ROAD]),
                               (1.02, 20.0, 8.0, [DRAIN, ROAD, ROAD, ROAD]), (1.03, 20.0, 7.0, [DRAIN, PAINT, ROAD, ROAD])])
        self.assertEqual(r["contacts"], [])  # tarmac -> "" -> off is not a crossing; paint is tarmac

    def test_unchanged_elapsed_time_is_one_sample(self):
        sv = self.survey()
        r = self.run_slot(sv, [(1.00, 20.0, 10.0, [ROAD] * 4), (1.00, 20.0, 5.0, [DRAIN] * 4), (1.01, 20.0, 9.0, [ROAD] * 4)])
        self.assertEqual(r["contacts"], [])

    def test_pits_and_garage_skipped(self):
        sv = self.survey()
        veh = [(0.0, 0.0, 0.0, 0.0, 1, 0, 0)]   # vehicle id 0 is in the pits
        r = self.run_slot(sv, [(1.00, 20.0, 10.0, [ROAD] * 4), (1.01, 20.0, 9.0, [DRAIN, ROAD, ROAD, ROAD])], veh)
        self.assertEqual(r["contacts"], [])
        sv = self.survey()
        veh = [(0.0, 0.0, 0.0, 0.0, 0, 1, 0)]   # in a garage stall
        self.assertEqual(self.run_slot(sv, [(1.00, 20.0, 10.0, [ROAD] * 4), (1.01, 20.0, 9.0, [DRAIN, ROAD, ROAD, ROAD])], veh)["contacts"], [])
        sv = self.survey()
        veh = [(0.0, 0.0, 0.0, 0.0, 0, 0, 0)]   # on track
        self.assertEqual(len(self.run_slot(sv, [(1.00, 20.0, 10.0, [ROAD] * 4), (1.01, 20.0, 9.0, [DRAIN, ROAD, ROAD, ROAD])], veh)["contacts"]), 1)

    def test_teleports_and_front_rear_simultaneous_changes_are_ignored(self):
        sv = self.survey()
        r = self.run_slot(sv, [(1.00, 20.0, 10.0, [ROAD] * 4), (1.01, 520.0, 900.0, [DRAIN] * 4)])
        self.assertEqual(r["contacts"], [])
        sv = self.survey()
        r = self.run_slot(sv, [(1.00, 20.0, 10.0, [ROAD] * 4), (1.01, 20.0, 9.0, [DRAIN, ROAD, DRAIN, ROAD])])
        self.assertEqual(r["contacts"], [])   # FL and RL cannot cross in the same 10 ms

    def test_orientation_rotates_the_wheel_offsets(self):
        # Car heading toward world +x: forward (vehicle -z) = world +x, so vehicle z = world -x; vehicle +x (left) = world +z
        # when the world is left-handed with +y up (left = forward x up... checked on a capture: see docs).
        ori = ((0.0, 0.0, -1.0), (0.0, 1.0, 0.0), (1.0, 0.0, 0.0))   # world_x = -local_z, world_z = +local_x
        sv = self.survey()
        r = self.run_slot(sv, [(1.00, 10.0, 0.0, [ROAD] * 4, ori), (1.01, 11.0, 0.0, [ROAD, ROAD, ROAD, DRAIN], ori)])
        # RR (x -0.85, z +1.35) -> world (x - 1.35, z - 0.85)
        self.assertEqual(r["contacts"], [[9.15, -0.85, "edge"]])

    def test_contacts_dedupe_on_a_quarter_metre_grid_per_kind(self):
        sv = self.survey()
        seq = []
        for i in range(3):   # three passes over the same edge, 5 cm apart
            et = 1.0 + i
            seq += [(et, 20.0, 10.0 + 0.05 * i, [ROAD] * 4), (et + 0.01, 20.0, 9.0 + 0.05 * i, [DRAIN, ROAD, ROAD, ROAD]),
                    (et + 0.02, 20.0, 10.0 + 0.05 * (i + 1), [ROAD] * 4)]
        r = self.run_slot(sv, seq)
        self.assertEqual(len(r["contacts"]), 2)   # one going out, one coming back
        self.assertEqual(r["wheel_offsets"]["half_track_m"], 0.85)
        self.assertEqual(r["wheel_offsets"]["fit"], {"fitted": False})

    def test_fit_finds_the_wheelbase_from_front_and_rear_crossings(self):
        # A car driving along -z at 20 m/s (10 ms samples = 0.2 m) whose left side is off the tarmac on 5 of every 10 m,
        # seen by the front-left wheel and, wheelbase later, by the rear-left wheel. True axles: -1.2 and +1.5.
        sv = decode.Survey(self.sc, ct.Geometry(0.85, -1.35, 1.35), fit=True)
        sv.start_file()
        step, et, z = 0.2, 0.0, 400.0
        while z > 0:
            names = []
            for wz in (-1.2, 1.5):     # world z of the front and rear axle = z + local z
                zz = z + wz
                names.append(DRAIN if zz % 10 < 5 else ROAD)
            f = [names[0], ROAD, names[1], ROAD]
            sv.add_frame(self.frame(slots=[(20.0, z, f, {"et": et})]))
            et += 0.01
            z -= step
        r = sv.result([])
        fit = r["wheel_offsets"]["fit"]
        self.assertTrue(fit["fitted"])
        self.assertAlmostEqual(fit["wheelbase_m"], 2.7, delta=0.15)   # samples are 0.2 m apart, so about that precise
        self.assertGreater(fit["pairs"], 4)
        self.assertLess(fit["after"]["median_m"], 0.1)
        # the split between the axles cannot be fitted: the midpoint of the prior is kept
        self.assertAlmostEqual(r["wheel_offsets"]["front_z_m"] + r["wheel_offsets"]["rear_z_m"], 0.0, places=2)


if __name__ == "__main__":
    unittest.main()
