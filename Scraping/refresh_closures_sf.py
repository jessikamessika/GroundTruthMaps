"""
SF closures refresh (fail-closed, mirrors refresh_closures.py).

Writes data/sf/closures.geojson. Exit codes:
  0  success (including a genuine "nothing active or upcoming")
  1  fetch/parse failed; the existing file is left UNTOUCHED.

    python3 Scraping/refresh_closures_sf.py
"""

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cities import CITIES
from schema import make_feature_collection
from sources.sfmta_closures_source import fetch_closures
from build_layers import _slim, write_layer

SF = CITIES["sf"]
OUT_PATH = Path(__file__).resolve().parent.parent / SF["data_dir"] / "closures.geojson"
SF_KEEP = (
    "status", "calgary_temporal_status", "temporal_status", "start_date", "end_date",
    "detour_note", "closure_type", "window_start_utc", "window_end_utc", "windows_in_lookahead",
)


def main() -> int:
    try:
        features, meta = fetch_closures()
    except Exception as e:
        print(f"[refresh_closures_sf] Fetch failed: {e}", file=sys.stderr)
        print(f"[refresh_closures_sf] Leaving {OUT_PATH} untouched.", file=sys.stderr)
        return 1

    layer = make_feature_collection([_slim(f, SF_KEEP) for f in features])
    layer["generated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    layer["source_data_as_of"] = meta["data_as_of"]   # how old SFMTA's own export is
    layer["scope_note"] = SF["banner"]
    write_layer(OUT_PATH, layer)
    return 0


if __name__ == "__main__":
    sys.exit(main())
