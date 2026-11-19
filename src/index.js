// Game Deals — Cloudflare Worker + D1.
// Serves the deals board, exposes a JSON API, and refreshes deals daily
// (scheduled cron) or on demand via POST /api/refresh.
//
// Data sources (all public, no keys except Nintendo's public search key):
//   - CheapShark API  (PC stores: Steam, Epic, GOG, Humble, Fanatical, ...)
//   - Epic Games free-games promotions feed
//   - Nintendo eShop catalogue (Algolia search index, public search-only key)
//   - PlayStation Store "All deals" category (GraphQL persisted query)
//
// Cover art is hotlinked from the stores' own image servers; nothing is
// downloaded or re-hosted. Prices are USD as listed by the US stores.

const UA = 'GameDeals/1.0 (https://github.com/tranvietthanh/game-spaces)';
const PS_CATEGORY_ID = '3f772501-f6f8-49b7-abac-874a88ca4897';
const PS_QUERY = `query categoryGridRetrieve(
    $id: ID!,
    $pageArgs: PageArgs,
    $sortBy: CategorySortingOptionInput,
    $facetOptions: [String],
    $filterBy: [String],
    $maxResults: Int,
  ) {
      categoryGridRetrieve(id: $id,
        pageArgs: $pageArgs,
        sortBy: $sortBy,
        facetOptions: $facetOptions,
        filterBy: $filterBy,
        maxResults: $maxResults
        ) {
        id,
        sortedBy { name isAscending displayName }
        sortingOptions { name isAscending displayName }
        facetOptions { name displayName values { displayName count key } }
        pageInfo { totalCount, offset, size, isLast },
        products {
          id, name, npTitleId, telemetryData,
          price { ... priceFragment },
          platforms,
          localizedStoreDisplayClassification,
          storeDisplayClassification,
          media { type, url, role },
          personalizedMeta { ... personalizedMetaFragment },
          skus { type },
        }
        concepts {
          id, name, telemetryData,
          media { type, url, role },
          personalizedMeta { ... personalizedMetaFragment },
          price { ... priceFragment },
          products { id },
        }
        localizedName
        reportingName
      }
    }
fragment personalizedMetaFragment on PersonalizedMeta {
    hasMediaOverrides
    media { role type url }
  }
fragment priceFragment on SkuPrice {
    basePrice
    discountedPrice
    discountText
    isFree
    isExclusive
    isTiedToSubscription
    serviceBranding
    upsellServiceBranding
    upsellText
    includesBundleOffer
    telemetryData
  }
`;
// sha256 of the printed query document above (persisted-query id). The
// PlayStation endpoint only serves whitelisted queries; this is the hash of
// the exact query the official storefront sends. Recomputed at runtime is
// unnecessary — the query text is fixed.
const PS_QUERY_HASH = '27e2d837ca3a032c5fee2b4749741e9f00c121c4427b73dc9f14a9446564022b';

const NINTENDO_APP_ID = 'U3B6GR4UA3';
const NINTENDO_API_KEY = 'a29c6927638bfd8cee23993e51e721c9';

