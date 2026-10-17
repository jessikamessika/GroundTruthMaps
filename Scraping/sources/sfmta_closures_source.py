"""
SFMTA Temporary Street Closures source (DataSF dataset 8x25-yybr).

Why the CSV export: it is the format whose real rows were inspected on
2026-10-16 (columns, date text format, WKT geometry, UTC fields). The SODA JSON
API would need its own verification of date/geometry typing, so it is not used.

Verified against real rows:
  - *_utc fields are true UTC (local PDT/PST + 7/8h). We use them, not *_dt.
  - Date text format is "%Y/%m/%d %I:%M:%S %p".
  - Geometry column `shape` is WKT LINESTRING ("LINESTRING (lon lat, lon lat)").
  - One row per occurrence per street segment (e.g. Gold St has one row per
    night), so rows must be collapsed into active-now / next-N-days.
  - `status` includes non-permitted values -> filter status == Permitted.

Decision 2 (cyclist scope): only "Special Traffic Permit" (construction) and
"Special Event" rows are emitted. "Roadway Shared Spaces" rows are counted and
logged but NOT shown as closures (they are flagged for later categorization).

Contract for fetch_closures():
  - Returns (features, meta). Returns an empty list ONLY if the fetch + parse
    succeeded and nothing is active/upcoming.
  - RAISES on network/HTTP/parse failure, missing columns, or a suspiciously
    small file. Callers must not overwrite published data on exceptions.

Run directly to print a few raw rows and the filter summary:
    python3 Scraping/sources/sfmta_closures_source.py
"""

import csv
import io
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from schema import make_feature

CSV_URL = "https://data.sfgov.org/api/views/8x25-yybr/rows.csv?accessType=DOWNLOAD"
SF_TZ = ZoneInfo("America/Los_Angeles")
DATE_FMT = "%Y/%m/%d %I:%M:%S %p"

REQUIRED_COLUMNS = {
    "case_num", "case_name", "type", "status", "loc_desc", "veh_imp", "info",
    "start_utc", "end_utc", "shape", "data_as_of",
}
SHOWN_TYPES = {"Special Traffic Permit", "Special Event"}   # decision 2
MIN_PLAUSIBLE_ROWS = 100       # file had 4,279 rows on 2026-10-08; far less = bad download
LOOKAHEAD_DAYS = 7


def _parse_utc(text: str) -> datetime | None:
    try:
        return datetime.strptime(text.strip(), DATE_FMT).replace(tzinfo=timezone.utc)
    except (ValueError, AttributeError):
        return None


_NUM_PAIR = re.compile(r"(-?\d+\.?\d*)\s+(-?\d+\.?\d*)")


def _wkt_to_geometry(wkt: str) -> dict | None:
    """Parse LINESTRING / MULTILINESTRING WKT into GeoJSON. None if unparseable."""
    if not wkt:
        return None
    s = wkt.strip().upper()
    if s.startswith("MULTILINESTRING"):
        parts = re.findall(r"\(([^()]+)\)", wkt)
        lines = [[[float(x), float(y)] for x, y in _NUM_PAIR.findall(p)] for p in parts]
        lines = [l for l in lines if len(l) >= 2]
        return {"type": "MultiLineString", "coordinates": lines} if lines else None
    if s.startswith("LINESTRING"):
        coords = [[float(x), float(y)] for x, y in _NUM_PAIR.findall(wkt)]
        return {"type": "LineString", "coordinates": coords} if len(coords) >= 2 else None
    return None


def _status_for(veh_imp: str) -> str | None:
    """Map SFMTA vehicle impact to our schema status. These describe VEHICLES,
    not bikes; 'some lanes closed' is treated as 'reduced' (not blocking)."""
    v = (veh_imp or "").strip().lower()
    if v == "all-lanes-closed":
        return "closed"
    if v == "some-lanes-closed":
        return "reduced"
    return None   # all-lanes-open / unknown: not a closure


def parse_rows(csv_text: str) -> list[dict]:
    reader = csv.DictReader(io.StringIO(csv_text))
    missing = REQUIRED_COLUMNS - set(reader.fieldnames or [])
    if missing:
        raise ValueError(f"SFMTA CSV is missing expected columns: {sorted(missing)}")
    rows = list(reader)
    if len(rows) < MIN_PLAUSIBLE_ROWS:
        raise ValueError(f"SFMTA CSV has only {len(rows)} rows; refusing to trust it")
    return rows


