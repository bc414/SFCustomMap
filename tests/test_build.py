import datetime as dt
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "scripts"))
sys.path.insert(0, HERE)

import build_data  # noqa: E402
import make_fixture  # noqa: E402


class BuildDataTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        make_fixture.main()
        # 2026-10-05 is a Monday.
        cls.data = build_data.build(build_data.Feed(make_fixture.OUT), dt.date(2026, 10, 5))

    def route(self, short):
        return next(i for i, r in enumerate(self.data["routes"]) if r["short"] == short)

    def test_days_collapse_into_weekday_saturday_sunday(self):
        types = [d["type"] for d in self.data["days"]]
        self.assertEqual(types, [0, 0, 0, 0, 0, 1, 2])
        self.assertEqual([d["dow"] for d in self.data["days"]], list(range(7)))

    def test_patterns_per_direction(self):
        pats = [p for p in self.data["patterns"] if p["r"] == self.route("22")]
        self.assertEqual(sorted(p["d"] for p in pats), [0, 1])
        for p in pats:
            self.assertEqual(len(p["s"]), len(p["o"]))
            self.assertEqual(len(p["s"]), len(p["gi"]))
            self.assertEqual(p["gi"], sorted(p["gi"]), "stop positions on the shape must not go backwards")

    def test_peak_only_route_has_no_weekend_trips(self):
        for p in self.data["patterns"]:
            if p["r"] == self.route("8BX"):
                self.assertEqual(set(p["t"]), {"0"})

    def test_owl_times_run_past_midnight(self):
        p = next(p for p in self.data["patterns"] if p["r"] == self.route("90"))
        self.assertTrue(all(t >= 24 * 60 for t in p["t"]["0"]))

    def test_stale_feed_falls_back_to_nearest_covered_week(self):
        # The fixture's calendar ends 2027-12-31.
        start = dt.date(2028, 3, 6)
        feed = build_data.Feed(make_fixture.OUT)
        with self.assertRaises(build_data.NoService):
            build_data.build(feed, start)
        data = build_data.build(feed, start, allow_shift=True)
        self.assertTrue(data["warning"])
        self.assertEqual(data["days"][0]["date"], "2028-03-06")
        self.assertEqual([d["dow"] for d in data["days"]], [0, 1, 2, 3, 4, 5, 6])
        self.assertEqual([d["type"] for d in data["days"]], [0, 0, 0, 0, 0, 1, 2])

    def test_polyline_encoding(self):
        # Reference value from Google's polyline documentation.
        pts = [(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)]
        self.assertEqual(build_data.encode_polyline(pts), "_p~iF~ps|U_ulLnnqC_mqNvxq`@")


if __name__ == "__main__":
    unittest.main()
