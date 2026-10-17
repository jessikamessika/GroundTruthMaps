"""Run: python3 -m unittest Scraping/tests/test_sfmta_source.py  (from repo root)
Fixture rows are copied from the live DataSF export (inspected 2026-10-16)."""
import csv, sys, unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sources.sfmta_closures_source import build_features, parse_rows, _wkt_to_geometry

FIX = Path(__file__).parent / "fixtures" / "sfmta_sample.csv"
NOW = datetime(2026, 10, 16, 18, 0, tzinfo=timezone.utc)   # Fri 11:00 AM PDT


def rows():
    return list(csv.DictReader(open(FIX, encoding="utf-8")))


class SfmtaSource(unittest.TestCase):
    def setUp(self):
        self.features, self.meta = build_features(rows(), NOW)
        self.s = self.meta["stats"]

    def test_expected_survivors(self):
        # Oct 22 market is 6 days out -> inside the 7-day lookahead.
        names = sorted(f["properties"]["detour_note"].split(" — ")[0] for f in self.features)
        self.assertEqual(names, ["Mission Community Market 2026", "PG&E",
                                 "Sunday Streets Excelsior", "Sunday Streets Excelsior"])

    def test_filters(self):
        self.assertEqual(self.s["dropped_not_permitted"], 2)       # Pending Payment + Application In Review
        self.assertEqual(self.s["flagged_roadway_shared_spaces"], 1)  # decision 2: not shown
        self.assertEqual(self.s["dropped_past"], 2)                # Van Ness permit + Oct 15 market
        self.assertEqual(self.s.get("dropped_beyond_lookahead", 0), 0)
        feats, meta = build_features(rows(), NOW, lookahead_days=3)   # shrink window
        self.assertEqual(meta["stats"]["dropped_beyond_lookahead"], 1)  # Oct 22 market now out

    def test_status_mapping_and_temporal(self):
        by = {f["properties"]["detour_note"].split(" — ")[0]: f["properties"] for f in self.features}
        self.assertEqual(by["Sunday Streets Excelsior"]["status"], "closed")
        self.assertEqual(by["PG&E"]["status"], "reduced")          # some lanes closed != blocking
        self.assertEqual(by["Sunday Streets Excelsior"]["temporal_status"], "FUTURE")

    def test_local_dates_use_sf_timezone(self):
        p = next(f for f in self.features if "Sunday" in f["properties"]["detour_note"])["properties"]
        self.assertEqual(p["start_date"], "2026-10-18")

    def test_active_now_detected(self):
        now = datetime(2026, 10, 18, 20, 0, tzinfo=timezone.utc)   # during Sunday Streets
        feats, _ = build_features(rows(), now)
        cur = [f for f in feats if f["properties"]["temporal_status"] == "CURRENT"]
        self.assertEqual(len(cur), 2)   # the two Mission St segments

    def test_data_as_of(self):
        self.assertEqual(self.meta["data_as_of"], "2026-10-15T00:03:28+00:00")

    def test_wkt(self):
        g = _wkt_to_geometry("LINESTRING (-122.1 37.1, -122.2 37.2)")
        self.assertEqual(g["coordinates"], [[-122.1, 37.1], [-122.2, 37.2]])
        self.assertEqual(_wkt_to_geometry("MULTILINESTRING ((1 2, 3 4), (5 6, 7 8))")["type"], "MultiLineString")
        self.assertIsNone(_wkt_to_geometry("POINT (1 2)"))

    def test_small_or_bad_file_is_rejected(self):
        with self.assertRaises(ValueError):
            parse_rows(FIX.read_text(encoding="utf-8"))            # only 9 rows -> refuse
        with self.assertRaises(ValueError):
            parse_rows("a,b\n1,2\n")                               # missing columns


if __name__ == "__main__":
    unittest.main()
