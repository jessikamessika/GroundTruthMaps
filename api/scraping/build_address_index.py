"""
Builds the static Calgary address search files.

Downloads the City of Calgary Parcel Address dataset (9zvu-p8uz) and writes
small JSON shards to app/public/data/addr/, plus a manifest.json. The folder
is built in CI and never committed.

Shard rule (the client must apply the same one):
  Drop every character outside A-Z and 0-9 from the uppercase street name.
  If the result starts with a digit, the whole result is the shard key
  ("19", "1A"). Otherwise the first 3 characters are ("MAHOGANY" -> "MAH").
  The file is s_<KEY>.json; the prefix keeps keys like CON and AUX from
  being reserved filenames on Windows.

Shard format, sorted by house number:
  { "<STREET_NAME>|<TYPE>|<QUAD>": [[house_number, "alpha or empty", [[lng, lat], ...]], ...] }

Each address appears once. Where the City lists several parcels under one
address, they are clustered: parcels within 100 m of each other, directly or
through a chain of other parcels, form one cluster. Each cluster becomes one
point, the parcel closest to the cluster's middle. An address keeps at most 3
points, largest clusters first, so nearly every address has exactly one.
Rows with no street name, type, quadrant or coordinates can't be searched and
are left out.

Exit codes:
  0  success. The output folder was replaced.
  1  download or build failed, or too few rows. Existing output was left
     UNTOUCHED and nothing was written.

Run from anywhere:
    python3 api/scraping/build_address_index.py
    python3 api/scraping/build_address_index.py --verify   # check the built files
    python3 api/scraping/build_address_index.py --multipoint-csv PATH   # also list multi-point addresses
"""

import argparse
import csv
import gzip
import itertools
import json
import math
import re
import shutil
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

DATASET_ID = "9zvu-p8uz"
RESOURCE_URL = f"https://data.calgary.ca/resource/{DATASET_ID}.json"
METADATA_URL = f"https://data.calgary.ca/api/views/{DATASET_ID}.json"
SELECT_FIELDS = "house_number,house_alpha,street_name,street_type,street_quad,longitude,latitude"
HEADERS = {"User-Agent": "GroundTruthMaps-address-index", "Accept": "application/json"}

PAGE_SIZE = 50_000
PAGE_PAUSE_S = 1.0
TIMEOUT_S = 180
MIN_ROWS = 400_000
COORD_DECIMALS = 5
COS_CALGARY_LAT = math.cos(math.radians(51.05))  # scales longitude when comparing distances
METRES_PER_DEGREE = 111_320
CLUSTER_RADIUS_M = 100
MAX_POINTS_PER_ADDRESS = 3

DATA_DIR = Path(__file__).resolve().parents[2] / "app" / "public" / "data"
OUTPUT_DIR = DATA_DIR / "addr"

SHARD_RULE = (
    "Uppercase the street name and drop every character outside A-Z and 0-9. "
    "If the result starts with a digit, the whole result is the shard key; "
    "otherwise its first 3 characters are. File name: s_<KEY>.json."
)
ATTRIBUTION = "Address data: City of Calgary, Open Government Licence – City of Calgary"

EXIT_OK = 0
EXIT_FAILED = 1


def _get_json(url: str):
    """GET and parse JSON. Raises on any network, HTTP or JSON error."""
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
        return json.load(response)


def _query_url(**params) -> str:
    return RESOURCE_URL + "?" + urllib.parse.urlencode({f"${k}": v for k, v in params.items()})


def fetch_rows() -> list[dict]:
    """Download every row, one page at a time.

    Raises if a page fails or the row total doesn't match the count the API
    reported, so a truncated download can't pass as a complete one.
    """
    expected = int(_get_json(_query_url(select="count(*) as n"))[0]["n"])
    rows: list[dict] = []
    offset = 0
    while True:
        page = _get_json(_query_url(select=SELECT_FIELDS, order=":id", limit=PAGE_SIZE, offset=offset))
        if not isinstance(page, list):
            raise ValueError(f"Unexpected reply at offset {offset}")
        rows.extend(page)
        print(f"[build_address_index] Fetched {len(rows)} of {expected} rows")
        if len(page) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
        time.sleep(PAGE_PAUSE_S)
    if len(rows) != expected:
        raise ValueError(f"Got {len(rows)} rows but the API reported {expected}")
    return rows


def fetch_street_types() -> dict[str, str]:
    """The official street-type codes, read from the STREET_TYPE column's
    description in the dataset metadata."""
    columns = _get_json(METADATA_URL)["columns"]
    description = next(c["description"] for c in columns if c["fieldName"] == "street_type")
    types = dict(re.findall(r"\b([A-Z]{2})\s+([A-Za-z]+)", description.split(":", 1)[1]))
    if "AL" not in types or "WY" not in types:
        raise ValueError("Street-type list not found in dataset metadata")
    return dict(sorted(types.items()))


