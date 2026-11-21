# Game Deals

A deals board for free and discounted games across Epic Games Store, Steam,
GOG, Humble Store, Fanatical, GreenManGaming, Ubisoft, Gamesplanet and more
(via the [CheapShark](https://www.cheapshark.com/api/1.0) API), plus
PlayStation Store and Nintendo eShop. Epic's current and upcoming free games
are shown up top with a countdown and claim link.

- Filter by store, switch between All / Free / Discounted / Watchlist,
  sort by best deal, biggest saving, lowest price or rating, search by title.
- Star any deal into a watchlist (stored per browser, no account needed).
- Prices are USD as listed by the US stores. Cover art is hotlinked from the
  stores' own image servers — nothing is downloaded or re-hosted.

## Stack

- **Cloudflare Worker** (`src/index.js`) — serves the page, a JSON API
  (`GET /api/deals`, `GET/POST /api/watchlist`, `POST /api/refresh`) and the
  scheduled refresh.
- **Cloudflare D1** (`game-deals`) — cached deals, Epic free games, watchlist.
- **Scheduled refresh** — daily cron (`6 22 * * *` UTC = 09:06 AEDT) pulls the
  latest deals from every source. The page also refreshes when opened if the
  data is stale, and there is a Refresh button. If one source fails, its last
  good deals stay visible and the page flags that source as stale.

## Data sources

| Source | How |
|---|---|
| PC stores | CheapShark deals API, sorted by deal rating (needs a descriptive `User-Agent`) |
| Epic free games | Epic `freeGamesPromotions` feed |
| Nintendo eShop | Nintendo's public Algolia search index (`store_all_products_en_us`, search-only key embedded in the site) |
| PlayStation Store | PS Deals public API (`api.psdeals.net/public/v1/deals`, US region) — needs a free API key as the `PSDEALS_API_KEY` Worker secret |

### PlayStation feed note

PlayStation deals come from the [PS Deals public API](https://psdeals.net/api)
(`GET /public/v1/deals?region=US&type=GAME&sort=-discount&limit=25`,
up to 5 pages = the 125 biggest US discounts). The API needs a key:
sign in at psdeals.net, apply for API access for this project (free tier,
no card; project approval required), create a key in the dashboard, and
store it as a Worker secret:

```
wrangler secret put PSDEALS_API_KEY
```

Free-tier limits: 500 requests/month, 25 results/page, 10 requests/minute.
One daily refresh uses ~5 requests (~150/month), inside the allowance.
Attribution is required on the free plan — the site footer credits PS Deals.
If the secret is missing, the PlayStation source reports an error and the
previously stored PS deals are kept (keep-on-failure), so the site still
shows the last good snapshot.

History: the feed originally used Sony's GraphQL endpoint with a persisted
query hash. Sony rotates the storefront build, and in Nov 2026 the hash
stopped being accepted. A thorough investigation
(`scratch-ps-hash/FINDINGS.md`) proved no hash derivable from the public
storefront code is accepted by Sony's whitelist (19 variants tested), so
the GraphQL route cannot be automated — hence the switch to the PS Deals API.

## Local setup

```bash
npm install
npx wrangler d1 create game-deals        # first time only; put the returned
                                          # database_id into wrangler.toml
npx wrangler d1 migrations apply game-deals --local
npm run dev
```

Seed data (runs the same refresh the cron runs):

```bash
curl -X POST http://localhost:8787/api/refresh
```

## Deploy

Pushes to `main` deploy automatically via GitHub Actions
(`.github/workflows/deploy.yml`). Set these repository secrets first:

- `CLOUDFLARE_API_TOKEN` — an API token with Workers Scripts:Edit,
  D1:Edit and Account Settings:Read (or "Edit Cloudflare Workers" template).
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account id.

Or deploy by hand:

```bash
npm run deploy
npx wrangler d1 migrations apply game-deals --remote
```

## Custom domain

Attach one any time in the Cloudflare dashboard: Workers & Pages →
`game-deals` → Settings → Domains → Add a custom domain. No code change or
redeploy is needed.

## API

- `GET /api/deals?store=all&type=all&q=&sort=best&limit=120&device=<id>` —
  deals, Epic free games, per-store counts, source freshness.
- `GET /api/watchlist?device=<id>` — saved deals.
- `POST /api/watchlist` `{deviceId, dealKey}` — toggle a saved deal.
- `POST /api/refresh` — re-fetch every source now.
