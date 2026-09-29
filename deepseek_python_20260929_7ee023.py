#!/usr/bin/env python3
"""
doctor.py — preflight diagnostics for the Calgary Cycling Closures Map.

Run from anywhere (paths resolve relative to this file):

    python3 doctor.py
    python3 doctor.py --json      # machine-readable, for CI

Exits 0 if all error-severity checks pass, 1 otherwise.
Warning-severity checks are reported but do not fail the run.

Adding a new check:

    @check("XXX-000", "Human-readable description")
    def my_check():
        if broken:
            raise SomeSpecificError("...", hint="...")
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import platform
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Layout (all paths are relative to this file, so repo rename is safe)
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent
SCRAPING  = REPO_ROOT / "Scraping"
SOURCES   = SCRAPING / "sources"
DATA      = REPO_ROOT / "data"
WEB       = REPO_ROOT / "web"

# ---------------------------------------------------------------------------
# Error hierarchy — every failure is one of these, named on purpose.
# ---------------------------------------------------------------------------

class DoctorError(Exception):
    """Base class for every diagnostic failure."""
    severity = "error"  # "error" fails the run; "warning" does not.

    def __init__(self, message: str, *, hint: str | None = None,
                 severity: str | None = None):
        super().__init__(message)
        self.message = message
        self.hint = hint
        if severity is not None:
            self.severity = severity


class EnvironmentProblem(DoctorError):
    """Wrong OS, wrong Python, not inside WSL."""

class MissingFile(DoctorError):
    """A required file is not where the pipeline expects it."""

class SchemaViolation(DoctorError):
    """A feature's properties don't match the shared schema."""

class GeoJSONInvalid(DoctorError):
    """A .geojson file isn't parseable as a FeatureCollection."""

class GeometryAnomaly(DoctorError):
    """Coordinates or geometry types are wrong (e.g. polygons in a lines file)."""

class DataStale(DoctorError):
    """Output is valid but too old to be useful."""

class WebAssetProblem(DoctorError):
    """web/index.html is missing a reference or an attribution."""

class GitIgnoreProblem(DoctorError):
    """A generated file that should be ignored is not."""

# ---------------------------------------------------------------------------
# Check registry
# ---------------------------------------------------------------------------

CHECKS: list[tuple[str, str, Callable[[], None]]] = []


def check(code: str, name: str):
    def deco(fn: Callable[[], None]) -> Callable[[], None]:
        CHECKS.append((code, name, fn))
        return fn
    return deco


# ---------------------------------------------------------------------------
# Shared schema expectations (fallbacks; refined from Scraping/schema.py below)
# ---------------------------------------------------------------------------

DEFAULT_ALLOWED: dict[str, set[str]] = {
    "source":         {"osm", "calgary-open-data"},
    "facility_type":  {"cycle_track", "bike_lane", "pathway", "trail",
                       "shared_use", "unknown"},
    "bicycle_access": {"designated", "yes", "permissive", "unknown"},
    "status":         {"open", "closed", "detour", "reduced"},
}

# Keys every feature is expected to carry (per the project summary).
REQUIRED_PROPS = ("source", "facility_type", "bicycle_access", "status")

# Keys whose values are checked against an allowed set.
VALUE_CHECKED = ("source", "facility_type", "bicycle_access", "status")

# Optional ISO-8601 date fields, validated for parseability when present.
DATE_FIELDS = ("start_date", "end_date", "last_verified")

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

_GeoJSONCache: dict[Path, Any] = {}


def _load_geojson(path: Path) -> Any:
    if path in _GeoJSONCache:
        return _GeoJSONCache[path]
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        raise MissingFile(f"Cannot read {path.name}: {e}",
                          hint=f"Expected file at {path}")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise GeoJSONInvalid(
            f"{path.name} is not valid JSON: {e.msg} at line {e.lineno}, col {e.colno}",
            hint="Re-run the pipeline to regenerate it.",
        )
    _GeoJSONCache[path] = data
    return data


