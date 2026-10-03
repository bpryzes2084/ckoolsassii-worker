# ckoolsassii-worker

Cloudflare Worker that powers the search box on ckoolsassii.biz. It reads the
Square catalog and returns matching products with prices, images, sizes and
stock status.

## Endpoints

| Path | What it does |
| --- | --- |
| `GET /api/search?q=hoodie` | Products whose name, description, category or size matches every word in `q`. Handles plurals and common alternatives (tee / t-shirt, hat → caps and beanies, crewneck / sweatshirt). Empty `q` returns everything. |
| `GET /api/health` | `{ ok, square_configured }`. Use it to check the token is set. |

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

`SQUARE_ENV` defaults to `production`. Set it to `sandbox` to test with a sandbox token.

## Notes

- The catalog is cached in memory for 5 minutes, so new or edited items can take up to 5 minutes to appear.
- Stock levels are fetched live on every search.
- The `DB` (D1) binding from the original template is still configured but unused.
