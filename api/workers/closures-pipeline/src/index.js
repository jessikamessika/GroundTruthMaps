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

		// Passed all checks: store data first, then meta.
		await env.PIPELINE_KV.put(DATA_KEY, JSON.stringify(rows));
		await env.PIPELINE_KV.put(META_KEY, JSON.stringify({
			...prevMeta,
			lastChecked: now,
			lastSuccess: now,
			sourceUpdatedAt,
			rowCount: rows.length,
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
	},
};
