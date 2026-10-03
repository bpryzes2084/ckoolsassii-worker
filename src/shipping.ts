// UPS live shipping rates for cKool n saSSii.
//
// Uses the UPS OAuth (client credentials) + Rating API "Shop" request, which
// returns a price for every UPS service available between the ship-from
// address and the customer's address.

export interface UpsEnv {
	UPS_CLIENT_ID?: string;
	UPS_CLIENT_SECRET?: string;
	UPS_ACCOUNT_NUMBER?: string; // 6-character UPS shipper number; enables your negotiated rates
	UPS_ENV?: string; // "production" (default) or "test"
	SHIP_FROM_NAME?: string;
	SHIP_FROM_ADDRESS?: string;
	SHIP_FROM_CITY?: string;
	SHIP_FROM_STATE?: string; // 2-letter code, e.g. "CO"
	SHIP_FROM_ZIP?: string;
}

export interface ShipTo {
	name?: string;
	line1?: string;
	line2?: string;
	city?: string;
	state?: string;
	postal_code: string;
	country?: string; // defaults to US
	residential?: boolean; // defaults to true
}

export interface Rate {
	service_code: string;
	service: string;
	amount: number; // dollars
	currency: string;
	negotiated: boolean;
	business_days: number | null;
}

const RATING_VERSION = "v2409";

const SERVICE_NAMES: Record<string, string> = {
	"03": "UPS Ground",
	"12": "UPS 3 Day Select",
	"02": "UPS 2nd Day Air",
	"59": "UPS 2nd Day Air A.M.",
	"13": "UPS Next Day Air Saver",
	"01": "UPS Next Day Air",
	"14": "UPS Next Day Air Early",
	"93": "UPS Ground Saver",
	"92": "UPS SurePost",
	"75": "UPS Heavy Goods",
};

// Rough packed weights (lb) by product type, matched against the item name.
// The first matching rule wins; anything unmatched uses DEFAULT_ITEM_LB.
const WEIGHT_RULES: [RegExp, number][] = [
	[/hood/i, 1.4],
	[/sweat\s*shirt|crew\s*neck/i, 1.2],
	[/long[\s-]*sleeve/i, 0.6],
	[/t[\s-]*shirt|\btee\b/i, 0.45],
	[/beanie|toque/i, 0.25],
	[/\bcap\b|\bhat\b|snapback|trucker/i, 0.35],
];
const DEFAULT_ITEM_LB = 0.75;
const PACKAGING_LB = 0.3;

export function estimateWeightLb(names: string[]): number {
	let total = PACKAGING_LB;
	for (const name of names) {
		const rule = WEIGHT_RULES.find(([re]) => re.test(name));
		total += rule ? rule[1] : DEFAULT_ITEM_LB;
	}
	return Math.max(0.5, Math.round(total * 10) / 10);
}

export function upsConfigured(env: UpsEnv): boolean {
	return Boolean(env.UPS_CLIENT_ID && env.UPS_CLIENT_SECRET);
}

export function missingShipFrom(env: UpsEnv): string[] {
	const need: [keyof UpsEnv, string][] = [
		["SHIP_FROM_ADDRESS", "SHIP_FROM_ADDRESS"],
		["SHIP_FROM_CITY", "SHIP_FROM_CITY"],
		["SHIP_FROM_STATE", "SHIP_FROM_STATE"],
		["SHIP_FROM_ZIP", "SHIP_FROM_ZIP"],
	];
	return need.filter(([k]) => !env[k]).map(([, label]) => label);
}

function upsBase(env: UpsEnv): string {
	return (env.UPS_ENV || "production").toLowerCase() === "test" ? "https://wwwcie.ups.com" : "https://onlinetools.ups.com";
}

let tokenCache: { token: string; expires: number; key: string } | null = null;

