// Game Deals — Cloudflare Worker + D1.
// Serves the deals board, exposes a JSON API, and receives its daily
// refresh as a push from the Game Deals space via POST /api/sync
// (Bearer SYNC_SECRET Worker secret). POST /api/refresh stays for
// manual use; the Worker's own scheduled cron is disabled so it can
// never overwrite synced data.
//
// Data sources (all public; Nintendo uses a public search-only key, PlayStation
// uses a free PS Deals API key stored as the PSDEALS_API_KEY Worker secret):
//   - CheapShark API  (PC stores: Steam, Epic, GOG, Humble, Fanatical, ...)
//   - Epic Games free-games promotions feed
//   - Nintendo eShop catalogue (Algolia search index, public search-only key)
//   - PlayStation Store deals via the PS Deals public API (api.psdeals.net)
//
// Cover art is hotlinked from the stores' own image servers; nothing is
// downloaded or re-hosted. Prices are USD as listed by the US stores.

const UA = 'GameDeals/1.0 (https://github.com/tranvietthanh/game-spaces)';

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

const PSDEALS_API = 'https://api.psdeals.net/public/v1';

// PS Deals public API (https://psdeals.net/api). Free tier: 500 requests/month,
// 25 results/page, current prices only, attribution required. The site fetches
// the 125 biggest US discounts (5 pages x 25) once a day, ~150 requests/month,
// inside the free allowance. The key lives in the PSDEALS_API_KEY Worker
// secret — apply for a free key at https://psdeals.net/api (project approval
// required). This replaced the Sony GraphQL feed in Nov 2026: Sony rotates
// the storefront's persisted-query hash and no hash derivable from the public
// storefront code is accepted by its whitelist, so the GraphQL route cannot
// be automated (see scratch-ps-hash/FINDINGS.md).
async function fetchPlayStation(env) {
  const key = env.PSDEALS_API_KEY;
  if (!key) throw new Error('playstation: PS Deals API key not configured (PSDEALS_API_KEY secret missing)');
  const headers = { Authorization: 'Bearer ' + key, Accept: 'application/json', 'User-Agent': UA };
  const deals = [];
  for (let page = 1; page <= 5; page++) {
    const url = `${PSDEALS_API}/deals?region=US&type=GAME&sort=-discount&limit=25&page=${page}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error('playstation PS Deals API HTTP ' + res.status);
    const data = await res.json();
    const rows = Array.isArray(data?.data) ? data.data : [];
    for (const p of rows) {
      const d = psDealsProductToDeal(p);
      if (d) deals.push(d);
    }
    if (!data?.meta?.has_more || !rows.length) break;
  }
  return deals;
}

// Map one PS Deals API product onto the site's deal row. Returns null for
// anything without a live ordinary discount (member-only prices, expired
// sales, or no current price). Uses the ordinary price, not the PS+ member
// price, so the discount shown is what any shopper gets.
function psDealsProductToDeal(p) {
  const pricing = p?.pricing || {};
  if (pricing.expired || pricing.available === false) return null;
  // A null price means "no price available" (per the API docs); "0.00" means free.
  if (pricing.current == null || pricing.regular == null) return null;
  const regular = parsePrice(pricing.regular);
  const sale = parsePrice(pricing.current);
  if (!regular || sale == null || Number.isNaN(sale) || sale >= regular) return null;
  const platforms = Array.isArray(p.platforms) ? p.platforms.map(x => x.name).filter(Boolean).join(' · ') : null;
  const pct = pricing.discount_percent != null
    ? Math.round(Number(pricing.discount_percent))
    : Math.round((1 - sale / regular) * 100);
  return {
    dealKey: 'psd:' + p.id,
    title: p.name,
    storeId: 'playstation',
    storeName: 'PlayStation Store',
    salePrice: sale, normalPrice: regular, savings: pct,
    isFree: sale === 0 ? 1 : 0,
    platform: platforms || null,
    thumb: p.image_url || null,
    dealUrl: p.store_url || ('https://store.playstation.com/en-us/product/' + (p.store_id || '')),
    dealRating: 0, metacriticScore: Number(p.ratings?.metacritic) || 0, steamRatingPercent: 0, steamRatingCount: 0,
  };
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
  try { psDeals = await fetchPlayStation(env); status.playstation = 'ok'; }
  catch (e) { status.playstation = 'error: ' + e.message; }

  const all = [...pcDeals, ...ninDeals, ...psDeals];
  const db = env.DB;
  // Replace the snapshot only with sources that succeeded AND returned
  // >0 deals; a failed source, or one that returned 0 rows, keeps its
  // previous deals instead of wiping them (this was the Nintendo 0-deal
  // wipe: 'ok' with 0 rows used to delete all 80 Nintendo deals).
  const okStores = new Set();
  if (status.cheapshark === 'ok' && pcDeals.length) for (const d of pcDeals) okStores.add(d.storeId);
  if (status.nintendo === 'ok' && ninDeals.length) okStores.add('nintendo');
  if (status.playstation === 'ok' && psDeals.length) okStores.add('playstation');
  if (okStores.size) {
    const placeholders = [...okStores].map(() => '?').join(',');
    await db.prepare(`DELETE FROM deals WHERE store_id IN (${placeholders})`).bind(...okStores).run();
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO deals (deal_key,title,store_id,store_name,sale_price,normal_price,savings,is_free,platform,thumb,deal_url,deal_rating,metacritic_score,steam_rating_percent,steam_rating_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    const batch = all.map(d => stmt.bind(d.dealKey, d.title, d.storeId, d.storeName, d.salePrice, d.normalPrice, d.savings, d.isFree, d.platform, d.thumb, d.dealUrl, d.dealRating, d.metacriticScore, d.steamRatingPercent, d.steamRatingCount));
    for (let i = 0; i < batch.length; i += 50) await db.batch(batch.slice(i, i + 50));
  }
  if (status.epic === 'ok' && epicFree.length) {
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
// Push sync from the Game Deals space (POST /api/sync).
// The space refreshes from sources that block Cloudflare Worker IPs
// (CheapShark 403s the Worker, Sony's GraphQL hash can't be automated),
// so instead of re-fetching here it pushes its fresh snapshot and this
// endpoint writes it straight into D1. Auth: Bearer <SYNC_SECRET>
// (Worker secret SYNC_SECRET). A source group that is missing or empty
// keeps its old rows; only groups with >0 rows replace their rows.
// The watchlist table is never touched.
// ---------------------------------------------------------------------------

const SYNC_SOURCES = ['cheapshark', 'playstation', 'nintendo'];

function syncNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function syncFromSpace(env, request) {
  if (!env.SYNC_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: 'sync secret not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  const auth = request.headers.get('Authorization') || '';
  if (auth !== 'Bearer ' + env.SYNC_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  let body;
  try { body = await request.json(); }
  catch (e) { return new Response(JSON.stringify({ ok: false, error: 'invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
  if (!body || typeof body !== 'object') {
    return new Response(JSON.stringify({ ok: false, error: 'invalid payload' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  const deals = Array.isArray(body.deals) ? body.deals : [];
  const epicFree = Array.isArray(body.epicFree) ? body.epicFree : [];
  if (deals.length > 1000 || epicFree.length > 50) {
    return new Response(JSON.stringify({ ok: false, error: 'payload too large' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  // Validate + coerce deal rows.
  const groups = { cheapshark: [], playstation: [], nintendo: [] };
  for (const d of deals) {
    if (!d || typeof d !== 'object') return new Response(JSON.stringify({ ok: false, error: 'invalid deal row' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    if (!SYNC_SOURCES.includes(d.source)) return new Response(JSON.stringify({ ok: false, error: 'invalid deal source: ' + String(d.source) }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    if (!d.dealKey || !d.title || d.storeId == null || !d.storeName || !d.dealUrl) {
      return new Response(JSON.stringify({ ok: false, error: 'deal missing required fields' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    groups[d.source].push({
      dealKey: String(d.dealKey),
      title: String(d.title),
      storeId: String(d.storeId),
      storeName: String(d.storeName),
      salePrice: syncNum(d.salePrice),
      normalPrice: syncNum(d.normalPrice),
      savings: syncNum(d.savings),
      isFree: d.isFree ? 1 : 0,
      platform: d.platform != null ? String(d.platform) : null,
      thumb: d.thumb != null ? String(d.thumb) : null,
      dealUrl: String(d.dealUrl),
      dealRating: syncNum(d.dealRating),
      metacriticScore: syncNum(d.metacriticScore),
      steamRatingPercent: syncNum(d.steamRatingPercent),
      steamRatingCount: syncNum(d.steamRatingCount),
    });
  }
  // Validate epic rows.
  const epicRows = [];
  for (const e of epicFree) {
    if (!e || typeof e !== 'object' || !e.epicKey || !e.title || (e.status !== 'free_now' && e.status !== 'coming_soon')) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid epic_free row' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    epicRows.push({
      epicKey: String(e.epicKey),
      title: String(e.title),
      description: e.description != null ? String(e.description) : '',
      imageUrl: e.imageUrl != null ? String(e.imageUrl) : null,
      storeUrl: e.storeUrl != null ? String(e.storeUrl) : null,
      originalPrice: syncNum(e.originalPrice),
      status: e.status,
      startsAt: e.startsAt != null ? String(e.startsAt) : null,
      endsAt: e.endsAt != null ? String(e.endsAt) : null,
    });
  }

  const db = env.DB;
  const dealStmt = db.prepare(
    'INSERT OR REPLACE INTO deals (deal_key,title,store_id,store_name,sale_price,normal_price,savings,is_free,platform,thumb,deal_url,deal_rating,metacritic_score,steam_rating_percent,steam_rating_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const counts = { cheapshark: groups.cheapshark.length, playstation: groups.playstation.length, nintendo: groups.nintendo.length, epic: epicRows.length };
  // Replace only sources present with >0 rows; missing/empty keeps old rows.
  for (const source of SYNC_SOURCES) {
    const rows = groups[source];
    if (!rows.length) continue;
    if (source === 'cheapshark') {
      const storeIds = [...new Set(rows.map(r => r.storeId))];
      const placeholders = storeIds.map(() => '?').join(',');
      await db.prepare(`DELETE FROM deals WHERE store_id IN (${placeholders})`).bind(...storeIds).run();
    } else {
      await db.prepare('DELETE FROM deals WHERE store_id = ?').bind(source).run();
    }
    const batch = rows.map(d => dealStmt.bind(d.dealKey, d.title, d.storeId, d.storeName, d.salePrice, d.normalPrice, d.savings, d.isFree, d.platform, d.thumb, d.dealUrl, d.dealRating, d.metacriticScore, d.steamRatingPercent, d.steamRatingCount));
    for (let i = 0; i < batch.length; i += 50) await db.batch(batch.slice(i, i + 50));
  }
  if (epicRows.length) {
    await db.prepare('DELETE FROM epic_free').run();
    const epicStmt = db.prepare(
      'INSERT OR REPLACE INTO epic_free (epic_key,title,description,image_url,store_url,original_price,status,starts_at,ends_at) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    const batch = epicRows.map(e => epicStmt.bind(e.epicKey, e.title, e.description, e.imageUrl, e.storeUrl, e.originalPrice, e.status, e.startsAt, e.endsAt));
    for (let i = 0; i < batch.length; i += 50) await db.batch(batch.slice(i, i + 50));
  }
  const at = (body.at && typeof body.at === 'string') ? body.at : new Date().toISOString();
  const status = (body.status && typeof body.status === 'object') ? body.status : {
    cheapshark: counts.cheapshark ? 'ok' : 'not synced',
    epic: counts.epic ? 'ok' : 'not synced',
    playstation: counts.playstation ? 'ok' : 'not synced',
    nintendo: counts.nintendo ? 'ok' : 'not synced',
  };
  await db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    .bind('last_refresh', JSON.stringify({ at, status, counts, syncedFrom: 'game-deals-space' })).run();
  return Response.json({ ok: true, counts, at });
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
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#07090d;--card:#10141c;--card2:#171d29;--text:#f2f4f8;--muted:#8a93a5;--green:#2ee06f;--amber:#f5a623;--blue:#6cb6ff;--border:#1e2632;--border2:#2a3342}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
h1,h2,h3,.cond{font-family:Oswald,'Arial Narrow',Impact,sans-serif}
header{padding:18px 20px 0;max-width:1280px;margin:0 auto}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.topbar .sub{color:var(--muted);font-size:14px;margin:0}
main{max-width:1280px;margin:0 auto;padding:6px 20px 60px}
section{margin-top:26px}
h2{font-size:30px;margin:0 0 14px;text-transform:uppercase;letter-spacing:.5px;font-weight:700}
h2 .count{color:var(--muted);font-size:22px;margin-left:10px}
h2 .green{color:var(--green)}
h2.amber{color:var(--amber)}
.sub{color:var(--muted);margin:6px 0 0;font-size:14px}
.free-grid{display:flex;flex-direction:column;gap:16px}
.free-card{background:var(--card);border:1px solid var(--border);overflow:hidden}
.free-media{position:relative}
.free-media img{width:100%;height:230px;object-fit:cover;display:block;background:#000}
.free-tag{position:absolute;top:12px;left:12px;background:var(--green);color:#04120a;font-family:Oswald,sans-serif;font-weight:700;font-size:17px;letter-spacing:.5px;padding:6px 12px;text-transform:uppercase}
.free-tag.soon{background:var(--amber);color:#221503}
.free-left{position:absolute;right:12px;bottom:12px;background:rgba(0,0,0,.75);color:#fff;font-size:13px;font-weight:600;padding:6px 10px}
.free-body{padding:16px 18px 18px}
.free-body h3{margin:0 0 8px;font-size:21px;font-family:Inter,sans-serif;font-weight:700}
.free-body p{margin:0 0 12px;color:var(--muted);font-size:14px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.free-price{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.free-price .sale{color:var(--green);font-weight:800;font-size:24px}
.free-price .normal{color:var(--muted);text-decoration:line-through;font-size:16px}
.free-price .on{color:var(--muted);font-size:14px}
.free-dates{color:var(--muted);font-size:13px;margin:8px 0 14px}
.badge{display:inline-block;background:var(--green);color:#04120a;font-family:Oswald,sans-serif;font-weight:700;font-size:18px;letter-spacing:.5px;padding:6px 12px;text-transform:uppercase}
.badge.soon{background:var(--amber);color:#221503}
.btn{display:inline-block;background:var(--green);color:#04120a;text-decoration:none;font-family:Oswald,sans-serif;font-weight:700;font-size:18px;letter-spacing:.5px;text-transform:uppercase;padding:12px 22px;border:0;cursor:pointer;border-radius:0}
.btn.ghost{background:var(--card2);border:1px solid var(--border2);color:var(--text);font-size:16px;padding:11px 18px}
.btn.refresh{background:var(--card2);color:#fff;font-size:16px;padding:10px 18px}
.controls{display:flex;flex-direction:column;gap:12px;margin:14px 0}
.controls input[type=search]{width:100%;background:#0d1117;border:1px solid var(--border2);color:var(--text);border-radius:0;padding:13px 14px;font-size:15px}
.sort-row{display:flex;align-items:center;gap:12px}
.sort-row label{color:var(--muted);font-size:15px}
.sort-row select{background:var(--card2);border:1px solid var(--border2);color:var(--text);border-radius:0;padding:10px 12px;font-size:15px}
.tabs{display:flex;flex-wrap:wrap;gap:10px}
.tab{background:var(--card2);border:0;color:var(--muted);font-family:Oswald,sans-serif;font-weight:700;font-size:19px;letter-spacing:.5px;text-transform:uppercase;padding:11px 20px;cursor:pointer;border-radius:0}
.tab.on{background:var(--green);color:#04120a}
.chips{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}
.chip{background:var(--card2);border:0;color:var(--muted);border-radius:0;padding:11px 16px;font-size:15px;font-weight:600;cursor:pointer}
.chip.on{background:#fff;color:#111}
.grid{display:flex;flex-direction:column;gap:14px;margin-top:16px}
.card{background:var(--card);border:1px solid var(--border);position:relative;display:flex;min-height:150px}
.card img{width:150px;min-width:150px;object-fit:contain;background:#000;display:block}
.card-body{padding:14px 16px;flex:1;min-width:0}
.card-body h3{margin:0 0 8px;font-size:17px;line-height:1.35;font-family:Inter,sans-serif;font-weight:700;padding-right:28px}
.store-pill{display:inline-block;border:1px solid var(--border2);color:var(--muted);font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;padding:4px 8px;margin-bottom:10px}
.meta{color:var(--muted);font-size:13px;margin-left:10px}
.meta .steam{color:var(--blue)}
.price-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:2px}
.sale{color:var(--green);font-weight:800;font-size:26px}
.normal{color:var(--muted);text-decoration:line-through;font-size:16px}
.deal-link{color:var(--blue);font-size:16px;font-weight:600;text-decoration:underline;margin-left:auto}
.star{position:absolute;top:10px;right:14px;background:none;border:0;color:var(--muted);cursor:pointer;font-size:21px;line-height:1;padding:0}
.star.saved{color:#ffd166}
.empty{color:var(--muted);padding:30px 0;text-align:center}
footer{color:var(--muted);font-size:12px;margin-top:30px}
@media (min-width:1000px){
  .free-grid{display:grid;grid-template-columns:repeat(2,1fr)}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
}
@media (max-width:560px){
  h2{font-size:26px}
  .card img{width:118px;min-width:118px}
  .sale{font-size:22px}
  .free-media img{height:190px}
}
</style></head>
<body>
<header><div class="topbar"><span class="sub" id="top-status"></span><button class="btn refresh" id="refresh">↻ Refresh</button></div>
<p class="sub" id="status"></p></header>
<main>
<section id="free-section"><h2>Free right now <span class="green">— Epic</span></h2><div class="free-grid" id="free-now"></div>
<h2 class="amber" style="margin-top:28px">Coming free soon</h2><div class="free-grid" id="free-next"></div></section>
<section><div class="controls">
<div class="tabs"><button class="tab on" data-type="all">All deals</button><button class="tab" data-type="free">Free</button><button class="tab" data-type="discounted">Discounted</button><button class="tab" data-type="saved">★ Watchlist <span id="saved-n"></span></button></div>
<input type="search" id="q" placeholder="Search games…">
<div class="sort-row"><label for="sort">Sort</label><select id="sort"><option value="best">Best deal</option><option value="savings">Biggest saving</option><option value="price_low">Lowest price</option><option value="rating">Highest rated</option></select></div>
</div>
<div class="chips" id="chips"></div>
<h2>Top deals <span class="count" id="deal-count"></span></h2>
<div class="grid" id="grid"></div>
<footer>Deals refresh daily. Cover art is served by the stores themselves. Not affiliated with Epic, Steam, GOG, Sony or Nintendo. PlayStation prices via PS Deals (psdeals.net).</footer>
</section></main>
<script>
const device = localStorage.getItem('gd-device') || (()=>{const id='d-'+Math.random().toString(36).slice(2)+Date.now().toString(36);localStorage.setItem('gd-device',id);return id})();
let state={store:'all',type:'all',q:'',sort:'best',stores:[],saved:new Set()};
const $=s=>document.querySelector(s);
function fmt(n){return '$'+Number(n).toFixed(2)}
function left(iso){if(!iso)return '';const ms=new Date(iso)-Date.now();if(ms<=0)return 'ends soon';const d=Math.floor(ms/864e5),h=Math.floor(ms%864e5/36e5),m=Math.floor(ms%36e5/6e4);return d>0?(d+'d '+h+'h left'):(h>0?(h+'h '+m+'m left'):(m+'m left'))}
function fmtDate(iso){if(!iso)return '';return new Date(iso).toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}
async function load(){
  const p=new URLSearchParams({store:state.store,type:state.type==='saved'?'all':state.type,q:state.q,sort:state.sort,limit:200,device});
  const r=await fetch('/api/deals?'+p); const data=await r.json();
  state.stores=data.stores||[];
  renderChips(); renderFree(data.epicFree||[]);
  let deals=data.deals||[];
  if(state.type==='saved') deals=deals.filter(d=>d.saved);
  $('#deal-count').textContent=data.totalDeals+' deals';
  $('#saved-n').textContent=data.savedCount?('('+data.savedCount+')'):'';
  const ps=(state.stores.find(s=>s.storeId==='playstation')||{}).count||0;
  const nin=(state.stores.find(s=>s.storeId==='nintendo')||{}).count||0;
  $('#top-status').textContent=(data.freeCount||0)+' free · updated just now · prices in USD';
  $('#status').textContent='Updated just now — '+data.totalDeals+' deals tracked, including '+ps+' PlayStation and '+nin+' Nintendo.';
  renderGrid(deals);
}
function renderChips(){
  const all=[{storeId:'all',storeName:'All stores',count:null},...state.stores];
  $('#chips').innerHTML=all.map(s=>'<button class="chip'+(state.store===s.storeId?' on':'')+'" data-store="'+s.storeId+'">'+s.storeName+(s.count!=null?' · '+s.count:'')+'</button>').join('');
  document.querySelectorAll('.chip').forEach(c=>c.onclick=()=>{state.store=c.dataset.store;document.querySelectorAll('.chip').forEach(x=>x.classList.remove('on'));c.classList.add('on');load()});
}
function renderFree(list){
  const now=list.filter(e=>e.status==='free_now'), next=list.filter(e=>e.status==='coming_soon');
  const card=e=>{
    const isNow=e.status==='free_now';
    const media='<div class="free-media">'+(e.image_url?'<img src="'+e.image_url+'" alt="">':'')+'<span class="free-tag'+(isNow?'':' soon')+'">'+(isNow?'Free now':'Free soon')+'</span><span class="free-left">⏱ '+(isNow?left(e.ends_at):left(e.starts_at))+'</span></div>';
    const price='<div class="free-price"><span class="sale">'+fmt(0)+'</span>'+(e.original_price?'<span class="normal">'+fmt(e.original_price)+'</span>':'')+'<span class="on">on Epic Games Store</span></div>';
    const dates=isNow?('<div class="free-dates">Claim by '+fmtDate(e.ends_at)+'</div>'):('<div class="free-dates">Starts '+fmtDate(e.starts_at)+' · ends '+fmtDate(e.ends_at)+'</div>');
    const btn=isNow?('<a class="btn" href="'+e.store_url+'" target="_blank" rel="noopener">Claim free →</a>'):('<a class="btn" href="'+e.store_url+'" target="_blank" rel="noopener">View on Epic →</a>');
    return '<div class="free-card">'+media+'<div class="free-body"><h3>'+e.title+'</h3><p>'+(e.description||'')+'</p>'+price+dates+'<div>'+btn+' <button class="btn ghost" data-k="'+e.epic_key+'" onclick="toggleSave(this.dataset.k,this)">'+(e.saved?'★ Saved':'☆ Watch')+'</button></div></div></div>';
  };
  $('#free-now').innerHTML=now.length?now.map(card).join(''):'<p class="empty">No free games right now — check back Thursday.</p>';
  $('#free-next').innerHTML=next.length?next.map(card).join(''):'<p class="empty">Nothing announced yet.</p>';
}
function renderGrid(deals){
  if(!deals.length){$('#grid').innerHTML='<p class="empty">No deals match those filters.</p>';return}
  $('#grid').innerHTML=deals.map(d=>{
    const pct=Math.round(d.savings||0);
    const isFree=d.is_free||d.sale_price===0;
    const meta=(d.metacritic_score?('Metacritic '+d.metacritic_score):'')+(d.steam_rating_percent?(' <span class="steam">Steam '+d.steam_rating_percent+'% positive</span>'):'');
    return '<div class="card"><button class="star'+(d.saved?' saved':'')+'" data-k="'+d.deal_key+'" onclick="toggleSave(this.dataset.k,this)">'+(d.saved?'★':'☆')+'</button>'
    +(d.thumb?'<img src="'+d.thumb+'" alt="" loading="lazy">':'')
    +'<div class="card-body"><h3>'+d.title+'</h3><div><span class="store-pill">'+d.store_name+(d.platform?' · '+d.platform:'')+'</span>'+(meta?'<span class="meta">'+meta+'</span>':'')+'</div>'
    +'<div class="price-row"><span class="badge'+(isFree?'':' soon')+'">'+(isFree?'Free':'-'+pct+'%')+'</span><span class="sale">'+fmt(d.sale_price)+'</span><span class="normal">'+fmt(d.normal_price)+'</span><a class="deal-link" href="'+d.deal_url+'" target="_blank" rel="noopener">View deal →</a></div>'
    +'</div></div>';
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
      if (url.pathname === '/api/sync' && request.method === 'POST') {
        return await syncFromSpace(env, request);
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
    // Disabled: refresh now comes from the Game Deals space push
    // (POST /api/sync). The Worker cron is cleared (wrangler.toml crons
    // = [] and deploy.py clears schedules) so a scheduled Worker refresh
    // can never overwrite synced data.
  },
};
