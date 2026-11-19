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

// TEMPORARY, commented out until Stage 4 (/status replaces it). To use it for a test:
// uncomment this function AND the debugReadBack calls in scheduled() below.
// async function debugReadBack(env, dataKey, metaKey) {
// 	const data = await env.PIPELINE_KV.get(dataKey, { type: "json" });
// 	const meta = await env.PIPELINE_KV.get(metaKey, { type: "json" });
// 	console.log("READBACK", dataKey, "->", data === null ? "null (never written)" : data.length + " rows, first:", data?.[0]);
// 	console.log("READBACK", metaKey, "->", meta);
// }

export default {
	// Cloudflare template fetch handler, commented out until Stage 4 replaces it with
	// GET /closures.geojson and GET /status. Local testing still works: --test-scheduled
	// serves /__scheduled without it.
	// async fetch(req) {
	// 	const url = new URL(req.url)
	// 	url.pathname = "/__scheduled";
	// 	url.searchParams.append("cron", "*/23 * * * *");
	// 	return new Response(`To test the scheduled handler, ensure you have used the "--test-scheduled" then try running "curl ${url.href}".`);
	// },

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
			// await debugReadBack(env, DATA_KEY, META_KEY);
			return;
		}
		if (resp.status !== 200) {
			console.log("FAIL check 1 (status):", resp.status);
			await recordFailure(env, META_KEY, prevMeta, now, "check 1: status " + resp.status);
			// await debugReadBack(env, DATA_KEY, META_KEY);
			return;
		}

		// Check 2: JSON parses AND is an array
		let rows;
		try {
			rows = await resp.json();
		} catch (err) {
			console.log("FAIL check 2 (JSON parse):", err.message);
			await recordFailure(env, META_KEY, prevMeta, now, "check 2: JSON parse " + err.message);
			// await debugReadBack(env, DATA_KEY, META_KEY);
			return;
		}
		if (!Array.isArray(rows)) {
			console.log("FAIL check 2 (not an array)");
			await recordFailure(env, META_KEY, prevMeta, now, "check 2: not an array");
			// await debugReadBack(env, DATA_KEY, META_KEY);
			return;
		}

		// Check 3: row count
		// zero rows
		if (rows.length === 0) {
			console.log("FAIL check 3 (zero rows)");
			await recordFailure(env, META_KEY, prevMeta, now, "check 3: zero rows");
			// await debugReadBack(env, DATA_KEY, META_KEY);
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
				// await debugReadBack(env, DATA_KEY, META_KEY);
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
			// await debugReadBack(env, DATA_KEY, META_KEY);
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

		// await debugReadBack(env, DATA_KEY, META_KEY);
		// TEMPORARY, commented out until Stage 4: read the clean copy back for a test.
		// const cleanBack = await env.PIPELINE_KV.get(CLEAN_KEY, { type: "json" });
		// console.log("READBACK clean:", cleanBack.length, "rows; first two:", cleanBack.slice(0, 2));
	},
};
