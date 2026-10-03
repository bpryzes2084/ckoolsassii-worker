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
	SHIP_FROM_PHONE?: string; // required by UPS to buy labels
	UPS_SERVICES?: string; // services offered to shoppers, comma-separated UPS codes; default "03" (Ground only)
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

export const SERVICE_NAMES: Record<string, string> = {
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

export function upsBase(env: UpsEnv): string {
	return (env.UPS_ENV || "production").toLowerCase() === "test" ? "https://wwwcie.ups.com" : "https://onlinetools.ups.com";
}

let tokenCache: { token: string; expires: number; key: string } | null = null;

export async function getUpsToken(env: UpsEnv): Promise<string> {
	const id = (env.UPS_CLIENT_ID || "").trim();
	const secret = (env.UPS_CLIENT_SECRET || "").trim();
	const key = `${upsBase(env)}|${id}`;
	if (tokenCache && tokenCache.key === key && Date.now() < tokenCache.expires) return tokenCache.token;

	const url = `${upsBase(env)}/security/v1/oauth/token`;
	// UPS documents Basic auth; some UPS apps only accept the credentials in the form body.
	const attempts: { headers: Record<string, string>; body: string }[] = [
		{
			headers: { Authorization: "Basic " + btoa(`${id}:${secret}`) },
			body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
		},
		{
			headers: {},
			body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }).toString(),
		},
	];

	let lastError = "";
	for (const attempt of attempts) {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...attempt.headers },
			body: attempt.body,
		});
		const text = await res.text();
		let body: Record<string, any> = {};
		try {
			body = JSON.parse(text);
		} catch {
			/* non-JSON error page */
		}
		if (res.ok && body.access_token) {
			const ttl = Number(body.expires_in || 3600) * 1000;
			tokenCache = { token: body.access_token, expires: Date.now() + ttl - 60_000, key };
			return body.access_token;
		}
		const err = body.response?.errors?.[0];
		lastError = `(${res.status}) ${err ? `${err.code}: ${err.message}` : body.error_description || body.error || text.slice(0, 200) || res.statusText}`;
	}
	throw new Error(`UPS sign-in failed ${lastError}. Client ID is ${id.length} characters, secret is ${secret.length} characters.`);
}

export function address(lines: (string | undefined)[], city?: string, state?: string, zip?: string, country = "US") {
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

	const offered = (env.UPS_SERVICES || "03").split(",").map((c) => c.trim()).filter(Boolean);
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
		.filter((r) => r.amount > 0 && offered.includes(r.service_code))
		.sort((a, b) => a.amount - b.amount);
}

// ---- labels ----

export interface LabelRequest {
	service_code: string;
	weight_lb: number;
	reference?: string; // shows on the label, e.g. the order number
	to: {
		name: string;
		phone?: string;
		line1: string;
		line2?: string;
		city: string;
		state: string;
		postal_code: string;
		country?: string;
		residential?: boolean;
	};
}

export interface LabelResult {
	tracking_number: string;
	label_format: string;
	label_base64: string;
	charge: number | null;
}

function digits(s?: string): string {
	return (s || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
}

export async function buyLabel(env: UpsEnv, req: LabelRequest): Promise<LabelResult> {
	if (!env.UPS_ACCOUNT_NUMBER) throw new Error("UPS_ACCOUNT_NUMBER is required to buy labels.");
	const shipperPhone = digits(env.SHIP_FROM_PHONE);
	if (shipperPhone.length < 10) throw new Error("SHIP_FROM_PHONE (10-digit phone number) is required to buy labels.");

	const token = await getUpsToken(env);
	const name = (env.SHIP_FROM_NAME || "cKool n saSSii").slice(0, 35);
	const from = address([env.SHIP_FROM_ADDRESS], env.SHIP_FROM_CITY, env.SHIP_FROM_STATE, env.SHIP_FROM_ZIP);
	const toAddr: Record<string, any> = address(
		[req.to.line1, req.to.line2],
		req.to.city,
		req.to.state,
		req.to.postal_code,
		req.to.country || "US",
	);
	if (req.to.residential !== false) toAddr.ResidentialAddressIndicator = "";
	const toPhone = digits(req.to.phone);

	const pkg: Record<string, any> = {
		Packaging: { Code: "02", Description: "Package" },
		PackageWeight: { UnitOfMeasurement: { Code: "LBS" }, Weight: String(Math.max(0.1, req.weight_lb)) },
	};
	if (req.reference) pkg.ReferenceNumber = { Value: req.reference.slice(0, 35) };

	const shipment = {
		ShipmentRequest: {
			Request: { RequestOption: "nonvalidate", TransactionReference: { CustomerContext: (req.reference || "").slice(0, 512) } },
			Shipment: {
				Description: "Apparel",
				Shipper: {
					Name: name,
					AttentionName: name,
					Phone: { Number: shipperPhone },
					ShipperNumber: env.UPS_ACCOUNT_NUMBER.trim(),
					Address: from,
				},
				ShipFrom: { Name: name, AttentionName: name, Phone: { Number: shipperPhone }, Address: from },
				ShipTo: {
					Name: req.to.name.slice(0, 35) || "Customer",
					AttentionName: req.to.name.slice(0, 35) || "Customer",
					...(toPhone.length >= 10 ? { Phone: { Number: toPhone } } : {}),
					Address: toAddr,
				},
				PaymentInformation: {
					ShipmentCharge: { Type: "01", BillShipper: { AccountNumber: env.UPS_ACCOUNT_NUMBER.trim() } },
				},
				Service: { Code: req.service_code, Description: SERVICE_NAMES[req.service_code] || "" },
				ShipmentRatingOptions: { NegotiatedRatesIndicator: "" },
				Package: pkg,
			},
			LabelSpecification: {
				LabelImageFormat: { Code: "GIF" },
				LabelStockSize: { Height: "6", Width: "4" },
			},
		},
	};

	const res = await fetch(`${upsBase(env)}/api/shipments/v2409/ship`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			transId: crypto.randomUUID().replace(/-/g, "").slice(0, 32),
			transactionSrc: "ckoolsassii",
		},
		body: JSON.stringify(shipment),
	});
	const body = (await res.json().catch(() => ({}))) as Record<string, any>;
	if (!res.ok) {
		const detail = body.response?.errors?.map((e: any) => `${e.code}: ${e.message}`).join("; ") || res.statusText;
		throw new Error(`UPS label failed (${res.status}): ${detail}`);
	}
	const results = body.ShipmentResponse?.ShipmentResults || {};
	const pkgResults = Array.isArray(results.PackageResults) ? results.PackageResults[0] : results.PackageResults || {};
	const tracking = pkgResults.TrackingNumber || results.ShipmentIdentificationNumber;
	const image = pkgResults.ShippingLabel?.GraphicImage || pkgResults.LabelImage?.GraphicImage;
	if (!tracking || !image) throw new Error("UPS created the shipment but returned no tracking number or label image.");
	const neg = results.NegotiatedRateCharges?.TotalCharge?.MonetaryValue;
	const total = results.ShipmentCharges?.TotalCharges?.MonetaryValue;
	return {
		tracking_number: String(tracking),
		label_format: "GIF",
		label_base64: String(image),
		charge: neg ? Number(neg) : total ? Number(total) : null,
	};
}

export function trackingUrl(tracking: string): string {
	return `https://www.ups.com/track?loc=en_US&tracknum=${encodeURIComponent(tracking)}`;
}
