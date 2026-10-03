# ckoolsassii-worker

Cloudflare Worker that powers the search box on ckoolsassii.biz. It reads the
Square catalog and returns matching products with prices, images, sizes and
stock status.

## Endpoints

| Path | What it does |
| --- | --- |
| `GET /api/search?q=hoodie` | Products whose name, description, category or size matches every word in `q`. Handles plurals and common alternatives (tee / t-shirt, hat → caps and beanies, crewneck / sweatshirt). Empty `q` returns everything. |
| `POST /api/shipping-rates` | Live UPS rates for the cart. Body: `{ "address": { "postal_code": "90001", "line1": "…", "city": "…", "state": "CA" }, "items": [{ "variation_id": "…", "qty": 2 }] }`. Returns `{ weight_lb, rates: [{ service, amount, business_days, … }] }`, cheapest first. |
| `POST /api/create-checkout` | Creates a Square payment link. Body: `{ "items": [{ "variation_id": "…", "qty": 1 }], "shipping": { "service_code": "03", "postal_code": "90001" }, "return_url": "https://ckoolsassii.biz/" }`. Prices come from the Square catalog and the UPS charge is re-quoted on the server, so the browser can't change either. Returns `{ checkoutUrl, order_id, shipping }`. Square collects the shipping address and sends the buyer back to `return_url?order=complete`. Requires `SQUARE_LOCATION_ID`. |
| `GET /api/admin/orders` | **Password required.** Paid shipment orders from the last 60 days, split into `to_ship` and `shipped`. |
| `POST /api/admin/label` | **Password required.** `{ order_id, service_code?, weight_lb? }`. Buys a UPS label, saves it, writes tracking to the Square order, marks it shipped, and sends the shipped email if Brevo is set up. Never buys twice for the same order. |
| `GET /api/admin/label?order_id=` | **Password required.** The saved label (base64 GIF) for reprinting. |
| `POST /api/admin/finish` | **Password required.** `{ order_id }`. Retries the Square update and email if they failed. |
| `GET /api/health` | Shows which settings are present. Add `?square=1` to test the Square token, or `?ups=1` to test the UPS credentials. |

Both paths also work without the `/api` prefix, for example on the workers.dev address.

Response shape (what `index.html` reads):

```json
{
  "query": "hoodie",
  "count": 1,
  "objects": [{
    "type": "ITEM",
    "id": "…",
    "image_url": "https://…",
    "sold_out": false,
    "item_data": {
      "name": "Anchor Pullover Hoodie",
      "description": "…",
      "categories": ["Hoodies"],
      "variations": [
        { "id": "…", "item_variation_data": { "name": "Medium", "price_money": { "amount": 4500, "currency": "USD" } },
          "in_stock": 4, "sold_out": false }
      ]
    }
  }]
}
```

`in_stock` is `null` for sizes where Square isn't tracking inventory. Those sizes are always treated as available.

## Setup

1. **Square access token.** In the Square Developer Dashboard, open your app, go to **Credentials**, and copy the **Production access token**. It needs `ITEMS_READ` and `INVENTORY_READ`.
2. **Save it as a secret** (never in `wrangler.json`):
   ```bash
   npx wrangler secret put SQUARE_ACCESS_TOKEN
   ```
   Or use the dashboard: Workers & Pages → ckoolsassii-worker → Settings → Variables and Secrets → Add → type **Secret**.
3. **Optional: `SQUARE_LOCATION_ID`.** Set it as a plain variable to limit results and stock counts to one Square location. Without it, stock is summed across all locations.
4. **Deploy:** `npm install` then `npm run deploy`.
5. **Connect the site.** `wrangler.json` already routes `ckoolsassii.biz/api/*` and `www.ckoolsassii.biz/api/*` to this worker, so a deploy sets that up. The DNS records for ckoolsassii.biz must be **Proxied** (orange cloud) or the route won't run. Don't attach the worker as a *Custom Domain*, because that would replace the whole website with the API.

## UPS shipping setup

Add these in Workers & Pages → ckoolsassii-worker → Settings → Variables and Secrets:

| Name | Type | Value |
| --- | --- | --- |
| `UPS_CLIENT_ID` | Secret | From developer.ups.com → your app → Credentials |
| `UPS_CLIENT_SECRET` | Secret | Same page |
| `UPS_ACCOUNT_NUMBER` | Secret | Your 6-character UPS shipper number. Optional, but needed for your negotiated rates. |
| `SHIP_FROM_NAME` | Text | e.g. `cKool n saSSii` |
| `SHIP_FROM_ADDRESS` | Text | Street address you ship from |
| `SHIP_FROM_CITY` | Text | |
| `SHIP_FROM_STATE` | Text | 2-letter code, e.g. `CO` |
| `SHIP_FROM_ZIP` | Text | |
| `UPS_SERVICES` | Text | Optional. UPS services shoppers can choose, as comma-separated codes. Defaults to `03` (UPS Ground only). Example: `03,02` adds 2nd Day Air. |
| `UPS_ENV` | Text | Optional. `test` uses UPS's testing system; it defaults to production. |

## Shipping label page (ckoolsassii.biz/admin.html)

Also add:

| Name | Type | Value |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Secret | Password for the label page, at least 8 characters. Use a long, unique one. |
| `SHIP_FROM_PHONE` | Text | 10-digit phone number. UPS requires it on labels. |
| `BREVO_API_KEY` | Secret | Optional. Brevo API key for the "your order has shipped" email. |
| `EMAIL_FROM` | Text | Optional. Sender address verified in Brevo, e.g. `orders@ckoolsassii.biz`. |
| `EMAIL_FROM_NAME` | Text | Optional. Defaults to `cKool n saSSii`. |

Your UPS app at developer.ups.com also needs the **Shipping** product, not just Rating.

Labels are kept in the D1 `shipping_labels` table (see `migrations/0002_shipping_labels.sql`; the worker creates the table itself if needed). To cancel a label, void it in your UPS account within 90 days.

Package weight is estimated from product names (`WEIGHT_RULES` in `src/shipping.ts`: hoodie 1.4 lb, sweatshirt 1.2, long sleeve 0.6, tee 0.45, cap 0.35, beanie 0.25, other 0.75, plus 0.3 lb packaging). Edit those numbers to match your real packed weights.

`SQUARE_ENV` defaults to `production`. Set it to `sandbox` to test with a sandbox token.

## Notes

- The catalog is cached in memory for 5 minutes, so new or edited items can take up to 5 minutes to appear.
- Stock levels are fetched live on every search.
- The `DB` (D1) binding from the original template is still configured but unused.