export async function getUpsToken(env: UpsEnv): Promise<string> {
	const key = `${upsBase(env)}|${env.UPS_CLIENT_ID}`;
	if (tokenCache && tokenCache.key === key && Date.now() < tokenCache.expires) return tokenCache.token;

	const res = await fetch(`${upsBase(env)}/security/v1/oauth/token`, {
		method: "POST",
		headers: {
			Authorization: "Basic " + btoa(`${env.UPS_CLIENT_ID}:${env.UPS_CLIENT_SECRET}`),
			"Content-Type": "application/x-www-form-urlencoded",
			...(env.UPS_ACCOUNT_NUMBER ? { "x-merchant-id": env.UPS_ACCOUNT_NUMBER } : {}),
		},
		body: "grant_type=client_credentials",
	});
	const body = (await res.json().catch(() => ({}))) as Record<string, any>;
	if (!res.ok || !body.access_token) {
		const detail = body.response?.errors?.[0]?.message || body.error_description || res.statusText;
		throw new Error(`UPS sign-in failed (${res.status}): ${detail}`);
	}
	const ttl = Number(body.expires_in || 3600) * 1000;
	tokenCache = { token: body.access_token, expires: Date.now() + ttl - 60_000, key };
	return body.access_token;
}

function address(lines: (string | undefined)[], city?: string, state?: string, zip?: string, country = "US") {
	return {
		AddressLine: lines.filter((l): l is string => Boolean(l && l.trim())).slice(0, 3),
		City: city || "",
		StateProvinceCode: (state || "").toUpperCase(),
		PostalCode: zip || "",
		CountryCode: country.toUpperCase(),
	};
}

export async function getRates(env: UpsEnv, to: ShipTo, weightLb: number): Promise<Rate[]> {
	const token = await getUpsToken(env);
	const from = address([env.SHIP_FROM_ADDRESS], env.SHIP_FROM_CITY, env.SHIP_FROM_STATE, env.SHIP_FROM_ZIP);
	const shipTo: Record<string, any> = {
		Name: to.name || "Customer",
		Address: address([to.line1, to.line2], to.city, to.state, to.postal_code, to.country || "US"),
	};
	if (to.residential !== false) shipTo.Address.ResidentialAddressIndicator = "";

	const shipment: Record<string, any> = {
		Shipper: {
			Name: env.SHIP_FROM_NAME || "cKool n saSSii",
			...(env.UPS_ACCOUNT_NUMBER ? { ShipperNumber: env.UPS_ACCOUNT_NUMBER } : {}),
			Address: from,
		},
		ShipFrom: { Name: env.SHIP_FROM_NAME || "cKool n saSSii", Address: from },
		ShipTo: shipTo,
		Package: [
			{
				PackagingType: { Code: "02", Description: "Package" },
				PackageWeight: { UnitOfMeasurement: { Code: "LBS" }, Weight: String(weightLb) },
			},
		],
	};
	if (env.UPS_ACCOUNT_NUMBER) shipment.ShipmentRatingOptions = { NegotiatedRatesIndicator: "" };

	const res = await fetch(`${upsBase(env)}/api/rating/${RATING_VERSION}/Shop`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			transId: crypto.randomUUID().replace(/-/g, "").slice(0, 32),
			transactionSrc: "ckoolsassii",
		},
		body: JSON.stringify({ RateRequest: { Request: { RequestOption: "Shop" }, Shipment: shipment } }),
	});
	const body = (await res.json().catch(() => ({}))) as Record<string, any>;
	if (!res.ok) {
		const detail = body.response?.errors?.map((e: any) => `${e.code}: ${e.message}`).join("; ") || res.statusText;
		throw new Error(`UPS rates failed (${res.status}): ${detail}`);
	}

	const rated = body.RateResponse?.RatedShipment;
	const list: any[] = Array.isArray(rated) ? rated : rated ? [rated] : [];
	return list
		.map((r) => {
			const code = String(r.Service?.Code || "");
			const neg = r.NegotiatedRateCharges?.TotalCharge;
			const charge = neg?.MonetaryValue ? neg : r.TotalCharges;
			const days = Number(r.GuaranteedDelivery?.BusinessDaysInTransit);
			return {
				service_code: code,
				service: SERVICE_NAMES[code] || `UPS service ${code}`,
				amount: Number(charge?.MonetaryValue || 0),
				currency: charge?.CurrencyCode || "USD",
				negotiated: Boolean(neg?.MonetaryValue),
				business_days: Number.isFinite(days) && days > 0 ? days : null,
			};
		})
		.filter((r) => r.amount > 0)
		.sort((a, b) => a.amount - b.amount);
}
