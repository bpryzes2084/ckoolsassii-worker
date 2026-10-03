-- Migration number: 0002 	 2026-10-03
-- One row per Square order that has (or is getting) a UPS label.
-- The worker also creates this table on first use if the migration hasn't run.
CREATE TABLE IF NOT EXISTS shipping_labels (
    order_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    tracking_number TEXT,
    service_code TEXT,
    weight_lb REAL,
    charge REAL,
    label_format TEXT,
    label_base64 TEXT,
    created_at TEXT NOT NULL,
    square_updated_at TEXT,
    emailed_at TEXT,
    last_error TEXT
);
