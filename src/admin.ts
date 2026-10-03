// Order fulfilment for cKool n saSSii: list paid Square orders, buy UPS labels,
// and write tracking back to Square. Every endpoint here needs ADMIN_PASSWORD.

import { squareFetch, type SquareEnv } from "./search";
import { buyLabel, estimateWeightLb, SERVICE_NAMES, trackingUrl, type UpsEnv } from "./shipping";

export interface AdminEnv extends SquareEnv, UpsEnv {
	DB: D1Database;
	ADMIN_PASSWORD?: string;
	BREVO_API_KEY?: string; // optional: send our own "shipped" email through Brevo
	EMAIL_FROM?: string; // verified sender address in Brevo
	EMAIL_FROM_NAME?: string;
}

type Json = Record<string, any>;

export class AdminError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

// ---- auth ----

async function digest(s: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

export async function checkAdmin(request: Request, env: AdminEnv): Promise<void> {
	if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 8) {
		throw new AdminError("The label page is not set up yet: add an ADMIN_PASSWORD secret (8+ characters) to the worker.", 503);
	}
	const header = request.headers.get("Authorization") || "";
	const given = header.startsWith("Bearer ") ? header.slice(7) : "";
	const [a, b] = await Promise.all([digest(given), digest(env.ADMIN_PASSWORD)]);
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	if (diff !== 0 || !given) throw new AdminError("Wrong password.", 401);
}

// ---- label records (D1) ----

