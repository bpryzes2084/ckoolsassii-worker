import { searchCatalog, type SquareEnv } from "./search";

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
			return json({ ok: true, square_configured: Boolean(env.SQUARE_ACCESS_TOKEN) });
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
				return json({ error: "Search is unavailable right now. Please try again shortly." }, 502);
			}
		}

		return json({ error: "Not found" }, 404);
	},
} satisfies ExportedHandler<AppEnv>;
