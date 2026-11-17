import unittest

import _path  # noqa: F401
from balance_check import lag_steering


class LagSteering(unittest.TestCase):
    def test_none_and_zero_return_the_input(self):
        st = [0.0, 1.0, 2.0]
        self.assertIs(lag_steering(st, [10.0] * 3, 0.0, "delay"), st)
        self.assertIs(lag_steering(st, [10.0] * 3, 0.1, "none"), st)

    def test_delay_reads_the_steering_v_tau_metres_earlier(self):
        st = [float(d) for d in range(50)]
        out = lag_steering(st, [20.0] * 50, 0.1, "delay")  # 2 m back
        self.assertAlmostEqual(out[10], 8.0)
        self.assertAlmostEqual(out[1], 0.0)  # clamped at the lap start

    def test_negative_delay_advances_and_clamps_at_the_end(self):
        st = [float(d) for d in range(50)]
        out = lag_steering(st, [20.0] * 50, -0.1, "delay")
        self.assertAlmostEqual(out[10], 12.0)
        self.assertAlmostEqual(out[49], 49.0)

    def test_first_order_lag_approaches_a_step(self):
        st = [0.0] * 5 + [1.0] * 200
        out = lag_steering(st, [10.0] * 205, 0.1, "first")  # dt 0.1 s per metre, alpha 0.5
        self.assertAlmostEqual(out[5], 0.5)
        self.assertAlmostEqual(out[6], 0.75)
        self.assertGreater(out[-1], 0.999)


if __name__ == "__main__":
    unittest.main()