function money(n) {
  return '$' + Number(n).toFixed(2);
}
function parsePrice(s) {
  if (s == null) return 0;
  if (typeof s === 'number') return s;
  if (String(s).toUpperCase() === 'FREE') return 0;
  const v = parseFloat(String(s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(v) ? v : 0;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Refresh: fetch all sources, normalise into deal rows, replace the snapshot.
// ---------------------------------------------------------------------------

async function fetchCheapShark() {
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  const storesRes = await fetch('https://www.cheapshark.com/api/1.0/stores', { headers });
  if (!storesRes.ok) throw new Error('cheapshark stores HTTP ' + storesRes.status);
  const stores = await storesRes.json();
  const storeName = {};
  for (const s of stores) storeName[String(s.storeID)] = s.storeName;
  const deals = [];
  for (let page = 0; page < 4; page++) {
    const res = await fetch(
      `https://www.cheapshark.com/api/1.0/deals?sortBy=DealRating&pageSize=60&pageNumber=${page}`,
      { headers },
    );
    if (!res.ok) throw new Error('cheapshark deals HTTP ' + res.status);
    const rows = await res.json();
    if (!rows.length) break;
    for (const d of rows) {
      const sale = parseFloat(d.salePrice), normal = parseFloat(d.normalPrice);
      deals.push({
        dealKey: d.dealID,
        title: d.title,
        storeId: String(d.storeID),
        storeName: storeName[String(d.storeID)] || 'Store ' + d.storeID,
        salePrice: sale, normalPrice: normal,
        savings: parseFloat(d.savings) || (normal > 0 ? (1 - sale / normal) * 100 : 0),
        isFree: sale === 0 ? 1 : 0,
        platform: null,
        thumb: d.thumb || null,
        dealUrl: 'https://www.cheapshark.com/redirect?dealID=' + d.dealID,
        dealRating: parseFloat(d.dealRating) || 0,
        metacriticScore: parseInt(d.metacriticScore, 10) || 0,
        steamRatingPercent: parseInt(d.steamRatingPercent, 10) || 0,
        steamRatingCount: parseInt(d.steamRatingCount, 10) || 0,
      });
    }
  }
  return deals;
}

async function fetchEpicFree() {
  const res = await fetch(
    'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US',
    { headers: { 'User-Agent': UA, Accept: 'application/json' } },
  );
  if (!res.ok) throw new Error('epic HTTP ' + res.status);
  const data = await res.json();
  const elements = data?.data?.Catalog?.searchStore?.elements || [];
  const now = Date.now();
  const out = [];
  for (const el of elements) {
    if (el.offerType !== 'BASE_GAME') continue;
    const promos = el.promotions || {};
    const current = (promos.promotionalOffers || []).flatMap(g => g.promotionalOffers || []);
    const upcoming = (promos.upcomingPromotionalOffers || []).flatMap(g => g.promotionalOffers || []);
    const wide = (el.keyImages || []).find(i => i.type === 'OfferImageWide');
    const tall = (el.keyImages || []).find(i => i.type === 'OfferImageTall');
    const price = el.price?.totalPrice || {};
    const slug = el.productSlug || el.urlSlug || '';
    const storeUrl = slug ? `https://store.epicgames.com/en-US/p/${slug}` : 'https://store.epicgames.com/en-US/free-games';
    const base = {
      epicKey: 'epic:' + el.id,
      title: el.title,
      description: el.description || '',
      imageUrl: (wide || tall)?.url || '',
      storeUrl,
      originalPrice: (price.originalPrice || 0) / 100,
    };
    for (const p of current) {
      if (p.discountSetting?.discountPercentage === 0) {
        out.push({ ...base, status: 'free_now', startsAt: p.startDate || null, endsAt: p.endDate || null });
      }
    }
    for (const p of upcoming) {
      if (p.discountSetting?.discountPercentage === 0) {
        out.push({ ...base, status: 'coming_soon', startsAt: p.startDate || null, endsAt: p.endDate || null });
      }
    }
  }
  // De-duplicate by key+status, keeping the entry whose window contains now
  // for free_now, and the earliest upcoming window otherwise.
  const seen = new Map();
  for (const e of out) {
    const k = e.epicKey + ':' + e.status;
    if (!seen.has(k)) seen.set(k, e);
  }
  return [...seen.values()];
}

async function fetchNintendo() {
  const deals = [];
  const url = `https://${NINTENDO_APP_ID}-dsn.algolia.net/1/indexes/*/queries?x-algolia-agent=Algolia%20for%20JavaScript%20(4.26.0)%3B%20Browser&x-algolia-api-key=${NINTENDO_API_KEY}&x-algolia-application-id=${NINTENDO_APP_ID}`;
  let debugSample = null;
  for (let page = 0; page < 2; page++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ requests: [{ indexName: 'store_all_products_en_us', params: `query=&hitsPerPage=100&page=${page}&numericFilters=price.percentOff%3E0` }] }),
    });
    if (!res.ok) throw new Error('nintendo HTTP ' + res.status);
    const data = await res.json();
    const hits = data?.results?.[0]?.hits || [];
    if (!hits.length) break;
    if (!debugSample) debugSample = hits[0];
    for (const h of hits) {
      const price = h.price || {};
      const regular = parsePrice(price.regularPrice);
      const sale = parsePrice(price.discountPrice ?? price.regularPrice);
      const pct = price.percentOff != null ? Number(price.percentOff) : (regular > 0 ? Math.round((1 - sale / regular) * 100) : 0);
      if (!regular || sale >= regular) continue;
      const nsuid = h.nsuid || h.objectID || '';
      deals.push({
        dealKey: 'nin:' + (h.objectID || nsuid || h.url || h.title),
        title: h.title,
        storeId: 'nintendo',
        storeName: 'Nintendo eShop',
        salePrice: sale, normalPrice: regular, savings: pct,
        isFree: sale === 0 ? 1 : 0,
        platform: h.platform || 'Nintendo Switch',
        thumb: h.boxart || h.image || h.keyImages?.[0]?.url || null,
        dealUrl: h.url ? `https://www.nintendo.com${h.url.startsWith('/') ? '' : '/'}${h.url}` : `https://www.nintendo.com/us/store/games/`,
        dealRating: 0, metacriticScore: 0, steamRatingPercent: 0, steamRatingCount: 0,
      });
    }
    if (hits.length < 100) break;
  }
  return { deals, debugSample: debugSample ? Object.keys(debugSample) : null };
}