def _probe_allowed_from_schema() -> dict[str, set[str]]:
    """Try to import Scraping/schema.py and pull out its allowed-value sets."""
    schema_path = SCRAPING / "schema.py"
    if not schema_path.exists():
        return dict(DEFAULT_ALLOWED)

    spec = importlib.util.spec_from_file_location("_project_schema", schema_path)
    if spec is None or spec.loader is None:
        return dict(DEFAULT_ALLOWED)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception:
        # If schema.py doesn't import cleanly, the SCHEMA-001 check will
        # report that with detail. Fall back to defaults here.
        return dict(DEFAULT_ALLOWED)

    # Probe common constant names; if none match, keep the default.
    name_hints: dict[str, tuple[str, ...]] = {
        "source":         ("SOURCES", "ALLOWED_SOURCES", "SOURCE_VALUES"),
        "facility_type":  ("FACILITY_TYPES", "ALLOWED_FACILITY_TYPES",
                           "FACILITY_TYPE_VALUES"),
        "bicycle_access": ("BICYCLE_ACCESS", "ALLOWED_BICYCLE_ACCESS",
                           "BICYCLE_ACCESS_VALUES"),
        "status":         ("STATUSES", "ALLOWED_STATUSES", "STATUS_VALUES"),
    }
    out = dict(DEFAULT_ALLOWED)
    for field, names in name_hints.items():
        for n in names:
            v = getattr(mod, n, None)
            if isinstance(v, (set, frozenset, list, tuple)) and v:
                out[field] = set(v)
                break
    return out


# ---------------------------------------------------------------------------
# Environment checks
# ---------------------------------------------------------------------------

@check("ENV-001", "Running inside WSL/Linux (not Windows Python)")
def check_platform() -> None:
    system = platform.system()
    if system == "Windows":
        raise EnvironmentProblem(
            f"Running under Windows Python ({system}), not WSL.",
            hint="Open a WSL Ubuntu terminal and run `python3 doctor.py` there. "
                 "All Python/pip/osmium/git commands in this project must run "
                 "inside WSL, not PowerShell/cmd.",
        )
    if system == "Linux":
        try:
            proc = Path("/proc/version").read_text(encoding="utf-8").lower()
        except OSError:
            proc = ""
        if "microsoft" not in proc and "wsl" not in proc:
            raise EnvironmentProblem(
                "Linux detected, but /proc/version does not mention WSL.",
                severity="warning",
                hint="Fine if you're on a native Linux host; the WSL warning is "
                     "only relevant for the developer's original setup.",
            )


@check("ENV-002", "Python version is at least 3.9")
def check_python_version() -> None:
    if sys.version_info < (3, 9):
        raise EnvironmentProblem(
            f"Python {sys.version.split()[0]} is too old.",
            hint="Upgrade Python inside WSL (e.g. `sudo apt install python3.11`).",
        )


# ---------------------------------------------------------------------------
# File layout checks
# ---------------------------------------------------------------------------

REQUIRED_PIPELINE_FILES = (
    SCRAPING / "schema.py",
    SCRAPING / "merge.py",
    SOURCES / "__init__.py",
    SOURCES / "osm_source.py",
    SOURCES / "calgary_closures_source.py",
    WEB / "index.html",
)


@check("FILE-001", "Required pipeline source files present")
def check_required_files() -> None:
    missing = [p for p in REQUIRED_PIPELINE_FILES if not p.exists()]
    if missing:
        rel = ", ".join(str(p.relative_to(REPO_ROOT)) for p in missing)
        raise MissingFile(
            f"Missing {len(missing)} required file(s): {rel}",
            hint="The doctor script expects the layout described in the project "
                 "summary. If you renamed a folder, update REPO_ROOT/SCRAPING/etc. "
                 "at the top of doctor.py.",
        )


@check("FILE-002", "Data outputs exist (network.geojson, closures.geojson)")
def check_data_files() -> None:
    expected = (DATA / "network.geojson", DATA / "closures.geojson")
    missing = [p.name for p in expected if not p.exists()]
    if missing:
        raise MissingFile(
            f"Missing data output(s): {', '.join(missing)}",
            hint="Run `python3 Scraping/merge.py` to regenerate them.",
            severity="warning",
        )


@check("OSM-001", "OSM_INPUT_PATH points at an existing file")
def check_osm_input_path() -> None:
    src = SOURCES / "osm_source.py"
    if not src.exists():
        return  # FILE-001 already reported this.
    text = src.read_text(encoding="utf-8")
    m = re.search(r"^\s*OSM_INPUT_PATH\s*=\s*(.+?)\s*$", text, re.M)
    if not m:
        raise MissingFile(
            "OSM_INPUT_PATH is not defined at module level in osm_source.py.",
            hint="Define it as a literal string so it can be checked and "
                 "overridden per-machine.",
        )
    raw = m.group(1).strip()
    lit = re.match(r"""^[rRbBfF]*['"](.+?)['"]""", raw)
    if not lit:
        raise MissingFile(
            f"OSM_INPUT_PATH is not a literal string: {raw}",
            severity="warning",
            hint="If it's computed, doctor.py can't verify the file exists. "
                 "Make it a literal for checkability.",
        )
    p = Path(lit.group(1))
    if not p.is_absolute():
        p = REPO_ROOT / p
    if not p.exists():
        raise MissingFile(
            f"OSM_INPUT_PATH points at a missing file: {p}",
            hint="Download the Alberta extract from Geofabrik and update "
                 "OSM_INPUT_PATH in Scraping/sources/osm_source.py.",
        )


