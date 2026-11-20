/**
 * Welcome to Cloudflare Workers!
 *
 * This is a template for a Scheduled Worker: a Worker that can run on a
 * configurable interval:
 * https://developers.cloudflare.com/workers/platform/triggers/cron-triggers/
 *
 * - cd ./api/workers/closures-pipeline
 * - Run `npm run dev` in your terminal to start a development server
 * - Run `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"` to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const CONSTRUCTION_LIMIT = 5000;

const DATASETS = [
	{
		id: "w8zq-79bq",
		name: "Construction Closures", // City's database named "Construction Detours"
		limit: CONSTRUCTION_LIMIT,
		url: "https://data.calgary.ca/resource/w8zq-79bq.json?$limit=" + String(CONSTRUCTION_LIMIT),
		requiredFields: ["start_dt", "end_dt", "longitude", "latitude", "construction_info"],
		// cleanSchema (PLANNED, not implemented): what each row looks like AFTER cleaning.
		// requiredFields = what we need to trust the RAW data.
		// cleanSchema    = the contract our API promises.
		//   rowID:           datasetId|construction_info|start_dt
		//                    (if that key repeats, also append |description;
		//                     if it STILL repeats, the rows are true copies: keep one)
		//   lon, lat:        numbers, parsed from the strings (parseFloat is the function)
		//   start, end:      ISO 8601 string with -06:00 offset (from Calgary-local start_dt)
		//   active:          computed, see Stage 4
		//   sourceDatasetId: the dataset's id (w8zq-79bq)
		//   popup fields:    name (from construction_info) and description
		baselineRows: 140,
		lowCountAcceptAfter: 3,   // accept a big drop after this many consistent low runs
		jumpWarnRatio: 1.5,       // warn (not fail) if rows exceed baseline by 50%+
		metaUrl: "https://data.calgary.ca/api/views/w8zq-79bq.json",
		updatedAtUnit: "seconds", // Socrata. ArcGIS (dataset #2) is milliseconds.
		// Calgary is permanently UTC-6 (Alberta Time). Any other offset is a bug.
		// Only works because Calgary never changes offset. SF and most other cities
		// have daylight saving, so they'll need real time-zone conversion when added.
		utcOffset: "-06:00",
		// Loose box around Calgary. Rows outside it are treated as bad coordinates.
		// San Francisco and other cities will get their own box when we add them (coming soon).
		bbox: { minLon: -114.4, maxLon: -113.8, minLat: 50.8, maxLat: 51.3 },
		maxBadRowRatio: 0.1,
	},
];

// Records a rejected run: updates meta only. Never touches DATA_KEY (fail-closed).
async function recordFailure(env, metaKey, prevMeta, now, reason, extra = {}) {
	const meta = {
		...prevMeta,                      // copy every old field (lastSuccess, rowCount... stay unchanged)
		lastChecked: now,
		status: `failed: ${reason}`,
		runsTotal: prevMeta.runsTotal + 1,
		runsRejected: prevMeta.runsRejected + 1,
		...extra,
	};
	await env.PIPELINE_KV.put(metaKey, JSON.stringify(meta));
	// NOTE: no put to DATA_KEY here. That absence IS the fail-closed rule.
}

// Socrata dates look like "2025-06-01T09:00:00.000" (Calgary local, no zone).
// Regex parts: ^ and $ = start and end of string; \d{4} = exactly 4 digits;
// ( ... ) = a "capture group" we can read back; (\.\d+)? = optional fraction like ".000".
const SOCRATA_LOCAL_DT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?$/;

// Turns the City's string into "2025-06-01T09:00:00-06:00", or null if the format is unexpected.
function toLocalIso(raw, offset) {
	// .exec returns an array if it matches, or null if not.
	// m[1] is the first capture group (date and time, without the fraction).
	const m = SOCRATA_LOCAL_DT.exec(raw ?? "");
	if (!m) return null;
	return m[1] + offset;
}

// True if the point is inside the dataset's box.
function inBox(lon, lat, box) {
	return lon >= box.minLon && lon <= box.maxLon &&
		lat >= box.minLat && lat <= box.maxLat;
}

// Raw validated rows in, clean rows plus stats out.
// It never decides whether the run fails; scheduled() does that with the stats.
function normalize(rows, dataset) {
	const stats = {
		rawCount: rows.length,
		badRowsDropped: 0,
		copiesDropped: 0,
		descriptionAppended: 0,
		idCollisions: 0,       // rows that needed coordinates added to stay unique (Option A)
		endBeforeStart: 0,     // kept, not dropped (hiding a closure is the dangerous direction)
		badExamples: [],       // first 3 reasons, so /status can show what went wrong
		collisionExamples: [], // first 3 colliding rowIDs, for the warning
	};

	// ---- Pass 1: give every row the clean shape; set aside rows we can't map ----
	const shaped = [];
	for (const r of rows) {   // for...of loops over the values of an array
		const name = (r.construction_info ?? "").trim();   // .trim() removes spaces at both ends
		const description = (r.description ?? "").trim(); // missing description becomes ""

		// Number() is stricter than parseFloat: Number("12abc") is NaN, parseFloat("12abc") is 12.
		// We read longitude/latitude, not the City's `point` column (WKT text since Nov 17).
		const lon = Number(r.longitude);
		const lat = Number(r.latitude);

		const start = toLocalIso(r.start_dt, dataset.utcOffset);
		const end = toLocalIso(r.end_dt, dataset.utcOffset);

		// Find the first problem, if any. let = a variable we may reassign (const can't be).
		let problem = null;
		if (!Number.isFinite(lon) || !Number.isFinite(lat)) problem = "coordinates not numbers";
		else if (!inBox(lon, lat, dataset.bbox)) problem = "coordinates outside box";
		else if (start === null || end === null) problem = "unexpected date format";

		if (problem) {
			stats.badRowsDropped++;   // ++ adds 1
			if (stats.badExamples.length < 3) stats.badExamples.push(`${name || "(no name)"}: ${problem}`);
			continue;                 // skip the rest of the loop for this row
		}

		// Same format and same offset on both sides, so plain string comparison
		// sorts them in time order. No Date needed.
		if (end < start) stats.endBeforeStart++;

		shaped.push({
			baseKey: `${dataset.id}|${name}|${start}`,   // normalized start: immune to the City's format tweaks
			sourceDatasetId: dataset.id,
			name, description, start, end, lon, lat,         // shorthand for name: name, etc.
		});
	}

	// ---- Pass 2: drop true copies (identical in every field we keep) ----
	const seen = new Set();   // a Set holds each value once; .has() checks membership
	const unique = [];
	for (const row of shaped) {
		// JSON.stringify of an array gives one string we can compare.
		const contentKey = JSON.stringify([row.baseKey, row.description, row.end, row.lon, row.lat]);
		if (seen.has(contentKey)) {
			stats.copiesDropped++;
			continue;
		}
		seen.add(contentKey);
		unique.push(row);
	}

	// ---- Pass 3: count how often each base key appears among real rows ----
	const baseCounts = new Map();   // a Map stores key -> value pairs
	for (const row of unique) {
		baseCounts.set(row.baseKey, (baseCounts.get(row.baseKey) ?? 0) + 1);
	}

	// ---- Pass 4: first rowID; append |description only where the base key repeats ----
	// ({ baseKey, ...rest }) = "destructuring": pull baseKey out, put every other field in rest.
	// That's how the helper field disappears from the clean row.
	const withIds = unique.map(({ baseKey, ...rest }) => {
		const repeated = baseCounts.get(baseKey) > 1;
		if (repeated) stats.descriptionAppended++;
		return {
			rowID: repeated ? `${baseKey}|${rest.description}` : baseKey,
			...rest,
		};
	});

	// ---- Pass 5 (Option A): rowIDs that still repeat keep both rows, made unique ----
	// Same name, start and description but a different place or end date.
	// Pass 2 already removed rows identical in all of these, so adding
	// lon, lat and end is guaranteed to make every rowID unique.
	const idCounts = new Map();
	for (const row of withIds) {
		idCounts.set(row.rowID, (idCounts.get(row.rowID) ?? 0) + 1);
	}

	const clean = withIds.map((row) => {
		if (idCounts.get(row.rowID) === 1) return row;   // === means "exactly equal"; most rows stop here
		stats.idCollisions++;
		if (stats.collisionExamples.length < 3) stats.collisionExamples.push(row.rowID);
		// Spread copies every field of row; the rowID written after it overrides the old one.
		return { ...row, rowID: `${row.rowID}|${row.lon},${row.lat}|${row.end}` };
	});

	stats.cleanCount = clean.length;
	return { rows: clean, stats };   // return two things at once by wrapping them in an object
}

// Browsers only let a web page call our API if we say its origin is allowed.
// An "origin" is scheme + host + port, e.g. "http://localhost:8000".
const ALLOWED_ORIGINS = [
	"https://jessikamessika.github.io",
	"http://127.0.0.1:8000",
	"http://localhost:8000",
]
// Builds the CORS headers for one request.
function corsHeaders(request) {
	// .get() returns null when the header is missing (e.g. curl, or same-origin calls)
	const origin = request.headers.get("Origin");
	// "Vary: Origin" tells caches the answer depends on who is asking
	const headers = { "Vary": "Origin" };
	// .includes() is true only if the origin is exactly one of the allowed strings
	if (origin && ALLOWED_ORIGINS.includes(origin)) {
		// We echo back the caller's own origin; we never send "*"
		headers["Access-Control-Allow-Origin"] = origin;
	}
	return headers;
}

// One helper for every JSON answer, so headers can't be forgotten.
// `status = 200` is a default parameter: used when the caller passes nothing.
// `extra = {}` lets a caller add headers (e.g. Cache-Control).
function json(request, body, status = 200, extra = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			...corsHeaders(request), // spread: copies each key into this object
			...extra,                // later spreads win if a key repeats
		},
	});
}

// Reads one KV key and parses it as JSON, without ever crashing the request.
// Returns { ok, value }:
//   { ok: true,  value: <data> }  -> read fine (value is null if the key doesn't exist)
//   { ok: false, value: null }    -> the stored text was corrupt or KV failed
async function readKey(env, key) {
	try {
		// { type: "json" } makes KV parse the text; it THROWS if the text isn't valid JSON
		const value = await env.PIPELINE_KV.get(key, { type: "json" });
		return { ok: true, value }; // shorthand for { ok: true, value: value }
	} catch (err) {
		// A throw anywhere inside `try` jumps here instead of crashing with a 500
		console.error(`could not read KV key ${key}:`, err);
		return { ok: false, value: null };
	}
}

// The one fail-closed answer: "we don't know" (503), never "no closures".
function unavailable(request, message) {
	return json(request, { error: message }, 503,
		{ "Cache-Control": "no-store", "Retry-After": "600" });
}

// How old data may get before we call it stale. The cron runs every 3 h,
// so 7 h means "two runs in a row missed".
const STALE_AFTER_MS = 7 * 60 * 60 * 1000; // ms = hours x minutes x seconds x 1000

// true if we have no successful run on record, or the last one is too old
function isStale(meta, nowMs) {
	// `meta?.lastSuccess` is "optional chaining": if meta is null it gives
	// undefined instead of crashing with "cannot read property of null"
	if (!meta?.lastSuccess) return true;
	// Date.parse turns an ISO string into milliseconds since 1970
	return nowMs - Date.parse(meta.lastSuccess) > STALE_AFTER_MS;
}

// Mean Earth radius in km. Treating the Earth as a sphere is off by <0.5%: fine for "within 10 km".
const EARTH_RADIUS_KM = 6371;

// Math.sin/Math.cos expect radians, not degrees. 180° = π radians.
function toRadians(degrees) {
	return degrees * Math.PI / 180;
}

// Great-circle distance in km between two points given in degrees.
// "Great circle" = the shortest path along the sphere's surface, not a straight line through it.
function haversineKm(lat1, lon1, lat2, lon2) {
	// How far apart the two points are, north-south and east-west, as angles in radians
	const dLat = toRadians(lat2 - lat1);
	const dLon = toRadians(lon2 - lon1);

	// `a` combines both differences. The east-west part is multiplied by cos(lat) for each
	// point: meridians converge toward the poles, so a degree of longitude shrinks with latitude.
	// `** 2` means "squared".
	const a = Math.sin(dLat / 2) ** 2
		+ Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;

	// `c` is the angle between the two points as seen from the Earth's centre, in radians
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

	// Arc length = radius × angle (in radians). That's why we needed radians.
	return EARTH_RADIUS_KM * c;
}

// Limits for /nearby (decided in Stage 4b)
const DEFAULT_RADIUS_KM = 10;
const MAX_RADIUS_KM = 100;

// Turns one query parameter into a number, or explains why it can't.
// Returns { ok: true, value } or { ok: false, error }.
function parseNumberParam(params, name) {
	const raw = params.get(name); // a string, or null if missing
	// Check "missing" BEFORE Number(): Number(null) and Number("") are both 0
	if (raw === null || raw === "") {
		return { ok: false, error: `missing required parameter: ${name}` };
	}
	const value = Number(raw); // "51abc" -> NaN, unlike parseFloat
	if (!Number.isFinite(value)) {
		return { ok: false, error: `${name} must be a number, got "${raw}"` };
	}
	return { ok: true, value };
}

// Reads and checks lat, lon and radius_km for /nearby.
// Returns { ok: true, lat, lon, radiusKm } or { ok: false, error }.
function parseNearbyQuery(params) {
	const latRead = parseNumberParam(params, "lat");
	if (!latRead.ok) return latRead; // pass the error object straight up
	const lonRead = parseNumberParam(params, "lon");
	if (!lonRead.ok) return lonRead;

	const lat = latRead.value;
	const lon = lonRead.value;
	if (lat < -90 || lat > 90) {
		return { ok: false, error: `lat must be between -90 and 90, got ${lat}` };
	}
	if (lon < -180 || lon > 180) {
		return { ok: false, error: `lon must be between -180 and 180, got ${lon}` };
	}

	// radius_km is optional: missing means the default
	let radiusKm = DEFAULT_RADIUS_KM; // `let` (not const) because we may replace it below
	if (params.get("radius_km") !== null) {
		const radiusRead = parseNumberParam(params, "radius_km");
		if (!radiusRead.ok) return radiusRead; // e.g. ?radius_km= (empty) or ?radius_km=ten
		radiusKm = radiusRead.value;
		if (radiusKm <= 0 || radiusKm > MAX_RADIUS_KM) {
			return { ok: false, error: `radius_km must be more than 0 and at most ${MAX_RADIUS_KM}, got ${radiusKm}` };
		}
	}

	return { ok: true, lat, lon, radiusKm };
}

// Turns clean rows into GeoJSON Features. Every endpoint that returns closures
// calls this, so "active" and the geometry are computed in exactly one place.
function buildFeatures(clean, nowMs, options = {}) {
	const { onlyActive = false } = options; // false if the caller didn't say

	const features = [];
	for (const row of clean) {
		// The strings end in -06:00, so Date.parse gives the exact moment
		const active = Date.parse(row.start) <= nowMs && nowMs <= Date.parse(row.end);
		if (onlyActive && !active) continue; // skip this row, go to the next
		// Destructuring with rest: pull out lon and lat, everything else lands in `props`
		const { lon, lat, ...props } = row;
		features.push({
			type: "Feature",
			geometry: { type: "Point", coordinates: [lon, lat] }, // GeoJSON order is lon, lat
			properties: { ...props, active },
		});
	}
	return features; // the caller wraps this in a FeatureCollection
}

async function handleClosures(request, env) {
	const dataset = DATASETS[0];
	const cleanRead = await readKey(env, `${dataset.id}:clean`);
	const metaRead = await readKey(env, `${dataset.id}:meta`);

	// Fail closed: missing OR unreadable clean data means "we don't know"
	if (!cleanRead.ok || !Array.isArray(cleanRead.value)) {
		return unavailable(request, "clean data unavailable");
	}
	const clean = cleanRead.value;
	const meta = metaRead.value; // null if missing/corrupt -> isStale() says stale: true

	const nowMs = Date.now();
	const onlyActive = new URL(request.url).searchParams.get("active") === "true";

	return json(request, {
		type: "FeatureCollection",
		fetched_at: meta?.lastSuccess ?? null,
		stale: isStale(meta, nowMs),
		features: buildFeatures(clean, nowMs, { onlyActive }), // { onlyActive } = { onlyActive: onlyActive }
	}, 200, { "Cache-Control": "public, max-age=60" });
}

// How old the CITY's own data may get before we flag it.
// Separate from STALE_AFTER_MS: that one is about OUR pipeline running, this one
// is about the City publishing.
const CITY_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

async function handleStatus(request, env) {
	const dataset = DATASETS[0];
	const metaRead = await readKey(env, `${dataset.id}:meta`);
	const nowMs = Date.now();

	// Unreadable is NOT the same as "never run": we can't say anything true about the pipeline.
	// (A missing key is ok: true with value null, so it still falls through to "never run".)
	if (!metaRead.ok) {
		return unavailable(request, "status unavailable");
	}
	const meta = metaRead.value; // null if no run has ever written one

	// no meta just means no run has ever finished writing one
	if (!meta) {
		return json(request,
			{ dataset: dataset.id, status: "never run", stale: true, cityStale: null },
			200, { "Cache-Control": "no-store" });
	}

	// Ternary: `condition ? valueIfTrue : valueIfFalse`.
	// null means "unknown" (no timestamp yet), not "fresh".
	const cityStale = meta.sourceUpdatedAt
		? nowMs - Date.parse(meta.sourceUpdatedAt) > CITY_STALE_AFTER_MS
		: null;

	return json(request, {
		dataset: dataset.id,
		...meta, // spread: every field of the stored meta, then our computed ones below
		stale: isStale(meta, nowMs),
		cityStale,
		checkedAt: new Date(nowMs).toISOString(),
	}, 200, { "Cache-Control": "no-store" });
}

export default {

	// Runs on every HTTP request. `env` holds bindings such as PIPELINE_KV.
	async fetch(request, env) {
		// Only reading is allowed; anything else gets 405 "Method Not Allowed"
		if (request.method !== "GET") {
			return json(request, { error: "method not allowed" }, 405, { "Allow": "GET" });
		}

		// new URL(...) splits the address; .pathname is just "/status", without ?query
		const url = new URL(request.url);

		if (url.pathname === "/closures.geojson") {
			return handleClosures(request, env);
		}
		if (url.pathname === "/status") {
			return handleStatus(request, env);
		}

		// Everything else
		return json(request, { error: "not found" }, 404);
	},

	// The scheduled handler is invoked at the interval set in our wrangler.jsonc's
	// [[triggers]] configuration.
	async scheduled(event, env, ctx) {
		const dataset = DATASETS[0];
		console.log("Checking dataset:", dataset.name);
		const DATA_KEY = `${dataset.id}:latest`;
		const META_KEY = `${dataset.id}:meta`;
		const CLEAN_KEY = `${dataset.id}:clean`;

		const prevMeta = (await env.PIPELINE_KV.get(META_KEY, { type: "json" })) || {
			runsTotal: 0,
			runsRejected: 0,
		};
		const now = new Date().toISOString();

		const warnings = []; // const is fine: we push into the array, never replace it

		// Check 1: HTTP status
		let resp;
		try {
			resp = await fetch(dataset.url);
		} catch (err) {
			console.log("FAIL check 1 (network):", err.message);
			await recordFailure(env, META_KEY, prevMeta, now, "check 1: network " + err.message);
			return;
		}
		if (resp.status !== 200) {
			console.log("FAIL check 1 (status):", resp.status);
			await recordFailure(env, META_KEY, prevMeta, now, "check 1: status " + resp.status);
			return;
		}

		// Check 2: JSON parses AND is an array
		let rows;
		try {
			rows = await resp.json();
		} catch (err) {
			console.log("FAIL check 2 (JSON parse):", err.message);
			await recordFailure(env, META_KEY, prevMeta, now, "check 2: JSON parse " + err.message);
			return;
		}
		if (!Array.isArray(rows)) {
			console.log("FAIL check 2 (not an array)");
			await recordFailure(env, META_KEY, prevMeta, now, "check 2: not an array");
			return;
		}

		// Check 3: row count
		// zero rows
		if (rows.length === 0) {
			console.log("FAIL check 3 (zero rows)");
			await recordFailure(env, META_KEY, prevMeta, now, "check 3: zero rows");
			return;
		}
		// rows dropped by > half: fail, unless it's the Nth consistent low run in a row
		const baseline = prevMeta.rowCount ?? dataset.baselineRows;
		if (rows.length < baseline * 0.5) {
			const prevLow = prevMeta.lowCountLast;
			const consistent = typeof prevLow === "number"
				&& Math.abs(rows.length - prevLow) <= prevLow * 0.1;   // 10%
			const streak = consistent ? (prevMeta.lowCountStreak ?? 0) + 1 : 1;

			if (streak < dataset.lowCountAcceptAfter) {
				console.log("FAIL check 3 (row count dropped):", rows.length, "vs baseline", baseline, "streak", streak);
				await recordFailure(env, META_KEY, prevMeta, now,
					`check 3: rows ${rows.length} vs baseline ${baseline} (low streak ${streak}/${dataset.lowCountAcceptAfter})`,
					{ lowCountStreak: streak, lowCountLast: rows.length });
				return;
			}
			console.log("WARN: accepting low row count after", streak, "consistent low runs");
			warnings.push(`baseline reset ${baseline} -> ${rows.length} after ${streak} consistent low runs`);
		}
		// Big jump in rows: store it anyway (missing new closures is worse than extra ones), but flag it.
		if (rows.length > baseline * dataset.jumpWarnRatio) {
			console.log("WARN: row count jumped:", baseline, "->", rows.length);
			warnings.push(`row count jumped ${baseline} -> ${rows.length}`);
		}

		// possibly truncated
		if (rows.length >= dataset.limit) {
			warnings.push("truncated at limit");
			console.log("WARN: row count reached the limit, data may be truncated");
		}
		// Check 4: required fields
		const badFields = [];
		for (const field of dataset.requiredFields) {
			const missing = rows.filter(row => row[field] === undefined || row[field] === null || row[field] === "").length;
			if (missing > 0) {
				console.log("FAIL check 4: field", field, "missing or empty in", missing, "rows");
				badFields.push(field);
			}
		}
		if (badFields.length > 0) {
			await recordFailure(env, META_KEY, prevMeta, now, "check 4: missing " + badFields.join(", "));
			return;
		}

		// Stage 3.5: normalize. Validation decided "trust this batch"; this gives it the clean shape.
		// If normalize throws, that's a bug in our code: fail closed, keep the old clean copy.
		let result;
		try {
			result = normalize(rows, dataset);
		} catch (err) {
			console.log("FAIL normalize (threw):", err.message);
			await recordFailure(env, META_KEY, prevMeta, now, "normalize threw: " + err.message);
			return;
		}
		const cleanRows = result.rows;
		const normStats = result.stats;
		console.log("Normalize:", normStats);

		// Too many bad rows means the City changed its format: fail the whole run.
		// rawCount is never 0 here, because check 3 already failed zero-row runs.
		const badRatio = normStats.badRowsDropped / normStats.rawCount;
		if (badRatio > dataset.maxBadRowRatio) {
			console.log("FAIL normalize (too many bad rows):", normStats.badRowsDropped, "of", normStats.rawCount);
			await recordFailure(env, META_KEY, prevMeta, now,
				`normalize: ${normStats.badRowsDropped} of ${normStats.rawCount} rows bad (${normStats.badExamples.join("; ")})`);
			return;
		}

		// Invariant: every row is accounted for, and every rowID is unique.
		// If this fails, it's a bug in normalize, not bad City data.
		const expectedCount = normStats.rawCount - normStats.copiesDropped - normStats.badRowsDropped;
		// new Set(list).size = how many DIFFERENT values the list has.
		// .map(r => r.rowID) = a new array holding just each row's rowID.
		const distinctIds = new Set(cleanRows.map(r => r.rowID)).size;
		if (cleanRows.length !== expectedCount || distinctIds !== cleanRows.length) {
			console.log("FAIL normalize (invariant):", cleanRows.length, "rows, expected", expectedCount, "; distinct IDs", distinctIds);
			await recordFailure(env, META_KEY, prevMeta, now,
				`normalize invariant: ${cleanRows.length} rows (expected ${expectedCount}), ${distinctIds} distinct rowIDs`);
			return;
		}

		// Things that don't fail the run but you should hear about (alerts arrive in Stage 5).
		if (normStats.badRowsDropped > 0) {
			warnings.push(`${normStats.badRowsDropped} bad rows dropped (${normStats.badExamples.join("; ")})`);
		}
		if (normStats.idCollisions > 0) {
			warnings.push(`${normStats.idCollisions} rows shared a rowID; coordinates added (${normStats.collisionExamples.join("; ")})`);
		}

		// sourceUpdatedAt: when the City last changed the rows. Never fails the run.
		let sourceUpdatedAt = prevMeta.sourceUpdatedAt ?? null; // fallback: keep the last known value
		try {
			const metaResp = await fetch(dataset.metaUrl);
			const viewMeta = await metaResp.json();
			if (typeof viewMeta.rowsUpdatedAt === "number") {
				const toMs = dataset.updatedAtUnit === "seconds" ? 1000 : 1;
				sourceUpdatedAt = new Date(viewMeta.rowsUpdatedAt * toMs).toISOString();
			} else {
				warnings.push("rowsUpdatedAt missing");
				console.log("WARN: rowsUpdatedAt missing from metadata");
			}
		} catch (err) {
			warnings.push("metadata fetch failed: " + err.message);
			console.log("WARN: metadata fetch failed:", err.message);
		}

		// Passed all checks: raw first, then clean, then meta LAST.
		// If the Worker dies partway, meta still describes the old clean copy (cautious).
		// 3 writes per run x 8 runs a day = 24 writes, well under the 1,000 free limit.
		await env.PIPELINE_KV.put(DATA_KEY, JSON.stringify(rows));
		await env.PIPELINE_KV.put(CLEAN_KEY, JSON.stringify(cleanRows));
		await env.PIPELINE_KV.put(META_KEY, JSON.stringify({
			...prevMeta,
			lastChecked: now,
			lastSuccess: now,
			sourceUpdatedAt,
			rowCount: rows.length,          // raw count: check 3's baseline
			cleanRowCount: cleanRows.length,
			normalize: normStats,           // what normalize did, for /status in Stage 4
			status: warnings.length > 0 ? "ok_with_warnings: " + warnings.join("; ") : "ok",
			runsTotal: prevMeta.runsTotal + 1,
			runsRejected: prevMeta.runsRejected,
			lowCountStreak: 0,     // a good run ends any streak
			lowCountLast: null,
		}));

		if (warnings.length > 0) {
			console.log("Checks passed WITH", warnings.length, "warning(s): kept new data");
		} else {
			console.log("All checks passed: kept new data");
		}

		// TEMPORARY, commented out until Stage 4: read the clean copy back for a test.
		// const cleanBack = await env.PIPELINE_KV.get(CLEAN_KEY, { type: "json" });
		// console.log("READBACK clean:", cleanBack.length, "rows; first two:", cleanBack.slice(0, 2));
	},
};
