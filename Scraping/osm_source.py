"""
OSM source.
Reads the already-extracted, already-fixed Calgary cycling GeoJSON
(the output of Phase 1 — osmium extract + the polygon-to-line fix)
and normalizes every feature into the shared Phase-0 schema.

OSM gives you the NETWORK, not closures — so every feature from this
source starts as status="open". Closures get merged in later from the
Calgary open data source.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from schema import make_feature


def _facility_type_from_tags(props: dict) -> str:
    """Map raw OSM tags to one of our facility_type buckets."""
    highway = props.get("highway")
    if highway == "cycleway":
        return "cycle_track"
    if "cycleway" in props:  # e.g. cycleway=lane on a road way
        return "bike_lane"
    if highway in ("path", "footway"):
        return "pathway"
    if highway == "track":
        return "trail"
    return "shared_use"


def _bicycle_access_from_tags(props: dict) -> str:
    value = props.get("bicycle")
    if value in ("designated", "yes", "permissive"):
        return value
    return "unknown"


def load_osm_features(geojson_path: str) -> list[dict]:
    """Load and normalize OSM features. Returns [] and prints a warning
    on failure rather than raising, so one bad file doesn't kill the
    whole pipeline run.
    """
    try:
        with open(geojson_path, "r") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"[osm_source] FAILED to load {geojson_path}: {e}")
        return []

    normalized = []
    skipped = 0
    for raw_feature in data.get("features", []):
        try:
            props = raw_feature.get("properties", {})
            normalized.append(
                make_feature(
                    geometry=raw_feature["geometry"],
                    source="osm",
                    facility_type=_facility_type_from_tags(props),
                    bicycle_access=_bicycle_access_from_tags(props),
                    status="open",
                    extra_properties={"osm_name": props.get("name")},
                )
            )
        except (KeyError, ValueError) as e:
            skipped += 1
            continue  # one bad feature shouldn't stop the whole load

    print(f"[osm_source] Loaded {len(normalized)} features, skipped {skipped}")
    return normalized


if __name__ == "__main__":
    # Quick manual test: run this file directly to sanity-check the source
    # in isolation, without needing the full merge pipeline.
    features = load_osm_features(
        "/mnt/user-data/uploads/calgary_cycling_permissive_fixed.geojson"
    )
    print(f"First feature sample: {features[0] if features else 'none'}")