# ---------------------------------------------------------------------------
# Schema checks
# ---------------------------------------------------------------------------

@check("SCHEMA-001", "Scraping/schema.py imports cleanly")
def check_schema_import() -> None:
    path = SCRAPING / "schema.py"
    if not path.exists():
        return  # FILE-001
    spec = importlib.util.spec_from_file_location("_project_schema", path)
    if spec is None or spec.loader is None:
        raise SchemaViolation("Could not create an import spec for schema.py.")
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as e:
        raise SchemaViolation(
            f"schema.py raised on import: {type(e).__name__}: {e}",
            hint="schema.py should have no side effects at import time.",
        )
    if not hasattr(mod, "make_feature"):
        raise SchemaViolation(
            "schema.py does not define `make_feature`.",
            hint="make_feature() is the single writer for every feature.",
        )


def _check_feature_schema(fc: dict, path: Path, allowed: dict[str, set[str]]) -> None:
    if fc.get("type") != "FeatureCollection":
        raise GeoJSONInvalid(
            f"{path.name}: top-level `type` is {fc.get('type')!r}, "
            "expected 'FeatureCollection'.",
        )
    feats = fc.get("features")
    if not isinstance(feats, list):
        raise GeoJSONInvalid(f"{path.name}: `features` is not a list.")

    problems: list[str] = []
    for i, feat in enumerate(feats):
        if not isinstance(feat, dict):
            problems.append(f"feature {i}: not an object")
            continue
        if feat.get("type") != "Feature":
            problems.append(f"feature {i}: type={feat.get('type')!r}, expected 'Feature'")
        props = feat.get("properties")
        if not isinstance(props, dict):
            problems.append(f"feature {i}: `properties` missing or not an object")
            continue
        for key in REQUIRED_PROPS:
            if key not in props:
                problems.append(f"feature {i}: missing `{key}`")
        for key in VALUE_CHECKED:
            if key not in props:
                continue
            v = props[key]
            if v is None:
                continue
            allowed_vals = allowed.get(key)
            if allowed_vals and v not in allowed_vals:
                problems.append(
                    f"feature {i}: {key}={v!r} not in {sorted(allowed_vals)}"
                )
        for dk in DATE_FIELDS:
            dv = props.get(dk)
            if dv in (None, ""):
                continue
            try:
                datetime.fromisoformat(str(dv).replace("Z", "+00:00"))
            except ValueError:
                problems.append(f"feature {i}: {dk}={dv!r} is not ISO-8601")

    if problems:
        head = problems[:8]
        tail = f"\n          (+{len(problems) - len(head)} more)" if len(problems) > len(head) else ""
        raise SchemaViolation(
            f"{path.name}: {len(problems)} schema problem(s):\n          "
            + "\n          ".join(head) + tail,
            hint="See Scraping/schema.py — make_feature() should be the only "
                 "writer, so this points at a source module bypassing it.",
        )


@check("SCHEMA-002", "network.geojson features satisfy the shared schema")
def check_network_schema() -> None:
    path = DATA / "network.geojson"
    if not path.exists():
        return
    _check_feature_schema(_load_geojson(path), path, _probe_allowed_from_schema())


@check("SCHEMA-003", "closures.geojson features satisfy the shared schema")
def check_closures_schema() -> None:
    path = DATA / "closures.geojson"
    if not path.exists():
        return
    _check_feature_schema(_load_geojson(path), path, _probe_allowed_from_schema())


# ---------------------------------------------------------------------------
# Geometry checks
# ---------------------------------------------------------------------------

BAD_LINE_TYPES = {"Polygon", "MultiPolygon"}


