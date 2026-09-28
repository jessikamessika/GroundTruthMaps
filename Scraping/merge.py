"""
Merge pipeline.
Calls every source independently, catching failures from each one so
that a broken source degrades the output rather than crashing the run.
This is the file you point a cron job / GitHub Action at.
"""

import json

from schema import make_feature_collection
from sources.osm_source import load_osm_features
from sources.calgary_closures_source import fetch_closures

OSM_INPUT_PATH = "/mnt/c/Users/perse/Desktop/escritorio_longterm/" \
"escribir, drafts/AA 1 GT/Portfolio/Map Calgary/GroundTruthMaps/" \
"Scraping/Web_Data/calgary_cycling_permissive_fixed.geojson"
OUTPUT_PATH = "combined.geojson"


def run():
    all_features = []

    # Each source is wrapped independently — a crash in one doesn't
    # take down the others.
    try:
        all_features.extend(load_osm_features(OSM_INPUT_PATH))
    except Exception as e:
        print(f"[merge] OSM source crashed unexpectedly: {e}")

    try:
        all_features.extend(fetch_closures())
    except Exception as e:
        print(f"[merge] Calgary closures source crashed unexpectedly: {e}")

    collection = make_feature_collection(all_features)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(collection, f)

    print(f"[merge] Wrote {len(all_features)} total features to {OUTPUT_PATH}")


if __name__ == "__main__":
    run()
