// Square checkout for cKool n saSSii.
//
// Builds a Square payment link from the cart. Item prices come from the Square
// catalog (only variation ids and quantities are sent), and the UPS shipping
// charge is re-quoted here rather than trusted from the browser.

import { itemNamesForVariations, squareFetch, type SquareEnv } from "./search";
import { estimateWeightLb, getRates, type UpsEnv } from "./shipping";

export interface CheckoutInput {
	items?: { variation_id?: string; qty?: number }[];
	shipping?: { service_code?: string; postal_code?: string; state?: string; city?: string };
	return_url?: string;
}

export class CheckoutError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

const ALLOWED_RETURN_HOSTS = ["ckoolsassii.biz", "www.ckoolsassii.biz"];

function safeReturnUrl(raw?: string): string {
	try {
		const u = new URL(raw || "");
		if (u.protocol === "https:" && ALLOWED_RETURN_HOSTS.includes(u.hostname)) {
			u.hash = "";
			u.searchParams.set("order", "complete");
			return u.toString();
		}
	} catch {
		/* fall through */
	}
	return "https://ckoolsassii.biz/?order=complete";
}

export async function createCheckout(env: SquareEnv & UpsEnv, input: CheckoutInput) {
	if (!env.SQUARE_LOCATION_ID) throw new CheckoutError("Checkout is not set up yet: SQUARE_LOCATION_ID is missing.", 503);

	const items = (input.items || [])
		.map((i) => ({ id: String(i?.variation_id || ""), qty: Math.floor(Number(i?.qty)) }))
		.filter((i) => i.id && i.qty > 0)
		.slice(0, 50);
	if (!items.length) throw new CheckoutError("Your cart is empty.");
	if (items.some((i) => i.qty > 99)) throw new CheckoutError("Quantities are limited to 99 per item.");

	const names = await itemNamesForVariations(env, items.map((i) => i.id));
	const unknown = items.filter((i) => !names.has(i.id));
	if (unknown.length) {
		throw new CheckoutError("Some items in your cart are no longer available. Remove them and try again.", 409);
	}

	const ship = input.shipping || {};
	const zip = String(ship.postal_code || "").trim();
	if (!zip || !ship.service_code) throw new CheckoutError("Choose a shipping option before checking out.");

	const weight = estimateWeightLb(items.flatMap((i) => Array(i.qty).fill(names.get(i.id) || "")));
	const rates = await getRates(env, { postal_code: zip, state: ship.state, city: ship.city }, weight);
	const rate = rates.find((r) => r.service_code === ship.service_code);
	if (!rate) throw new CheckoutError("That shipping option isn't available for this ZIP code. Please pick another.", 409);

	const body = {
		idempotency_key: crypto.randomUUID(),
		order: {
			location_id: env.SQUARE_LOCATION_ID,
			line_items: items.map((i) => ({ catalog_object_id: i.id, quantity: String(i.qty) })),
		},
		checkout_options: {
			redirect_url: safeReturnUrl(input.return_url),
			ask_for_shipping_address: true,
			shipping_fee: {
				name: rate.service,
				charge: { amount: Math.round(rate.amount * 100), currency: "USD" },
			},
		},
		pre_populated_data: {
			buyer_address: { postal_code: zip, country: "US" },
		},
	};

	const res = await squareFetch(env, "/v2/online-checkout/payment-links", {
		method: "POST",
		body: JSON.stringify(body),
	});
	const link = res.payment_link || {};
	if (!link.url) throw new CheckoutError("Square did not return a checkout link.", 502);
	return {
		checkoutUrl: link.url as string,
		order_id: (link.order_id as string) || null,
		shipping: { service: rate.service, amount: rate.amount },
	};
}