def shard_key(street_name: str) -> str:
    """See SHARD_RULE. Returns "" if the name has no usable characters."""
    cleaned = re.sub(r"[^A-Z0-9]", "", street_name.upper())
    return cleaned if cleaned[:1].isdigit() else cleaned[:3]


def _text(row: dict, field: str) -> str:
    return (row.get(field) or "").strip().upper()


def _representative(points: list[tuple[float, float]]) -> tuple[float, float]:
    """The real point closest to the middle of the group. Ties break on the
    coordinates, so the choice doesn't depend on download order."""
    mid_lng = sum(p[0] for p in points) / len(points)
    mid_lat = sum(p[1] for p in points) / len(points)

    def rank(p):
        return (((p[0] - mid_lng) * COS_CALGARY_LAT) ** 2 + (p[1] - mid_lat) ** 2, p)

    return min(points, key=rank)


def _distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot((a[0] - b[0]) * COS_CALGARY_LAT, a[1] - b[1]) * METRES_PER_DEGREE


def _clusters(points: list[tuple[float, float]]) -> list[list[tuple[float, float]]]:
    """Single-linkage clusters: walk outward from each point through every
    parcel within CLUSTER_RADIUS_M."""
    remaining = set(range(len(points)))
    clusters = []
    while remaining:
        stack = [remaining.pop()]
        members = []
        while stack:
            current = points[stack.pop()]
            members.append(current)
            near = {i for i in remaining if _distance_m(current, points[i]) <= CLUSTER_RADIUS_M}
            remaining -= near
            stack.extend(near)
        clusters.append(members)
    return clusters


def _address_points(points: list[tuple[float, float]]) -> tuple[list[tuple[float, float]], int]:
    """Returns (points to keep, largest cluster first; total cluster count)."""
    clusters = _clusters(points)
    ranked = sorted(((-len(c), _representative(c)) for c in clusters))
    return [point for _, point in ranked[:MAX_POINTS_PER_ADDRESS]], len(clusters)


def build_shards(rows: list[dict]) -> tuple[dict[str, dict], dict[str, int], list[tuple[str, int, int]]]:
    """Returns ({shard key: shard contents}, manifest counts, multi-point
    addresses as (address, cluster count, largest spread in m), widest first).

    Raises on a malformed house number or coordinate: that means the feed
    changed, and a partial index is worse than last week's.
    """
    streets: dict[str, dict] = defaultdict(lambda: defaultdict(list))
    skipped = 0
    for row in rows:
        name, street_type, quad = _text(row, "street_name"), _text(row, "street_type"), _text(row, "street_quad")
        lng, lat = row.get("longitude"), row.get("latitude")
        house = row.get("house_number")
        if not (name and shard_key(name) and street_type and quad and lng and lat and house):
            skipped += 1
            continue
        address = (int(float(house)), _text(row, "house_alpha"))
        streets[f"{name}|{street_type}|{quad}"][address].append((float(lng), float(lat)))

    shards: dict[str, dict] = defaultdict(dict)
    written = written_points = merged = truncated = 0
    multipoint: list[tuple[str, int, int]] = []
    for street, addresses in streets.items():
        entries = []
        for (number, alpha), points in addresses.items():
            kept, cluster_count = _address_points(points)
            entries.append([number, alpha, [[round(lng, COORD_DECIMALS), round(lat, COORD_DECIMALS)] for lng, lat in kept]])
            written_points += len(kept)
            if cluster_count > 1:
                spread = max(_distance_m(a, b) for a, b in itertools.combinations(points, 2))
                multipoint.append((f"{number}{alpha} {street.replace('|', ' ')}", cluster_count, round(spread)))
                truncated += cluster_count > MAX_POINTS_PER_ADDRESS
            elif len(points) > 1:
                merged += 1
        entries.sort()
        written += len(entries)
        shards[shard_key(street.split("|", 1)[0])][street] = entries

    multipoint.sort(key=lambda m: (-m[2], m[0]))
    print(
        f"[build_address_index] {len(rows)} source rows: {skipped} without a street or "
        f"coordinates, {written} addresses written as {written_points} points "
        f"({merged} merged, {len(multipoint)} multi-point, {truncated} truncated)"
    )
    counts = {
        "written_rows": written,
        "merged_addresses": merged,
        "multi_point_addresses": len(multipoint),
        "truncated_addresses": truncated,
    }
    return shards, counts, multipoint


