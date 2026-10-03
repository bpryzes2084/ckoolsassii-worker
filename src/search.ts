// Square catalog search for cKool n saSSii.
//
// Pulls the whole catalog (items, images, categories) from Square, keeps it in
// memory for a few minutes, and matches the shopper's words against each item's
// name, description, category names and variation names. Matching is done here
// rather than with Square's text_query so that "hoodies", "hoodie", "t-shirt",
// "tshirt" and "tee" all find the same products.

export interface SquareEnv {
	SQUARE_ACCESS_TOKEN: string;
	SQUARE_ENV?: string; // "production" (default) or "sandbox"
	SQUARE_LOCATION_ID?: string; // optional: limits results and stock checks to one location
}

const SQUARE_VERSION = "2026-09-16";
const CATALOG_TTL_MS = 5 * 60 * 1000;
const MAX_RESULTS = 60;

// Extra words a search term also finds. One-directional: "hat" finds caps and
// beanies, but "cap" does not find beanies.
const ALSO_MATCHES: Record<string, string[]> = {
	tshirt: ["tee"],
	tee: ["tshirt"],
	shirt: ["tshirt", "tee"],
	hoodie: ["hoody", "hooded"],
	hoody: ["hoodie", "hooded"],
	sweatshirt: ["crewneck"],
	crewneck: ["sweatshirt"],
	hat: ["cap", "beanie", "snapback", "trucker", "toque"],
	cap: ["snapback", "trucker"],
	beanie: ["toque"],
	color: ["colour", "colorway"],
	colour: ["color", "colorway"],
	accessory: ["accessories", "bag", "tote", "keychain", "sticker"],
};

type Json = Record<string, any>;

interface CatalogCache {
	at: number;
	items: Json[];
	images: Map<string, string>;
	categories: Map<string, string>;
}

let cache: CatalogCache | null = null;

function apiBase(env: SquareEnv): string {
	return (env.SQUARE_ENV || "production").toLowerCase() === "sandbox"
		? "https://connect.squareupsandbox.com"
		: "https://connect.squareup.com";
}

async function squareFetch(env: SquareEnv, path: string, init: RequestInit = {}): Promise<Json> {
	const res = await fetch(apiBase(env) + path, {
		...init,
		headers: {
			Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
			"Square-Version": SQUARE_VERSION,
			"Content-Type": "application/json",
			...(init.headers || {}),
		},
	});
	const body = (await res.json().catch(() => ({}))) as Json;
	if (!res.ok) {
		const detail = body.errors?.[0]?.detail || body.errors?.[0]?.code || res.statusText;
		throw new Error(`Square ${path} failed (${res.status}): ${detail}`);
	}
	return body;
}

async function loadCatalog(env: SquareEnv): Promise<CatalogCache> {
	if (cache && Date.now() - cache.at < CATALOG_TTL_MS) return cache;

	const items: Json[] = [];
	const images = new Map<string, string>();
	const categories = new Map<string, string>();
	let cursor: string | undefined;

	do {
		const qs = new URLSearchParams({ types: "ITEM,IMAGE,CATEGORY" });
		if (cursor) qs.set("cursor", cursor);
		const page = await squareFetch(env, `/v2/catalog/list?${qs}`);
		for (const obj of page.objects || []) {
			if (obj.is_deleted) continue;
			if (obj.type === "ITEM") items.push(obj);
			else if (obj.type === "IMAGE" && obj.image_data?.url) images.set(obj.id, obj.image_data.url);
			else if (obj.type === "CATEGORY" && obj.category_data?.name) categories.set(obj.id, obj.category_data.name);
		}
		cursor = page.cursor;
	} while (cursor);

	cache = { at: Date.now(), items, images, categories };
	return cache;
}

/** Lists the account's locations; used by /api/health?square=1 to confirm the token works. */
export async function checkSquare(env: SquareEnv): Promise<{ id: string; name: string; status: string }[]> {
	const data = await squareFetch(env, "/v2/locations");
	return (data.locations || []).map((l: Json) => ({ id: l.id, name: l.name, status: l.status }));
}

// ---- text matching (exported for testing) ----

export function normalize(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/t[\s-]?shirts?\b/g, "tshirt")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/** Singular/plural forms of a word, so "beanies", "hoodies", "caps" line up with "beanie", "hoodie", "cap". */
function forms(word: string): string[] {
	const out = new Set([word]);
	if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) out.add(word.slice(0, -1));
	if (word.length > 4 && word.endsWith("ies")) out.add(word.slice(0, -3) + "y");
	if (word.length > 4 && /(ches|shes|xes|sses)$/.test(word)) out.add(word.slice(0, -2));
	return [...out];
}

function variantsOf(word: string): string[] {
	const out = new Set(forms(word));
	for (const f of [...out]) for (const extra of ALSO_MATCHES[f] || []) out.add(extra);
	return [...out];
}

/** Words in the query, each expanded to the forms that count as a match. */
export function parseQuery(q: string): string[][] {
	return normalize(q)
		.split(" ")
		.filter((w) => w.length > 0)
		.map(variantsOf);
}