@check("GEO-001", "network.geojson contains no polygon artifacts")
def check_no_polygons() -> None:
    path = DATA / "network.geojson"
    if not path.exists():
        return
    fc = _load_geojson(path)
    bad: list[str] = []
    for i, feat in enumerate(fc.get("features", [])):
        g = feat.get("geometry") or {}
        if g.get("type") in BAD_LINE_TYPES:
            name = (feat.get("properties") or {}).get("name") or "(unnamed)"
            bad.append(f"feature {i} [{g.get('type')}] {name}")
    if bad:
        head = bad[:5]
        tail = f" (+{len(bad) - len(head)} more)" if len(bad) > len(head) else ""
        raise GeometryAnomaly(
            f"network.geojson contains {len(bad)} polygon feature(s): "
            + "; ".join(head) + tail,
            hint="Closed-loop ways (cul-de-sacs, roundabouts) are leaking through "
                 "as Polygons. Either run the one-off closed-loop fix, or bake it "
                 "into osm_source.py (see 'Immediate next steps' #1).",
        )


@check("GEO-002", "closures.geojson features are LineString/MultiLineString")
def check_closure_geometry() -> None:
    path = DATA / "closures.geojson"
    if not path.exists():
        return
    fc = _load_geojson(path)
    ok = {"LineString", "MultiLineString"}
    bad: list[str] = []
    for i, feat in enumerate(fc.get("features", [])):
        g = feat.get("geometry") or {}
        if g.get("type") not in ok:
            bad.append(f"feature {i}: {g.get('type')!r}")
    if bad:
        head = bad[:5]
        tail = f" (+{len(bad) - len(head)} more)" if len(bad) > len(head) else ""
        raise GeometryAnomaly(
            f"{len(bad)} closure feature(s) have unexpected geometry: "
            + "; ".join(head) + tail,
            hint="The Calgary Pathway Closures layer is documented as line "
                 "geometry. If the ArcGIS schema changed, update "
                 "calgary_closures_source.py.",
        )


# ---------------------------------------------------------------------------
# Data freshness / hygiene
# ---------------------------------------------------------------------------

@check("DATA-001", "closures.geojson carries a top-level `generated` timestamp")
def check_generated_field() -> None:
    path = DATA / "closures.geojson"
    if not path.exists():
        return
    fc = _load_geojson(path)
    gen = fc.get("generated")
    if not gen:
        raise SchemaViolation(
            "closures.geojson has no top-level `generated` field.",
            hint="merge.py should stamp this on write; index.html may read it "
                 "to display an 'as of' banner.",
        )
    try:
        datetime.fromisoformat(str(gen).replace("Z", "+00:00"))
    except ValueError:
        raise SchemaViolation(
            f"`generated` = {gen!r} is not parseable as ISO-8601.",
        )


@check("DATA-002", "closures.geojson is fresh (< 48 hours old)")
def check_freshness() -> None:
    path = DATA / "closures.geojson"
    if not path.exists():
        return
    gen = _load_geojson(path).get("generated")
    if not gen:
        return  # DATA-001
    try:
        ts = datetime.fromisoformat(str(gen).replace("Z", "+00:00"))
    except ValueError:
        return  # DATA-001
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    age_h = (datetime.now(timezone.utc) - ts).total_seconds() / 3600.0
    if age_h > 48:
        raise DataStale(
            f"closures.geojson was generated {age_h:.1f}h ago.",
            hint="Re-run `python3 Scraping/merge.py`, or wire up the GitHub "
                 "Actions cron job (Immediate next steps #4).",
            severity="warning",
        )


@check("DATA-003", "No PAST closures leaked into closures.geojson")
def check_no_past_closures() -> None:
    path = DATA / "closures.geojson"
    if not path.exists():
        return
    fc = _load_geojson(path)
    bad = [
        i for i, f in enumerate(fc.get("features", []))
        if (f.get("properties") or {}).get("calgary_temporal_status") == "PAST"
    ]
    if bad:
        raise SchemaViolation(
            f"{len(bad)} PAST closure(s) present in closures.geojson "
            f"(indices {bad[:5]}{'...' if len(bad) > 5 else ''}).",
            hint="merge.py is supposed to drop PAST closures. Check the "
                 "filter — the temporal field is `calgary_temporal_status`.",
        )


# ---------------------------------------------------------------------------
# Web asset checks
# ---------------------------------------------------------------------------

@check("WEB-001", "index.html references the data files it needs")
def check_web_refs() -> None:
    path = WEB / "index.html"
    if not path.exists():
        return  # FILE-001
    text = path.read_text(encoding="utf-8")
    for needle in ("network.geojson", "closures.geojson"):
        if needle not in text:
            raise WebAssetProblem(
                f"web/index.html does not reference {needle!r}.",
                hint="The page should fetch ../data/network.geojson and "
                     "../data/closures.geojson relative to web/.",
            )