let tableReady = false;
async function ensureTable(env: AdminEnv) {
	if (tableReady) return;
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS shipping_labels (
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
		)`,
	).run();
	tableReady = true;
}

interface LabelRow {
	order_id: string;
	status: "pending" | "done";
	tracking_number: string | null;
	service_code: string | null;
	weight_lb: number | null;
	charge: number | null;
	label_format: string | null;
	label_base64: string | null;
	created_at: string;
	square_updated_at: string | null;
	emailed_at: string | null;
	last_error: string | null;
}

async function getRow(env: AdminEnv, orderId: string): Promise<LabelRow | null> {
	await ensureTable(env);
	return (await env.DB.prepare("SELECT * FROM shipping_labels WHERE order_id = ?").bind(orderId).first<LabelRow>()) || null;
}

// ---- Square orders ----

function money(m?: Json | null): number | null {
	return m && typeof m.amount === "number" ? m.amount / 100 : null;
}

function serviceCodeFromName(name?: string): string | null {
	if (!name) return null;
	const n = name.toLowerCase();
	const hit = Object.entries(SERVICE_NAMES).find(([, label]) => label.toLowerCase() === n);
	return hit ? hit[0] : null;
}

function summarize(order: Json, row: LabelRow | null) {
	const f = (order.fulfillments || []).find((x: Json) => x.type === "SHIPMENT") || {};
	const sd = f.shipment_details || {};
	const r = sd.recipient || {};
	const a = r.address || {};
	const shipCharge = (order.service_charges || []).find((c: Json) => serviceCodeFromName(c.name)) || (order.service_charges || [])[0];
	const items = (order.line_items || []).map((li: Json) => ({
		name: li.name || "",
		variation: li.variation_name || "",
		qty: Number(li.quantity || 1),
	}));
	return {
		id: order.id,
		number: String(order.id || "").slice(-6).toUpperCase(),
		created_at: order.created_at,
		state: order.state,
		fulfillment_state: f.state || null,
		shipped: f.state === "COMPLETED",
		customer: {
			name: r.display_name || "",
			email: r.email_address || "",
			phone: r.phone_number || "",
		},
		address: {
			line1: a.address_line_1 || "",
			line2: a.address_line_2 || "",
			city: a.locality || "",
			state: a.administrative_district_level_1 || "",
			postal_code: a.postal_code || "",
			country: a.country || "US",
		},
		items,
		total: money(order.total_money),
		shipping_paid: shipCharge ? { name: shipCharge.name, amount: money(shipCharge.amount_money) } : null,
		service_code: serviceCodeFromName(shipCharge?.name) || "03",
		weight_lb: estimateWeightLb(items.flatMap((i: Json) => Array(Math.min(99, i.qty)).fill(`${i.name} ${i.variation}`))),
		square_tracking: sd.tracking_number || null,
		label: row && row.status === "done"
			? {
					tracking_number: row.tracking_number,
					tracking_url: row.tracking_number ? trackingUrl(row.tracking_number) : null,
					charge: row.charge,
					created_at: row.created_at,
					square_updated: Boolean(row.square_updated_at),
					emailed: Boolean(row.emailed_at),
					last_error: row.last_error,
				}
			: null,
	};
}

async function getOrder(env: AdminEnv, orderId: string): Promise<Json> {
	if (!/^[A-Za-z0-9_-]{6,64}$/.test(orderId)) throw new AdminError("Unknown order.", 404);
	const data = await squareFetch(env, `/v2/orders/${orderId}`);
	const order = data.order;
	if (!order) throw new AdminError("Unknown order.", 404);
	if (env.SQUARE_LOCATION_ID && order.location_id !== env.SQUARE_LOCATION_ID) throw new AdminError("Unknown order.", 404);
	return order;
}

function isPaid(order: Json): boolean {
	return (order.tenders || []).length > 0 && (order.net_amount_due_money?.amount ?? 0) === 0;
}

export async function listOrders(env: AdminEnv) {
	if (!env.SQUARE_LOCATION_ID) throw new AdminError("SQUARE_LOCATION_ID is missing.", 503);
	await ensureTable(env);
	const since = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
	const data = await squareFetch(env, "/v2/orders/search", {
		method: "POST",
		body: JSON.stringify({
			location_ids: [env.SQUARE_LOCATION_ID],
			limit: 100,
			query: {
				filter: {
					state_filter: { states: ["OPEN", "COMPLETED"] },
					fulfillment_filter: { fulfillment_types: ["SHIPMENT"] },
					date_time_filter: { created_at: { start_at: since } },
				},
				sort: { sort_field: "CREATED_AT", sort_order: "DESC" },
			},
		}),
	});
	const orders: Json[] = (data.orders || []).filter(isPaid);
	const ids = orders.map((o) => o.id);
	const rows = new Map<string, LabelRow>();
	if (ids.length) {
		const placeholders = ids.map(() => "?").join(",");
		const res = await env.DB.prepare(`SELECT * FROM shipping_labels WHERE order_id IN (${placeholders})`).bind(...ids).all<LabelRow>();
		for (const r of res.results || []) rows.set(r.order_id, r);
	}
	const list = orders.map((o) => summarize(o, rows.get(o.id) || null));
	return {
		to_ship: list.filter((o) => !o.shipped),
		shipped: list.filter((o) => o.shipped).slice(0, 25),
	};
}

// ---- buy label ----

export async function createLabel(env: AdminEnv, input: { order_id?: string; service_code?: string; weight_lb?: number }) {
	const orderId = String(input.order_id || "");
	const order = await getOrder(env, orderId);
	if (!isPaid(order)) throw new AdminError("This order hasn't been paid yet.", 409);
	await ensureTable(env);

	const existing = await getRow(env, orderId);
	if (existing?.status === "done") {
		// Never buy twice: return the label we already have.
		return { already_existed: true, ...(await finishShipment(env, orderId)) };
	}
	if (existing?.status === "pending" && Date.now() - Date.parse(existing.created_at) < 2 * 60 * 1000) {
		throw new AdminError("A label for this order is already being created. Wait a moment and refresh.", 409);
	}

	const summary = summarize(order, null);
	const a = summary.address;
	if (!a.line1 || !a.city || !a.state || !a.postal_code) {
		throw new AdminError("This order has no complete shipping address in Square.", 409);
	}
	const serviceCode = String(input.service_code || summary.service_code);
	if (!SERVICE_NAMES[serviceCode]) throw new AdminError("Unknown UPS service.");
	const weight = Number(input.weight_lb) > 0 ? Math.min(150, Number(input.weight_lb)) : summary.weight_lb;

	// Claim the order before calling UPS so a double click can't buy two labels.
	const now = new Date().toISOString();
	const claim = await env.DB.prepare(
		`INSERT INTO shipping_labels (order_id, status, created_at) VALUES (?, 'pending', ?)
		 ON CONFLICT(order_id) DO UPDATE SET created_at = excluded.created_at
		 WHERE shipping_labels.status = 'pending' AND shipping_labels.created_at < ?`,
	)
		.bind(orderId, now, new Date(Date.now() - 2 * 60 * 1000).toISOString())
		.run();
	if (!claim.meta.changes) throw new AdminError("A label for this order is already being created. Wait a moment and refresh.", 409);

	let label;
	try {
		label = await buyLabel(env, {
			service_code: serviceCode,
			weight_lb: weight,
			reference: `Order ${summary.number}`,
			to: { name: summary.customer.name, phone: summary.customer.phone, ...a },
		});
	} catch (err) {
		await env.DB.prepare("DELETE FROM shipping_labels WHERE order_id = ? AND status = 'pending'").bind(orderId).run();
		throw err;
	}

	await env.DB.prepare(
		`UPDATE shipping_labels SET status = 'done', tracking_number = ?, service_code = ?, weight_lb = ?, charge = ?,
		 label_format = ?, label_base64 = ?, created_at = ? WHERE order_id = ?`,
	)
		.bind(label.tracking_number, serviceCode, weight, label.charge, label.label_format, label.label_base64, now, orderId)
		.run();

	return { already_existed: false, ...(await finishShipment(env, orderId)) };
}

// ---- tracking to Square + shipped email ----

async function sendShippedEmail(env: AdminEnv, order: Json, tracking: string) {
	const s = summarize(order, null);
	let email = s.customer.email;
	if (!email) {
		const paymentId = (order.tenders || [])[0]?.payment_id || (order.tenders || [])[0]?.id;
		if (paymentId) {
			const p = await squareFetch(env, `/v2/payments/${paymentId}`).catch(() => ({}) as Json);
			email = p.payment?.buyer_email_address || "";
		}
	}
	if (!email) throw new Error("No customer email on this order.");

	const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
	const itemsHtml = s.items.map((i: Json) => `<li>${esc(i.name)}${i.variation ? ` (${esc(i.variation)})` : ""} &times; ${i.qty}</li>`).join("");
	const url = trackingUrl(tracking);
	const res = await fetch("https://api.brevo.com/v3/smtp/email", {
		method: "POST",
		headers: { "api-key": env.BREVO_API_KEY as string, "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			sender: { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME || "cKool n saSSii" },
			to: [{ email, name: s.customer.name || undefined }],
			subject: `Your cKool n saSSii order ${s.number} has shipped`,
			htmlContent: `<div style="font-family:Arial,sans-serif;color:#0f0f0f;max-width:520px">
				<h2 style="color:#1b2a4a">Your order is on its way</h2>
				<p>Hi ${esc(s.customer.name || "there")}, your order <strong>${s.number}</strong> shipped today with UPS.</p>
				<ul>${itemsHtml}</ul>
				<p><strong>Tracking number:</strong> ${esc(tracking)}</p>
				<p><a href="${url}" style="display:inline-block;background:#1b2a4a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Track your package</a></p>
				<p style="color:#6b6b6b;font-size:13px">Thanks for shopping with cKool n saSSii.</p>
			</div>`,
		}),
	});
	if (!res.ok) throw new Error(`Email failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

/** Writes tracking into the Square order, marks it shipped, and sends the email if set up. Safe to repeat. */
export async function finishShipment(env: AdminEnv, orderId: string) {
	const row = await getRow(env, orderId);
	if (!row || row.status !== "done" || !row.tracking_number) throw new AdminError("No label exists for this order yet.", 404);
	const tracking = row.tracking_number;
	const errors: string[] = [];
	let order = await getOrder(env, orderId);

	if (!row.square_updated_at) {
		const f = (order.fulfillments || []).find((x: Json) => x.type === "SHIPMENT");
		if (!f) {
			errors.push("Square order has no shipment to update.");
		} else {
			const details = { carrier: "UPS", tracking_number: tracking, tracking_url: trackingUrl(tracking) };
			const update = (fulfillment: Json) =>
				squareFetch(env, `/v2/orders/${orderId}`, {
					method: "PUT",
					body: JSON.stringify({
						idempotency_key: crypto.randomUUID(),
						order: { location_id: order.location_id, version: order.version, fulfillments: [{ uid: f.uid, ...fulfillment }] },
					}),
				});
			try {
				const res = await update(f.state === "COMPLETED" ? { shipment_details: details } : { state: "COMPLETED", shipment_details: details });
				order = res.order || order;
				await env.DB.prepare("UPDATE shipping_labels SET square_updated_at = ?, last_error = NULL WHERE order_id = ?")
					.bind(new Date().toISOString(), orderId)
					.run();
				row.square_updated_at = "now";
			} catch (err) {
				errors.push(`Square: ${(err as Error).message}`);
			}
		}
	}

	if (env.BREVO_API_KEY && env.EMAIL_FROM && !row.emailed_at && row.square_updated_at) {
		try {
			await sendShippedEmail(env, order, tracking);
			await env.DB.prepare("UPDATE shipping_labels SET emailed_at = ? WHERE order_id = ?").bind(new Date().toISOString(), orderId).run();
			row.emailed_at = "now";
		} catch (err) {
			errors.push(`Email: ${(err as Error).message}`);
		}
	}

	if (errors.length) {
		await env.DB.prepare("UPDATE shipping_labels SET last_error = ? WHERE order_id = ?").bind(errors.join(" | "), orderId).run();
	}

	return {
		order_id: orderId,
		tracking_number: tracking,
		tracking_url: trackingUrl(tracking),
		charge: row.charge,
		label_format: row.label_format,
		label_base64: row.label_base64,
		square_updated: Boolean(row.square_updated_at),
		emailed: Boolean(row.emailed_at),
		email_enabled: Boolean(env.BREVO_API_KEY && env.EMAIL_FROM),
		errors,
	};
}

export async function getLabel(env: AdminEnv, orderId: string) {
	const row = await getRow(env, orderId);
	if (!row || row.status !== "done") throw new AdminError("No label exists for this order yet.", 404);
	return {
		order_id: orderId,
		tracking_number: row.tracking_number,
		tracking_url: row.tracking_number ? trackingUrl(row.tracking_number) : null,
		label_format: row.label_format,
		label_base64: row.label_base64,
	};
}