async function fetchPlayStation() {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    Referer: `https://store.playstation.com/en-us/category/${PS_CATEGORY_ID}/1`,
    Origin: 'https://store.playstation.com',
    Accept: 'application/json',
    'apollographql-client-name': 'ems-web',
  };
  const deals = [];
  let offset = 0;
  for (let page = 0; page < 5; page++) {
    const body = {
      operationName: 'categoryGridRetrieve',
      variables: { id: PS_CATEGORY_ID, pageArgs: { size: 24, offset } },
      extensions: { persistedQuery: { version: 1, sha256Hash: PS_QUERY_HASH } },
    };
    let res = await fetch('https://web.np.playstation.com/api/graphql/v1/op', { method: 'POST', headers, body: JSON.stringify(body) });
    let data = await res.json().catch(() => ({}));
    if (data?.errors?.[0]?.extensions?.code === 'PERSISTED_QUERY_NOT_IN_LIST' || data?.message === 'Query not whitelisted') {
      // Fall back to sending the full query document.
      res = await fetch('https://web.np.playstation.com/api/graphql/v1/op', {
        method: 'POST', headers,
        body: JSON.stringify({ operationName: 'categoryGridRetrieve', variables: body.variables, query: PS_QUERY }),
      });
      data = await res.json().catch(() => ({}));
    }
    const grid = data?.data?.categoryGridRetrieve;
    if (!grid || !Array.isArray(grid.products)) {
      throw new Error('playstation unexpected response: ' + JSON.stringify(data).slice(0, 300));
    }
    for (const p of grid.products) {
      const base = parsePrice(p.price?.basePrice);
      const disc = parsePrice(p.price?.discountedPrice);
      if (!base || disc >= base) continue;
      const img = (p.media || []).find(m => m.type === 'IMAGE') || (p.media || [])[0];
      const platforms = Array.isArray(p.platforms) ? p.platforms.join(' · ') : null;
      deals.push({
        dealKey: 'ps:' + p.id,
        title: p.name,
        storeId: 'playstation',
        storeName: 'PlayStation Store',
        salePrice: disc, normalPrice: base,
        savings: Math.round((1 - disc / base) * 100),
        isFree: disc === 0 ? 1 : 0,
        platform: platforms,
        thumb: img?.url || null,
        dealUrl: `https://store.playstation.com/en-us/product/${p.id}`,
        dealRating: 0, metacriticScore: 0, steamRatingPercent: 0, steamRatingCount: 0,
      });
    }
    const pageInfo = grid.pageInfo || {};
    offset += (grid.products || []).length;
    if (pageInfo.isLast || !grid.products.length) break;
  }
  return deals;
}

