"""
Per-city settings (decision 3: one repo, a city setting, no separate SF copy).

Only the SF pipeline reads this so far. Calgary still uses its own
hardcoded paths/constants; migrating it onto this file is a follow-up,
deliberately NOT done before the SF demo so the live Calgary map can't break.
"""

CITIES = {
    "calgary": {
        "name": "Calgary",
        "center": [-114.0719, 51.0447],
        "zoom": 11,
        "timezone": "America/Edmonton",
        "data_dir": "data",                      # existing layout, unchanged
        "banner": None,
    },
    "sf": {
        "name": "San Francisco",
        "center": [-122.4194, 37.7749],
        "zoom": 12,
        "timezone": "America/Los_Angeles",
        "data_dir": "data/sf",
        # Required by the project context: SFMTA data excludes Public Works and
        # Police Department closures, and the map must say so.
        "banner": (
            "Shows street closures permitted by SFMTA only. Closures managed by "
            "Public Works or the Police Department are not included."
        ),
        "attribution": "SFMTA Temporary Street Closures via DataSF (PDDL)",
    },
}