@check("WEB-002", "index.html carries required attributions")
def check_web_attributions() -> None:
    path = WEB / "index.html"
    if not path.exists():
        return
    low = path.read_text(encoding="utf-8").lower()
    missing: list[str] = []
    if "attribution" not in low:
        missing.append("MapLibre AttributionControl")
    if "openstreetmap" not in low and "osm" not in low:
        missing.append("OpenStreetMap / ODbL credit")
    if "calgary" not in low:
        missing.append("City of Calgary Open Government Licence credit")
    if missing:
        raise WebAssetProblem(
            f"index.html appears to be missing: {', '.join(missing)}",
            hint="Both sources are licensed and require visible attribution.",
        )


# ---------------------------------------------------------------------------
# Git hygiene
# ---------------------------------------------------------------------------

@check("GIT-001", "data/combined.geojson is gitignored")
def check_combined_ignored() -> None:
    combined = DATA / "combined.geojson"
    if not combined.exists():
        return  # nothing to ignore yet
    if shutil.which("git") is None:
        raise GitIgnoreProblem(
            "git is not on PATH; cannot verify ignore status.",
            severity="warning",
        )
    r = subprocess.run(
        ["git", "check-ignore", "-q", "--", str(combined)],
        cwd=REPO_ROOT, capture_output=True,
    )
    if r.returncode == 128:
        raise GitIgnoreProblem(
            "Not inside a git repository.",
            severity="warning",
            hint="Run `git init` at the repo root if this is a fresh checkout.",
        )
    if r.returncode != 0:
        raise GitIgnoreProblem(
            f"{combined.relative_to(REPO_ROOT)} is NOT gitignored.",
            hint="Add `data/combined.geojson` (or `data/*.geojson` except the "
                 "two the web page needs) to .gitignore before committing data/.",
        )


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

@dataclass
class Outcome:
    code: str
    name: str
    error: DoctorError | None


def _run_all() -> list[Outcome]:
    outcomes: list[Outcome] = []
    for code, name, fn in CHECKS:
        try:
            fn()
        except DoctorError as e:
            outcomes.append(Outcome(code, name, e))
        except Exception as e:
            wrapped = DoctorError(
                f"check crashed with {type(e).__name__}: {e}",
                hint="This is a bug in doctor.py, not in your project.",
            )
            outcomes.append(Outcome(code, name, wrapped))
        else:
            outcomes.append(Outcome(code, name, None))
    return outcomes


def _print_pretty(outcomes: list[Outcome]) -> None:
    print("Calgary Cycling Closures Map — Doctor")
    print("=" * 66)
    print(f"Repo root : {REPO_ROOT}")
    print(f"Platform  : {platform.system()} {platform.release()}")
    print(f"Python    : {sys.version.split()[0]}")
    print()

    for o in outcomes:
        if o.error is None:
            print(f"  PASS  {o.code}  {o.name}")
            continue
        tag = "WARN" if o.error.severity == "warning" else "FAIL"
        print(f"  {tag}  {o.code}  {o.name}")
        print(f"        [{type(o.error).__name__}] {o.error.message}")
        if o.error.hint:
            print(f"        hint: {o.error.hint}")
        print()

    n_total = len(outcomes)
    n_fail = sum(1 for o in outcomes if o.error and o.error.severity == "error")
    n_warn = sum(1 for o in outcomes if o.error and o.error.severity == "warning")
    n_pass = n_total - n_fail - n_warn
    print(f"{n_total} checks: {n_pass} passed, {n_warn} warnings, {n_fail} failures")


def _print_json(outcomes: list[Outcome]) -> None:
    payload = {
        "repo_root": str(REPO_ROOT),
        "platform": platform.system(),
        "python": sys.version.split()[0],
        "outcomes": [
            {
                "code": o.code,
                "name": o.name,
                "status": (
                    "pass" if o.error is None
                    else "warn" if o.error.severity == "warning"
                    else "fail"
                ),
                "error_type": type(o.error).__name__ if o.error else None,
                "message": o.error.message if o.error else None,
                "hint": o.error.hint if o.error else None,
            }
            for o in outcomes
        ],
    }
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Project preflight diagnostics.")
    parser.add_argument("--json", action="store_true",
                        help="machine-readable output for CI")
    args = parser.parse_args()

    outcomes = _run_all()
    _print_json(outcomes) if args.json else _print_pretty(outcomes)

    failed = [o for o in outcomes if o.error and o.error.severity == "error"]
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())