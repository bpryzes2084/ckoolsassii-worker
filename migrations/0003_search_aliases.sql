-- Migration number: 0003 	 2026-10-03
-- Hidden search keyword list edited on admin.html. The worker also creates it on first use.
CREATE TABLE IF NOT EXISTS search_aliases (
    term TEXT PRIMARY KEY,
    matches TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