/** Score an item's text against the query. 0 = no match. Every query word must match. */
export function scoreText(fields: { name: string; rest: string }, query: string[][]): number {
	if (!query.length) return 1;
	const name = normalize(fields.name);
	const rest = normalize(fields.rest);
	const nameWords = name.split(" ").flatMap(forms);
	const restWords = rest.split(" ").flatMap(forms);
	let score = 0;
	for (const forms of query) {
		const inName = forms.some((f) => nameWords.some((w) => w === f || w.startsWith(f)));
		const inRest = forms.some((f) => restWords.some((w) => w === f || w.startsWith(f)));
		if (inName) score += 3;
		else if (inRest) score += 1;
		else return 0;
	}
	return score;
}

// ---- search ----

function itemText(item: Json, categories: Map<string, string>) {
	const d = item.item_data || {};
	const catIds: string[] = [
		...(d.categories || []).map((c: Json) => c.id),
		d.category_id,
		d.reporting_category?.id,
	].filter(Boolean);
	const variationNames = (d.variations || []).map((v: Json) => v.item_variation_data?.name || "");
	return {
		name: d.name || "",
		rest: [d.description_plaintext || d.description || "", ...catIds.map((id) => categories.get(id) || ""), ...variationNames].join(" "),
	};
}

function availableAtLocation(obj: Json, locationId?: string): boolean {
	if (!locationId) return true;
	if (obj.present_at_all_locations) return !(obj.absent_at_location_ids || []).includes(locationId);
	return (obj.present_at_location_ids || []).includes(locationId);
}

async function stockByVariation(env: SquareEnv, variationIds: string[]): Promise<Map<string, number>> {
	const qty = new Map<string, number>();
	for (let i = 0; i < variationIds.length; i += 500) {
		let cursor: string | undefined;
		do {
			const body: Json = {
				catalog_object_ids: variationIds.slice(i, i + 500),
				states: ["IN_STOCK"],
				limit: 1000,
			};
			if (env.SQUARE_LOCATION_ID) body.location_ids = [env.SQUARE_LOCATION_ID];
			if (cursor) body.cursor = cursor;
			const page = await squareFetch(env, "/v2/inventory/counts/batch-retrieve", {
				method: "POST",
				body: JSON.stringify(body),
			});
			for (const c of page.counts || []) {
				qty.set(c.catalog_object_id, (qty.get(c.catalog_object_id) || 0) + Number(c.quantity || 0));
			}
			cursor = page.cursor;
		} while (cursor);
	}
	return qty;
}

function isTracked(variation: Json, locationId?: string): { tracked: boolean; markedSoldOut: boolean } {
	const v = variation.item_variation_data || {};
	const override = (v.location_overrides || []).find((o: Json) => !locationId || o.location_id === locationId);
	return {
		tracked: Boolean(override?.track_inventory ?? v.track_inventory),
		markedSoldOut: Boolean(override?.sold_out),
	};
}

export async function searchCatalog(env: SquareEnv, q: string): Promise<Json> {
	const catalog = await loadCatalog(env);
	const query = parseQuery(q);
	const loc = env.SQUARE_LOCATION_ID || undefined;

	const matches = catalog.items
		.filter((it) => !it.item_data?.is_archived)
		.filter((it) => availableAtLocation(it, loc))
		.map((it) => ({ it, score: scoreText(itemText(it, catalog.categories), query) }))
		.filter((m) => m.score > 0)
		.sort((a, b) => b.score - a.score || String(a.it.item_data?.name).localeCompare(String(b.it.item_data?.name)))
		.slice(0, MAX_RESULTS)
		.map((m) => m.it);

	// Stock levels: a failure here (e.g. token without INVENTORY_READ) should not break search.
	const variationIds = matches.flatMap((it) =>
		(it.item_data?.variations || []).filter((v: Json) => availableAtLocation(v, loc)).map((v: Json) => v.id),
	);
	let stock: Map<string, number> | null = null;
	if (variationIds.length) {
		try {
			stock = await stockByVariation(env, variationIds);
		} catch (err) {
			console.warn("inventory lookup skipped:", (err as Error).message);
		}
	}

	const objects = matches.map((it) => {
		const d = it.item_data || {};
		const variations = (d.variations || [])
			.filter((v: Json) => availableAtLocation(v, loc))
			.map((v: Json) => {
				const { tracked, markedSoldOut } = isTracked(v, loc);
				const qty = stock ? stock.get(v.id) ?? 0 : null;
				const soldOut = markedSoldOut || (tracked && stock !== null && (qty ?? 0) <= 0);
				return {
					id: v.id,
					item_variation_data: {
						name: v.item_variation_data?.name || "",
						price_money: v.item_variation_data?.price_money || null,
					},
					in_stock: tracked && qty !== null ? qty : null,
					sold_out: soldOut,
				};
			});
		const imageId = (d.image_ids || [])[0];
		return {
			type: "ITEM",
			id: it.id,
			image_url: (imageId && catalog.images.get(imageId)) || "",
			sold_out: variations.length > 0 && variations.every((v: Json) => v.sold_out),
			item_data: {
				name: d.name || "",
				description: d.description_plaintext || d.description || "",
				categories: (d.categories || []).map((c: Json) => catalog.categories.get(c.id)).filter(Boolean),
				variations,
			},
		};
	});

	return { query: q, count: objects.length, objects };
}
