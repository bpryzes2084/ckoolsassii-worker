// Hidden search keyword list: lets a search word (e.g. a nickname) find items by
// colorway words in their titles (e.g. "Carolina Blue"). Stored in D1 and edited
// from the admin page; shoppers never see it.

import type { SearchAlias } from "./search";

const MAX_TERMS = 1000;
const MAX_MATCHES = 10;
const MAX_LEN = 60;
const CACHE_MS = 60 * 1000;

let cache: { at: number; list: SearchAlias[] } | null = null;
let tableReady = false;

async function ensureTable(db: D1Database) {
	if (tableReady) return;
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS search_aliases (
				term TEXT PRIMARY KEY,
				matches TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		)
		.run();
	tableReady = true;
}

export async function loadAliases(db: D1Database | undefined): Promise<SearchAlias[]> {
	if (!db) return [];
	if (cache && Date.now() - cache.at < CACHE_MS) return cache.list;
	try {
		await ensureTable(db);
		const res = await db.prepare("SELECT term, matches FROM search_aliases ORDER BY term").all<{ term: string; matches: string }>();
		const list = (res.results || []).map((r) => ({ term: r.term, matches: safeList(r.matches) }));
		cache = { at: Date.now(), list };
		return list;
	} catch (err) {
		// The keyword list is a bonus; search must keep working without it.
		console.warn("search keywords unavailable:", (err as Error).message);
		return [];
	}
}

function safeList(raw: string): string[] {
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.map(String) : [];
	} catch {
		return [];
	}
}

function clean(s: unknown): string {
	return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
}

/** Replaces the whole list. Returns the saved, cleaned list. */
export async function saveAliases(db: D1Database, input: unknown): Promise<SearchAlias[]> {
	const rows = Array.isArray(input) ? input : [];
	if (rows.length > MAX_TERMS) throw new Error(`The keyword list is limited to ${MAX_TERMS} search words.`);
	const merged = new Map<string, Set<string>>();
	for (const row of rows as { term?: unknown; matches?: unknown }[]) {
		const term = clean(row?.term).toLowerCase();
		const raw = Array.isArray(row?.matches) ? row.matches : String(row?.matches ?? "").split(",");
		const matches = raw.map(clean).filter(Boolean).slice(0, MAX_MATCHES);
		if (!term || !matches.length) continue;
		const set = merged.get(term) || new Set<string>();
		matches.forEach((m) => set.add(m));
		merged.set(term, set);
	}
	await ensureTable(db);
	const now = new Date().toISOString();
	const stmts = [db.prepare("DELETE FROM search_aliases")];
	for (const [term, set] of merged) {
		stmts.push(db.prepare("INSERT INTO search_aliases (term, matches, updated_at) VALUES (?, ?, ?)").bind(term, JSON.stringify([...set]), now));
	}
	await db.batch(stmts);
	cache = null;
	return loadAliases(db);
}