async function refreshAll(env) {
  const status = {};
  const startedAt = new Date().toISOString();
  let pcDeals = [], epicFree = [], ninDeals = [], psDeals = [];
  let ninDebug = null;
  try { pcDeals = await fetchCheapShark(); status.cheapshark = 'ok'; }
  catch (e) { status.cheapshark = 'error: ' + e.message; }
  try { epicFree = await fetchEpicFree(); status.epic = 'ok'; }
  catch (e) { status.epic = 'error: ' + e.message; }
  try { const r = await fetchNintendo(); ninDeals = r.deals; ninDebug = r.debugSample; status.nintendo = 'ok'; }
  catch (e) { status.nintendo = 'error: ' + e.message; }
  try { psDeals = await fetchPlayStation(); status.playstation = 'ok'; }
  catch (e) { status.playstation = 'error: ' + e.message; }

  const all = [...pcDeals, ...ninDeals, ...psDeals];
  const db = env.DB;
  // Replace the snapshot only with sources that succeeded; a failed source
  // keeps its previous deals instead of wiping them.
  const okStores = new Set();
  if (status.cheapshark === 'ok') for (const d of pcDeals) okStores.add(d.storeId);
  if (status.nintendo === 'ok') okStores.add('nintendo');
  if (status.playstation === 'ok') okStores.add('playstation');
  if (okStores.size) {
    const placeholders = [...okStores].map(() => '?').join(',');
    await db.prepare(`DELETE FROM deals WHERE store_id IN (${placeholders})`).bind(...okStores).run();
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO deals (deal_key,title,store_id,store_name,sale_price,normal_price,savings,is_free,platform,thumb,deal_url,deal_rating,metacritic_score,steam_rating_percent,steam_rating_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    const batch = all.map(d => stmt.bind(d.dealKey, d.title, d.storeId, d.storeName, d.salePrice, d.normalPrice, d.savings, d.isFree, d.platform, d.thumb, d.dealUrl, d.dealRating, d.metacriticScore, d.steamRatingPercent, d.steamRatingCount));
    for (let i = 0; i < batch.length; i += 50) await db.batch(batch.slice(i, i + 50));
  }
  if (status.epic === 'ok') {
    await db.prepare('DELETE FROM epic_free').run();
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO epic_free (epic_key,title,description,image_url,store_url,original_price,status,starts_at,ends_at) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    const batch = epicFree.map(e => stmt.bind(e.epicKey, e.title, e.description, e.imageUrl, e.storeUrl, e.originalPrice, e.status, e.startsAt, e.endsAt));
    for (let i = 0; i < batch.length; i += 50) await db.batch(batch.slice(i, i + 50));
  }
  await db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    .bind('last_refresh', JSON.stringify({ at: startedAt, status, counts: { cheapshark: pcDeals.length, epic: epicFree.length, nintendo: ninDeals.length, playstation: psDeals.length } })).run();
  return { at: startedAt, status, counts: { cheapshark: pcDeals.length, epic: epicFree.length, nintendo: ninDeals.length, playstation: psDeals.length }, nintendoSampleKeys: ninDebug };
}

// ---------------------------------------------------------------------------
// HTTP API + frontend
// ---------------------------------------------------------------------------

const SORT_SQL = {
  best: 'deal_rating DESC, savings DESC',
  savings: 'savings DESC',
  price_low: 'sale_price ASC',
  rating: 'steam_rating_percent DESC, metacritic_score DESC',
};

async function getDeals(env, url) {
  const store = url.searchParams.get('store') || 'all';
  const type = url.searchParams.get('type') || 'all';
  const q = (url.searchParams.get('q') || '').trim();
  const sort = SORT_SQL[url.searchParams.get('sort')] ? url.searchParams.get('sort') : 'best';
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '120', 10) || 120, 1), 200);
  const device = url.searchParams.get('device') || '';
  const where = [];
  const params = [];
  if (store !== 'all') { where.push('store_id = ?'); params.push(store); }
  if (type === 'free') where.push('is_free = 1');
  if (type === 'discounted') where.push('is_free = 0');
  if (q) { where.push('title LIKE ?'); params.push('%' + q + '%'); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { results: deals } = await env.DB.prepare(
    `SELECT * FROM deals ${whereSql} ORDER BY ${SORT_SQL[sort]} LIMIT ?`,
  ).bind(...params, limit).all();
  const { results: stores } = await env.DB.prepare(
    'SELECT store_id AS storeId, store_name AS storeName, COUNT(*) AS count FROM deals GROUP BY store_id ORDER BY count DESC',
  ).all();
  const { results: epic } = await env.DB.prepare('SELECT * FROM epic_free ORDER BY status, starts_at').all();
  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM deals').first();
  const meta = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_refresh'").first();
  let savedKeys = new Set();
  if (device) {
    const { results } = await env.DB.prepare('SELECT deal_key FROM watchlist WHERE device_id = ?').bind(device).all();
    savedKeys = new Set(results.map(r => r.deal_key));
  }
  const savedCount = savedKeys.size;
  for (const d of deals) d.saved = savedKeys.has(d.deal_key);
  for (const e of epic) e.saved = savedKeys.has(e.epic_key);
  const last = meta ? JSON.parse(meta.value) : null;
  return {
    ok: true,
    asOf: last?.at || null,
    deals,
    epicFree: epic,
    freeCount: epic.filter(e => e.status === 'free_now').length,
    savedCount,
    sourceStatus: last?.status || {},
    stores,
    totalDeals: total?.n || 0,
  };
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Game Deals — free &amp; discounted games</title>
<style>
:root{--bg:#0b0e14;--card:#141926;--card2:#1b2133;--text:#e8ecf4;--muted:#9aa4b8;--accent:#7c5cff;--green:#22c55e;--red:#ef4444;--border:#232b40}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{padding:28px 20px 8px;max-width:1200px;margin:0 auto}
h1{margin:0;font-size:28px}h1 span{color:var(--accent)}
.sub{color:var(--muted);margin:6px 0 0;font-size:14px}
main{max-width:1200px;margin:0 auto;padding:12px 20px 60px}
section{margin-top:26px}
h2{font-size:18px;margin:0 0 12px}
.free-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.free-card{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden}
.free-card img{width:100%;height:150px;object-fit:cover;display:block;background:#000}
.free-body{padding:12px 14px}
.free-body h3{margin:0 0 6px;font-size:16px}
.free-body p{margin:0 0 10px;color:var(--muted);font-size:13px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.badge{display:inline-block;background:var(--green);color:#04120a;font-weight:700;font-size:12px;padding:3px 8px;border-radius:999px}
.badge.soon{background:#f59e0b;color:#221503}
.countdown{color:var(--muted);font-size:13px;margin-left:8px}
.btn{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;font-weight:600;font-size:13px;padding:8px 14px;border-radius:9px;border:0;cursor:pointer}
.btn.ghost{background:transparent;border:1px solid var(--border);color:var(--text)}
.controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:14px 0}
.controls input[type=search]{flex:1;min-width:180px;background:var(--card);border:1px solid var(--border);color:var(--text);border-radius:9px;padding:9px 12px;font-size:14px}
.controls select{background:var(--card);border:1px solid var(--border);color:var(--text);border-radius:9px;padding:9px;font-size:14px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
.chip{background:var(--card);border:1px solid var(--border);color:var(--muted);border-radius:999px;padding:6px 12px;font-size:13px;cursor:pointer}
.chip.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.tabs{display:flex;gap:8px}
.tab{background:var(--card);border:1px solid var(--border);color:var(--muted);border-radius:9px;padding:8px 14px;font-size:14px;cursor:pointer}
.tab.on{background:var(--text);color:#111;border-color:var(--text)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px;margin-top:14px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden;position:relative}
.card img{width:100%;height:110px;object-fit:cover;display:block;background:#000}
.card-body{padding:11px 12px 12px}
.card-body h3{margin:0 0 4px;font-size:14px;line-height:1.3;min-height:36px}
.store{color:var(--muted);font-size:12px}
.price-row{display:flex;align-items:baseline;gap:8px;margin-top:8px}
.sale{font-weight:800;font-size:17px}.normal{color:var(--muted);text-decoration:line-through;font-size:13px}
.off{background:var(--red);color:#fff;font-weight:700;font-size:12px;padding:2px 7px;border-radius:6px;margin-left:auto}
.meta{color:var(--muted);font-size:12px;margin-top:6px}
.star{position:absolute;top:8px;right:8px;background:rgba(0,0,0,.65);border:1px solid var(--border);color:#fff;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:15px}
.star.saved{color:#ffd166;border-color:#ffd166}
.card a.deal-link{display:block;margin-top:9px;color:var(--accent);font-size:13px;font-weight:600;text-decoration:none}
.empty{color:var(--muted);padding:30px 0;text-align:center}
footer{color:var(--muted);font-size:12px;margin-top:30px}
</style></head>
<body>
<header><h1>🎮 Game <span>Deals</span></h1>
<p class="sub">Free &amp; discounted games from Epic, Steam, GOG, Humble, Fanatical, PlayStation Store and Nintendo eShop. Prices in USD.</p></header>
<main>
<section id="free-section"><h2>Free right now on Epic</h2><div class="free-grid" id="free-now"></div>
<h2 style="margin-top:22px">Coming free next</h2><div class="free-grid" id="free-next"></div></section>
<section><h2>All deals <span id="deal-count" style="color:var(--muted);font-size:14px"></span></h2>
<div class="controls">
<input type="search" id="q" placeholder="Search games…">
<select id="sort"><option value="best">Best deal</option><option value="savings">Biggest saving</option><option value="price_low">Lowest price</option><option value="rating">Highest rated</option></select>
<div class="tabs"><button class="tab on" data-type="all">All</button><button class="tab" data-type="free">Free</button><button class="tab" data-type="discounted">Discounted</button><button class="tab" data-type="saved">☆ Watchlist <span id="saved-n"></span></button></div>
<button class="btn ghost" id="refresh">↻ Refresh</button>
</div>
<div class="chips" id="chips"></div>
<div class="grid" id="grid"></div>
<p class="sub" id="status"></p>
<footer>Deals refresh daily. Cover art is served by the stores themselves. Not affiliated with Epic, Steam, GOG, Sony or Nintendo.</footer>
</section></main>
<script>
const device = localStorage.getItem('gd-device') || (()=>{const id='d-'+Math.random().toString(36).slice(2)+Date.now().toString(36);localStorage.setItem('gd-device',id);return id})();
let state={store:'all',type:'all',q:'',sort:'best',stores:[],saved:new Set()};
const $=s=>document.querySelector(s);
function fmt(n){return '$'+Number(n).toFixed(2)}
function countdown(iso){if(!iso)return '';const ms=new Date(iso)-Date.now();if(ms<=0)return 'ends soon';const d=Math.floor(ms/864e5),h=Math.floor(ms%864e5/36e5);return d>0?('ends in '+d+'d '+h+'h'):('ends in '+h+'h '+Math.floor(ms%36e5/6e4)+'m')}
async function load(){
  const p=new URLSearchParams({store:state.store,type:state.type==='saved'?'all':state.type,q:state.q,sort:state.sort,limit:200,device});
  const r=await fetch('/api/deals?'+p); const data=await r.json();
  state.stores=data.stores||[];
  renderChips(); renderFree(data.epicFree||[]);
  let deals=data.deals||[];
  if(state.type==='saved') deals=deals.filter(d=>d.saved);
  $('#deal-count').textContent='· '+data.totalDeals+' deals';
  $('#saved-n').textContent=data.savedCount?('('+data.savedCount+')'):'';
  $('#status').textContent=(data.asOf?('Updated '+new Date(data.asOf).toLocaleString()+' · '):'')+Object.entries(data.sourceStatus||{}).map(([k,v])=>k+': '+v).join(' · ');
  renderGrid(deals);
}
function renderChips(){
  const all=[{storeId:'all',storeName:'All stores',count:null},...state.stores];
  $('#chips').innerHTML=all.map(s=>'<button class="chip'+(state.store===s.storeId?' on':'')+'" data-store="'+s.storeId+'">'+s.storeName+(s.count!=null?' ('+s.count+')':'')+'</button>').join('');
  document.querySelectorAll('.chip').forEach(c=>c.onclick=()=>{state.store=c.dataset.store;document.querySelectorAll('.chip').forEach(x=>x.classList.remove('on'));c.classList.add('on');load()});
}
function renderFree(list){
  const now=list.filter(e=>e.status==='free_now'), next=list.filter(e=>e.status==='coming_soon');
  const card=e=>'<div class="free-card">'+(e.image_url?'<img src="'+e.image_url+'" alt="">':'')+'<div class="free-body"><h3>'+e.title+'</h3><p>'+(e.description||'')+'</p><span class="badge'+(e.status==='free_now'?'':' soon')+'">'+(e.status==='free_now'?'FREE':'COMING SOON')+'</span><span class="countdown">'+countdown(e.ends_at)+'</span><div style="margin-top:10px"><a class="btn" href="'+e.store_url+'" target="_blank" rel="noopener">Claim on Epic</a> <button class="btn ghost" data-k="'+e.epic_key+'" onclick="toggleSave(this.dataset.k,this)">'+(e.saved?'★ Saved':'☆ Watch')+'</button></div></div></div>';
  $('#free-now').innerHTML=now.length?now.map(card).join(''):'<p class="empty">No free games right now — check back Thursday.</p>';
  $('#free-next').innerHTML=next.length?next.map(card).join(''):'<p class="empty">Nothing announced yet.</p>';
}
function renderGrid(deals){
  if(!deals.length){$('#grid').innerHTML='<p class="empty">No deals match those filters.</p>';return}
  $('#grid').innerHTML=deals.map(d=>{
    const pct=Math.round(d.savings||0);
    const rating=d.steam_rating_percent?('Steam '+d.steam_rating_percent+'% ('+d.steam_rating_count+')'): (d.metacritic_score?('Metacritic '+d.metacritic_score):'');
    return '<div class="card"><button class="star'+(d.saved?' saved':'')+'" data-k="'+d.deal_key+'" onclick="toggleSave(this.dataset.k,this)">'+(d.saved?'★':'☆')+'</button>'
    +(d.thumb?'<img src="'+d.thumb+'" alt="" loading="lazy">':'')
    +'<div class="card-body"><h3>'+d.title+'</h3><div class="store">'+d.store_name+(d.platform?' · '+d.platform:'')+'</div>'
    +'<div class="price-row"><span class="sale">'+fmt(d.sale_price)+'</span><span class="normal">'+fmt(d.normal_price)+'</span><span class="off">-'+pct+'%</span></div>'
    +(rating?'<div class="meta">'+rating+'</div>':'')
    +'<a class="deal-link" href="'+d.deal_url+'" target="_blank" rel="noopener">View deal →</a></div></div>';
  }).join('');
}
async function toggleSave(key,btn){
  const r=await fetch('/api/watchlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:device,dealKey:key})});
  const j=await r.json(); if(j.ok){btn.textContent=j.saved?'★ Saved':'☆ Watch';btn.classList.toggle('saved',j.saved);load()}
}
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{state.type=t.dataset.type;document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));t.classList.add('on');load()});
$('#sort').onchange=e=>{state.sort=e.target.value;load()};
let deb; $('#q').oninput=e=>{clearTimeout(deb);deb=setTimeout(()=>{state.q=e.target.value.trim();load()},300)};
$('#refresh').onclick=async e=>{e.target.textContent='Refreshing…';await fetch('/api/refresh',{method:'POST'});e.target.textContent='↻ Refresh';load()};
load();
</script></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(PAGE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      if (url.pathname === '/api/deals') {
        return Response.json(await getDeals(env, url));
      }
      if (url.pathname === '/api/watchlist' && request.method === 'GET') {
        const device = url.searchParams.get('device') || '';
        const { results } = await env.DB.prepare(
          'SELECT d.* FROM watchlist w JOIN deals d ON d.deal_key = w.deal_key WHERE w.device_id = ? ORDER BY w.saved_at DESC',
        ).bind(device).all();
        return Response.json({ ok: true, deals: results });
      }
      if (url.pathname === '/api/watchlist' && request.method === 'POST') {
        const { deviceId, dealKey } = await request.json();
        if (!deviceId || !dealKey) return Response.json({ ok: false, error: 'deviceId and dealKey required' }, { status: 400 });
        const existing = await env.DB.prepare('SELECT 1 FROM watchlist WHERE device_id = ? AND deal_key = ?').bind(deviceId, dealKey).first();
        if (existing) {
          await env.DB.prepare('DELETE FROM watchlist WHERE device_id = ? AND deal_key = ?').bind(deviceId, dealKey).run();
          return Response.json({ ok: true, saved: false });
        }
        await env.DB.prepare('INSERT INTO watchlist (device_id, deal_key, saved_at) VALUES (?, ?, ?)').bind(deviceId, dealKey, new Date().toISOString()).run();
        return Response.json({ ok: true, saved: true });
      }
      if (url.pathname === '/api/refresh' && request.method === 'POST') {
        const result = await refreshAll(env);
        return Response.json({ ok: true, ...result });
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAll(env));
  },
};
