import unittest

import _path  # noqa: F401
import layout as lay

SYNTH = r"""
// comment with struct Fake { int nope; };
#define COUNT 3
#define TWICE (COUNT * 2)
#pragma pack( push, 4 )
enum class Kind : uint8_t { A = 0, B, C = 0x10 };
enum Big { BIG_ONE = 1, BIG_MAX };
struct Vec3
{
    union {
        struct { double x, y, z; };
        double data[3];
    };
    void Set(double a) { x = a; }
    double &operator[]( long i ) { return data[i]; }
    Vec3() {}
};
struct Wheel { float temp; unsigned char flags[3]; Kind kind; };
struct Car /* c */ {
    long id;                 // 4 bytes on Windows
    char name[COUNT + 2];
    Vec3 pos;
    Vec3 ori[COUNT];
    Wheel wheels[TWICE][2];
    double speed;
    void *ptr;
    Big big;
    static int ignored;
    int Method() const { return id; }
};
struct Derived : public Wheel { double extra; };
#pragma pack( pop )
struct Outer { char c; Car car; Wheel w; short tail; };
struct Empty {};
class Skipped { int hidden; };
typedef struct Typedefd { int q; } TD;
static void helper(int a) { if (a) { return; } }
"""


class ParserTests(unittest.TestCase):
    def setUp(self):
        self.L = lay.parse_text(SYNTH)

    def test_enum_and_define_in_sizes(self):
        w = self.L.record("Wheel")
        self.assertEqual((w.size, w.align), (8, 4))  # float, 3 bytes, 1-byte enum
        self.assertEqual(w.offsetof("kind"), 7)

    def test_anonymous_union_members_reachable(self):
        v = self.L.record("Vec3")
        self.assertEqual(v.size, 24)
        self.assertEqual([v.offsetof(n) for n in ("x", "y", "z", "data")], [0, 8, 16, 0])

    def test_pack_caps_alignment_and_arrays(self):
        car = self.L.record("Car")
        self.assertEqual(car.offsetof("id"), 0)
        self.assertEqual(car.offsetof("name"), 4)
        self.assertEqual(car.offsetof("pos"), 12)   # 4 + 5 -> 9 -> aligned to 4 (pack 4), not 8
        self.assertEqual(car.offsetof("ori"), 36)
        self.assertEqual(car.offsetof("wheels"), 36 + 72)
        self.assertEqual(car.find("wheels")[1].dims, (6, 2))
        self.assertEqual(car.offsetof("speed"), 108 + 96)
        self.assertEqual(car.offsetof("ptr"), 108 + 96 + 8)
        self.assertEqual(car.align, 4)

    def test_methods_classes_typedefs_statics_skipped(self):
        self.assertNotIn("Fake", self.L.records)
        self.assertNotIn("Skipped", self.L.records)
        with self.assertRaises(KeyError):
            self.L.record("Car").find("ignored")
        self.assertNotIn("Typedefd", self.L.records)

    def test_base_class_and_default_packing_after_pop(self):
        d = self.L.record("Derived")
        self.assertEqual(d.offsetof("extra"), 8)
        self.assertEqual(d.size, 16)
        o = self.L.record("Outer")  # defined after pop: natural 8-byte alignment where members are 8
        self.assertEqual(o.offsetof("car"), 4)  # Car's alignment is 4 (it was packed)
        self.assertEqual(self.L.record("Empty").size, 1)

    def test_offsetof_path(self):
        self.assertEqual(self.L.offsetof("Car", "pos.z"), 12 + 16)

    def test_flatten_names(self):
        names = [s.name for s in lay.flatten(self.L.record("Car"))]
        self.assertIn("pos_x", names)
        self.assertNotIn("pos_data_0", names)       # only the first alternative of a union
        self.assertIn("ori_2_z", names)
        self.assertIn("wheels_5_1_temp", names)
        self.assertNotIn("name_0", names)            # char arrays are strings: skipped
        self.assertNotIn("ptr", names)
        self.assertIn("wheels_0_0_flags_2", names)
        self.assertIn("speed", names)

    def test_flatten_offsets(self):
        sc = {s.name: s.offset for s in lay.flatten(self.L.record("Car"))}
        self.assertEqual(sc["pos_y"], 12 + 8)
        self.assertEqual(sc["ori_1_x"], 36 + 24)

    def test_unknown_type_is_an_error(self):
        with self.assertRaises(lay.LayoutError):
            lay.parse_text("struct A { Mystery m; };")

    def test_undefined_constant_defaults_max_path(self):
        L = lay.parse_text("struct A { char p[MAX_PATH]; };")
        self.assertEqual(L.sizeof("A"), 260)


class RealHeaderTests(unittest.TestCase):
    """Only runs where LMU's headers are installed (they are not part of this repo)."""

    @classmethod
    def setUpClass(cls):
        d = lay.find_headers_dir(None)
        if d is None:
            raise unittest.SkipTest("LMU headers not found (set LMU_DIR)")
        cls.L = lay.parse_file(d / lay.DEFAULT_ENTRY)

    def test_sizes(self):
        self.assertEqual(self.L.sizeof("TelemInfoV01"), 1888)
        self.assertEqual(self.L.sizeof("VehicleScoringInfoV01"), 584)
        self.assertEqual(self.L.sizeof("SharedMemoryObjectOut"), 324824)

    def test_offsets(self):
        t = self.L.record("TelemInfoV01")
        self.assertEqual([t.offsetof(n) for n in ("mElapsedTime", "mLapNumber", "mPos")], [12, 20, 160])
        v = self.L.record("VehicleScoringInfoV01")
        self.assertEqual([v.offsetof(n) for n in ("mLapDist", "mIsPlayer")], [104, 196])
        self.assertEqual(self.L.offsetof("SharedMemoryObjectOut", "telemetry"), 128464)


if __name__ == "__main__":
    unittest.main()
