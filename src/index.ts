import { checkSquare, itemNamesForVariations, searchCatalog, type SquareEnv } from "./search";
import { estimateWeightLb, getRates, getUpsToken, missingShipFrom, upsConfigured, type ShipTo, type UpsEnv } from "./shipping";

interface AppEnv extends SquareEnv, UpsEnv {
	DB: D1Database;
}

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
	"Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS, ...extra },
	});
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		// Works both on a ckoolsassii.biz/api/* route and on the workers.dev address.
		const path = url.pathname.replace(/\/+$/, "").replace(/^\/api(?=\/|$)/, "") || "/";

		if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

		if (path === "/health") {
			const body: Record<string, unknown> = {
				ok: true,
				square_configured: Boolean(env.SQUARE_ACCESS_TOKEN),
				square_env: (env.SQUARE_ENV || "production").toLowerCase(),
			};
			// /api/health?square=1 also tests the token against Square.
			if (url.searchParams.has("square") && env.SQUARE_ACCESS_TOKEN) {
				try {
					const locations = await checkSquare(env);
					body.square_ok = true;
					body.locations = locations;
				} catch (err) {
					body.square_ok = false;
					body.square_error = (err as Error).message;
				}
			}
			body.ups_configured = upsConfigured(env);
			body.ship_from_missing = missingShipFrom(env);
			// /api/health?ups=1 also tests the UPS credentials.
			if (url.searchParams.has("ups") && upsConfigured(env)) {
				try {
					await getUpsToken(env);
					body.ups_ok = true;
					body.ups_env = (env.UPS_ENV || "production").toLowerCase();
					body.ups_negotiated_rates = Boolean(env.UPS_ACCOUNT_NUMBER);
				} catch (err) {
					body.ups_ok = false;
					body.ups_error = (err as Error).message;
				}
			}
			return json(body);
		}

		if (path === "/shipping-rates" && request.method === "POST") {
			if (!upsConfigured(env)) return json({ error: "Shipping rates are not set up yet: UPS credentials are missing." }, 503);
			const missing = missingShipFrom(env);
			if (missing.length) return json({ error: "Shipping rates are not set up yet: ship-from address is incomplete.", missing }, 503);

			let input: { address?: ShipTo; items?: { variation_id?: string; qty?: number }[] };
			try {
				input = await request.json();
			} catch {
				return json({ error: "Send JSON: { address: { postal_code, ... }, items: [{ variation_id, qty }] }" }, 400);
			}
			const to = input.address;
			if (!to || !String(to.postal_code || "").trim()) return json({ error: "A ZIP code is required to quote shipping." }, 400);
			const items = (input.items || []).filter((i) => i && i.variation_id && Number(i.qty) > 0).slice(0, 50);
			if (!items.length) return json({ error: "The cart is empty." }, 400);

			try {
				let names = new Map<string, string>();
				if (env.SQUARE_ACCESS_TOKEN) names = await itemNamesForVariations(env, items.map((i) => String(i.variation_id)));
				const perUnit = items.flatMap((i) => Array(Math.min(99, Math.floor(Number(i.qty)))).fill(names.get(String(i.variation_id)) || ""));
				const weight = estimateWeightLb(perUnit);
				const rates = await getRates(env, { ...to, postal_code: String(to.postal_code).trim() }, weight);
				return json({ weight_lb: weight, rates });
			} catch (err) {
				console.error("shipping rates failed:", err);
				return json({ error: "Couldn't get UPS rates for that address. Check the ZIP code and try again.", detail: (err as Error).message }, 502);
			}
		}

		if (path === "/search" && request.method === "GET") {
			if (!env.SQUARE_ACCESS_TOKEN) {
				return json({ error: "Search is not set up yet: SQUARE_ACCESS_TOKEN is missing." }, 503);
			}
			const q = (url.searchParams.get("q") || "").slice(0, 100);
			try {
				const result = await searchCatalog(env, q);
				return json(result, 200, { "Cache-Control": "public, max-age=60" });
			} catch (err) {
				console.error("search failed:", err);
				// Square's reason (e.g. "401: This request could not be authorized") helps diagnose setup problems; it contains no secrets.
				return json({ error: "Search is unavailable right now. Please try again shortly.", detail: (err as Error).message }, 502);
			}
		}

		return json({ error: "Not found" }, 404);
	},
} satisfies ExportedHandler<AppEnv>;
