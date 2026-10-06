"""
Merge pipeline.
Calls every source independently (a broken source degrades the output
instead of crashing the run), drops expired closures, and writes:

  ../data/combined.geojson   full merged data, for inspection (61 MB+ —
                             add it to .gitignore, don't commit it)
  ../data/network.geojson    slim OSM lines for the web map
  ../data/closures.geojson   current + future closures for the web map
"""

import json
from datetime import date
from pathlib import Path

from schema import make_feature_collection
from sources.osm_source import load_osm_features
from sources.calgary_closures_source import fetch_closures

OSM_INPUT_PATH = Path(__file__).resolve().parent / "inputs/calgary_cycling_permissive_fixed.geojson"
"/mnt/user-data/uploads/"  # keep YOUR path here
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

COORD_PRECISION = 5  # decimal places, ~1 m — plenty for a city map, much smaller files

NETWORK_KEEP = ("facility_type", "bicycle_access", "osm_name")
CLOSURE_KEEP = ("status", "calgary_temporal_status", "start_date", "end_date", "detour_note")


def drop_past_closures(closures: list[dict]) -> list[dict]:
    """Remove closures the City has marked PAST. CURRENT and FUTURE stay;
    the map styles FUTURE ones in a muted way."""
    kept = [f for f in closures if f["properties"].get("calgary_temporal_status") != "PAST"]
    print(f"[merge] Dropped {len(closures) - len(kept)} PAST closure(s), kept {len(kept)}")
    return kept


def _round_coords(coords):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], COORD_PRECISION), round(coords[1], COORD_PRECISION)]
    return [_round_coords(c) for c in coords]


def _slim(feature: dict, keep: tuple) -> dict:
    props = {k: feature["properties"][k] for k in keep if feature["properties"].get(k) is not None}
    geom = feature["geometry"]
    return {
        "type": "Feature",
        "properties": props,
        "geometry": {"type": geom["type"], "coordinates": _round_coords(geom["coordinates"])},
    }


def build_network_layer(osm_features: list[dict]) -> dict:
    """OSM lines only (tagged points stay in combined.geojson, not on the web map)."""
    lines = [_slim(f, NETWORK_KEEP) for f in osm_features if f["geometry"]["type"] == "LineString"]
    return make_feature_collection(lines)


def build_closures_layer(closures: list[dict]) -> dict:
    layer = make_feature_collection([_slim(f, CLOSURE_KEEP) for f in closures])
    layer["generated"] = date.today().isoformat()  # GeoJSON allows extra top-level members
    return layer


def _write(path: Path, obj: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    print(f"[merge] Wrote {path} ({path.stat().st_size / 1e6:.1f} MB)")


def run():
    osm, closures = [], []

    try:
        osm = load_osm_features(str(OSM_INPUT_PATH))
    except Exception as e:
        print(f"[merge] OSM source crashed unexpectedly: {e}")

    try:
        closures = drop_past_closures(fetch_closures())
    except Exception as e:
        print(f"[merge] Calgary closures source crashed unexpectedly: {e}")

    _write(DATA_DIR / "combined.geojson", make_feature_collection(osm + closures))
    _write(DATA_DIR / "network.geojson", build_network_layer(osm))
    _write(DATA_DIR / "closures.geojson", build_closures_layer(closures))


if __name__ == "__main__":
    run()
