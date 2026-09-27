"""
City of Calgary Pathway Closures source.

Confirmed live endpoint — LINE geometry (esriGeometryPolyline), one
line per closed pathway segment, which is what you actually want for
merging against the OSM network:
  https://services1.arcgis.com/AVP60cs0Q9PEA8rH/ArcGIS/rest/services/Current_Pathway_Closures/FeatureServer/0

Real fields on this layer (from the service's own schema):
  NAME, CLOSURE_DETOUR, PURPOSE, STATUS, START_DATE, END_DATE,
  PUBLIC_VIEW, CREATED_DT, MODIFIED_DT, GLOBALID

IMPORTANT — verify before trusting this in production:
  Esri date fields come back as Unix epoch milliseconds, not strings —
  handled below. But the actual STRING VALUES inside STATUS and
  CLOSURE_DETOUR (e.g. is it "Active"/"Closed"? "Closure"/"Detour"?)
  haven't been confirmed against real data yet. Run this file directly
  once and print a few raw records before trusting the status mapping.
"""

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from schema import make_feature

CLOSURES_ENDPOINT = (
    "https://services1.arcgis.com/AVP60cs0Q9PEA8rH/ArcGIS/rest/services/"
    "Current_Pathway_Closures/FeatureServer/0/query"
)


def _epoch_ms_to_iso(value) -> str | None:
    """Esri date fields are Unix epoch milliseconds. Convert to
    YYYY-MM-DD, or None if missing/unparseable."""
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(value / 1000, tz=timezone.utc).date().isoformat()
    except (ValueError, TypeError, OSError):
        return None


def _map_status(raw_status: str | None, closure_detour: str | None) -> str:
    """Map Calgary's STATUS/CLOSURE_DETOUR values to our schema's
    open/closed/detour/reduced. VERIFY the actual string values once
    you've seen real data — this is a best guess pending that check.
    """
    text = f"{raw_status or ''} {closure_detour or ''}".lower()
    if "detour" in text:
        return "detour"
    if "reduc" in text:
        return "reduced"
    if "clos" in text or "active" in text:
        return "closed"
    return "closed"  # conservative default: if it's in this dataset at all, treat as closed


def fetch_closures() -> list[dict]:
    try:
        import requests

        resp = requests.get(
            CLOSURES_ENDPOINT,
            params={"where": "1=1", "outFields": "*", "f": "geojson"},
            timeout=30,
        )
        resp.raise_for_status()
        raw = resp.json()
    except Exception as e:
        print(f"[calgary_closures_source] FAILED to fetch: {e}")
        return []

    normalized = []
    for raw_feature in raw.get("features", []):
        try:
            props = raw_feature.get("properties", {})
            note_parts = [p for p in (props.get("NAME"), props.get("PURPOSE")) if p]
            normalized.append(
                make_feature(
                    geometry=raw_feature["geometry"],
                    source="calgary-open-data",
                    status=_map_status(props.get("STATUS"), props.get("CLOSURE_DETOUR")),
                    start_date=_epoch_ms_to_iso(props.get("START_DATE")),
                    end_date=_epoch_ms_to_iso(props.get("END_DATE")),
                    detour_note=" — ".join(note_parts) if note_parts else None,
                )
            )
        except (KeyError, ValueError):
            continue

    print(f"[calgary_closures_source] Loaded {len(normalized)} closures")
    return normalized


if __name__ == "__main__":
    # Run this directly first to eyeball 2-3 RAW records before trusting
    # the mapping above.
    import requests

    resp = requests.get(
        CLOSURES_ENDPOINT,
        params={"where": "1=1", "outFields": "*", "f": "geojson", "resultRecordCount": 3},
        timeout=30,
    )
    print("RAW sample records:")
    for f in resp.json().get("features", []):
        print(" ", f["properties"])

    features = fetch_closures()
    print(f"\nNormalized result: {len(features)} features")
