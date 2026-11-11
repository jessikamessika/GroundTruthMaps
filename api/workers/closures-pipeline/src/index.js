/**
 * Welcome to Cloudflare Workers!
 *
 * This is a template for a Scheduled Worker: a Worker that can run on a
 * configurable interval:
 * https://developers.cloudflare.com/workers/platform/triggers/cron-triggers/
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Run `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"` to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
	async fetch(req) {
		const url = new URL(req.url)
		url.pathname = "/__scheduled";
		url.searchParams.append("cron", "*/15 * * * *");
		return new Response(`To test the scheduled handler, ensure you have used the "--test-scheduled" then try running "curl ${url.href}".`);
	},

	// The scheduled handler is invoked at the interval set in our wrangler.jsonc's
	// [[triggers]] configuration.
	async scheduled(event, env, ctx) {
		// 1. Build the URL. "?$limit=5000" asks for up to 5000 rows (we have ~125).
		const url = "https://data.calgary.ca/resource/w8zq-79bq.json" + "?$limit=5000";

		// 2. Call the City. "await" = wait for the answer before continuing.
		const resp = await fetch(url);

		// 3. If the City returned an error, log it and stop.
		if (!resp.ok) {
			console.log("City fetch failed, HTTP status:", resp.status);
			return;
		}

		// 4. Turn the response body into a JavaScript array of row objects.
		const rows = await resp.json();   // hint: the method that parses JSON

		// 5. Log how many rows came back.
		console.log("Row count:", rows.length);   // hint: how you get an array's size

		// 6. Time zone test: format "now" in Calgary time, including the UTC offset.
		const calgaryNow = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Edmonton",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        timeZoneName: "longOffset",   // shows e.g. GMT-06:00
		}).format(new Date());
		console.log("Now in Calgary:", calgaryNow);
	},
};
