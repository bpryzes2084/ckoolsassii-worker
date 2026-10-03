import { checkSquare, searchCatalog, type SquareEnv } from "./search";

interface AppEnv extends SquareEnv {
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
			return json(body);
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