def _dump(data) -> bytes:
    return json.dumps(data, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode("utf-8")


def write_output(shards: dict[str, dict], manifest: dict) -> None:
    """Write to a temp folder beside the output, then swap it in."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix=".addr-", dir=DATA_DIR))
    previous = DATA_DIR / f"{temp_dir.name}-previous"
    try:
        temp_dir.chmod(0o755)  # mkdtemp is private by default; the site must be able to read it
        for key, shard in shards.items():
            (temp_dir / f"s_{key}.json").write_bytes(_dump(shard))
        (temp_dir / "manifest.json").write_bytes(_dump(manifest))

        had_output = OUTPUT_DIR.exists()
        if had_output:
            OUTPUT_DIR.rename(previous)
        try:
            temp_dir.rename(OUTPUT_DIR)
        except OSError:
            if had_output:
                previous.rename(OUTPUT_DIR)
            raise
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
        shutil.rmtree(previous, ignore_errors=True)


def write_multipoint_csv(path: Path, multipoint: list[tuple[str, int, int]]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["address", "cluster_count", "largest_spread_m"])
        writer.writerows(multipoint)


def build(multipoint_csv: Path | None = None) -> int:
    started = time.monotonic()
    try:
        rows = fetch_rows()
        if len(rows) < MIN_ROWS:
            raise ValueError(f"Only {len(rows)} rows; expected at least {MIN_ROWS}")
        street_types = fetch_street_types()
        shards, counts, multipoint = build_shards(rows)
        if counts["written_rows"] < MIN_ROWS:
            raise ValueError(f"Only {counts['written_rows']} rows to write; expected at least {MIN_ROWS}")
        manifest = {
            "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source_rows": len(rows),
            **counts,
            "shard_rule": SHARD_RULE,
            "shards": sorted(shards),
            "street_types": street_types,
            "attribution": ATTRIBUTION,
        }
        write_output(shards, manifest)
    except Exception as e:
        print(f"[build_address_index] Failed: {e}", file=sys.stderr)
        print("[build_address_index] Nothing written. Existing files left as they were.", file=sys.stderr)
        return EXIT_FAILED

    print(f"[build_address_index] Wrote {len(shards)} shards in {time.monotonic() - started:.1f}s")
    if multipoint_csv:
        try:
            write_multipoint_csv(multipoint_csv, multipoint)
        except OSError as e:
            print(f"[build_address_index] Index written, but the CSV failed: {e}", file=sys.stderr)
            return EXIT_FAILED
    return EXIT_OK


def lookup(number: int, name: str, street_type: str, quad: str | None = None, out_dir: Path = OUTPUT_DIR):
    """Find a house number in the built files. With no quad, searches all
    four. Returns [(street key, entry), ...]."""
    shard = json.loads((out_dir / f"s_{shard_key(name)}.json").read_text(encoding="utf-8"))
    quads = [quad] if quad else ["NE", "NW", "SE", "SW"]
    matches = []
    for q in quads:
        street = f"{name}|{street_type}|{q}"
        matches += [(street, entry) for entry in shard.get(street, []) if entry[0] == number]
    return matches


def verify(out_dir: Path = OUTPUT_DIR) -> int:
    """Print the agreed lookups and the size summary for the built files."""
    cases = [
        (1407, "19", "ST", "NW"),
        (3716, "36", "AV", "SW"),
        (11, "GALWAY", "CR", "SW"),
        (228, "TEMPLEWOOD", "RD", "NE"),
        (407, "9", "AV", "SE"),
        (101, "9", "AV", None),
        (420, "2", "ST", None),
    ]
    for number, name, street_type, quad in cases:
        print(f"{number} {name} {street_type} {quad or '(any quad)'}: {lookup(number, name, street_type, quad, out_dir) or 'NOT FOUND'}")

    shard = json.loads((out_dir / f"s_{shard_key('2')}.json").read_text(encoding="utf-8"))
    print("2 ST house numbers from 380 to 460, by quad:")
    for q in ["NE", "NW", "SE", "SW"]:
        near = [e[0] for e in shard.get(f"2|ST|{q}", []) if 380 <= e[0] <= 460]
        print(f"  {q}: {near or 'none'}")

    sizes = sorted(
        ((len(raw), len(gzip.compress(raw, mtime=0)), path.name)
         for path in out_dir.glob("s_*.json") for raw in [path.read_bytes()]),
        key=lambda s: s[1],
    )
    manifest_path = out_dir / "manifest.json"
    print(f"Shards: {len(sizes)}")
    print(f"Total: {sum(s[0] for s in sizes) + manifest_path.stat().st_size} raw, "
          f"{sum(s[1] for s in sizes) + len(gzip.compress(manifest_path.read_bytes(), mtime=0))} gzipped (with manifest)")
    print(f"Median shard gzipped: {sizes[len(sizes) // 2][1]}; 90th percentile: {sizes[len(sizes) * 9 // 10][1]}")
    print(f"Largest shard: {sizes[-1][2]}, {sizes[-1][0]} raw, {sizes[-1][1]} gzipped")
    return EXIT_OK


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build the Calgary address search files.")
    parser.add_argument("--verify", action="store_true", help="check the built files instead of building")
    parser.add_argument("--multipoint-csv", type=Path, help="also write the multi-point addresses to this CSV")
    args = parser.parse_args()
    sys.exit(verify() if args.verify else build(args.multipoint_csv))