def build_features(rows: list[dict], now: datetime, lookahead_days: int = LOOKAHEAD_DAYS):
    """Filter + collapse rows into one feature per (case_num, street segment).

    Returns (features, meta). `now` is injected so this is testable.
    """
    horizon = now + timedelta(days=lookahead_days)
    stats = defaultdict(int)
    groups: dict[tuple, list[dict]] = defaultdict(list)

    for r in rows:
        stats["rows"] += 1
        if (r.get("status") or "").strip() != "Permitted":
            stats["dropped_not_permitted"] += 1
            continue
        rtype = (r.get("type") or "").strip()
        if rtype not in SHOWN_TYPES:
            stats["flagged_" + rtype.lower().replace(" ", "_")] += 1   # e.g. shared spaces
            continue
        status = _status_for(r.get("veh_imp"))
        if status is None:
            stats["dropped_not_a_closure"] += 1
            continue
        start, end = _parse_utc(r.get("start_utc")), _parse_utc(r.get("end_utc"))
        geom = _wkt_to_geometry(r.get("shape"))
        if not (start and end and geom) or end <= start:
            stats["dropped_unparseable"] += 1
            continue
        if end <= now:
            stats["dropped_past"] += 1
            continue
        if start > horizon:
            stats["dropped_beyond_lookahead"] += 1
            continue
        r["_start"], r["_end"], r["_geom"], r["_status"] = start, end, geom, status
        groups[(r["case_num"], r.get("cnn") or r.get("loc_desc"))].append(r)

    features = []
    for occ in groups.values():
        occ.sort(key=lambda r: r["_start"])
        # Active now beats upcoming; otherwise the soonest upcoming window.
        active = [r for r in occ if r["_start"] <= now < r["_end"]]
        primary = active[0] if active else occ[0]
        temporal = "CURRENT" if active else "FUTURE"
        text = (primary.get("loc_desc") or "").strip()
        name = (primary.get("case_name") or "Closure").strip()
        features.append(make_feature(
            geometry=primary["_geom"],
            source="sfmta-temporary-street-closures",
            status=primary["_status"],
            start_date=primary["_start"].astimezone(SF_TZ).date().isoformat(),
            end_date=primary["_end"].astimezone(SF_TZ).date().isoformat(),
            # "NAME — text" matches the Calgary note format, so web/routing.js
            # closureInfo() splits it correctly with no changes.
            detour_note=f"{name} — {text}" if text else name,
            extra_properties={
                "calgary_temporal_status": temporal,   # existing web code keys on this name
                "temporal_status": temporal,           # generic name for the later rename
                "closure_type": primary["type"],
                "window_start_utc": primary["_start"].isoformat(),
                "window_end_utc": primary["_end"].isoformat(),
                "windows_in_lookahead": len(occ),
            },
        ))

    stats["features_out"] = len(features)
    as_of = [d for d in (_parse_utc(r.get("data_as_of") or "") for r in rows) if d]
    meta = {"stats": dict(stats), "data_as_of": max(as_of).isoformat() if as_of else None}
    return features, meta


def fetch_closures(now: datetime | None = None):
    """Download the CSV and return (features, meta). Raises on any failure."""
    import requests

    resp = requests.get(CSV_URL, timeout=60)
    resp.raise_for_status()
    rows = parse_rows(resp.content.decode("utf-8-sig"))
    features, meta = build_features(rows, now or datetime.now(timezone.utc))
    print(f"[sfmta_closures_source] {meta['stats']}")
    return features, meta


if __name__ == "__main__":
    import requests

    raw = requests.get(CSV_URL, timeout=60)
    raw.raise_for_status()
    sample = list(csv.DictReader(io.StringIO(raw.text)))[:3]
    print("RAW sample rows:")
    for r in sample:
        print(" ", {k: r[k] for k in ("case_name", "type", "status", "start_utc", "end_utc", "veh_imp")})
    feats, meta = fetch_closures()
    print(f"\n{len(feats)} features; data_as_of={meta['data_as_of']}")
