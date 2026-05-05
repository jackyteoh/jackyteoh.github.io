/**
 * TCG Tracker — Cloudflare Worker Proxy  v1
 *
 * PURPOSE
 * -------
 * The tracker runs entirely client-side, so we cannot safely embed a
 * JustTCG API key in the browser. This Worker sits in front of both
 * JustTCG (JP card data + pricing) and TCGdex (card images / metadata),
 * forwards requests, and adds the secret key server-side.
 *
 * DEPLOYMENT (one-time, ~5 minutes)
 * ----------------------------------
 * 1. Sign up at https://dash.cloudflare.com (free account)
 * 2. Go to Workers & Pages → Create application → Create Worker
 * 3. Paste this file into the editor and click Deploy
 * 4. In Settings → Variables → add Secret:
 *      JUSTTCG_API_KEY = tcg_your_key_here
 * 5. Copy your worker URL (e.g. https://tcg-proxy.yourname.workers.dev)
 * 6. Paste it into tracker/js/core.js as PROXY_BASE_URL (see comment there)
 *
 * ROUTES HANDLED
 * --------------
 *  GET /jp/search?q=Charizard&set=sv6a&page=1
 *      → JustTCG  GET /v1/cards?game=pokemon-japanese&q=…
 *
 *  GET /jp/prices?id=<justtcgCardId>&printing=Holo&condition=NM
 *      → JustTCG  GET /v1/cards?id=…&printing=…&condition=…
 *
 *  GET /jp/sets
 *      → JustTCG  GET /v1/sets?game=pokemon-japanese&orderBy=release_date&order=desc
 *
 *  GET /en/promo/search?q=Victini
 *      → pokemontcg.io  (no key needed, but proxied for uniform CORS)
 *
 * CORS
 * ----
 * Sends Access-Control-Allow-Origin: * so the tracker can call it from
 * any local or hosted origin. Tighten to your domain once deployed.
 */

const JUSTTCG_BASE = 'https://api.justtcg.com/v1';

export default {
  async fetch(request, env) {
    // Pre-flight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    try {
      // ── JP card search ──────────────────────────────────────────────
      if (path === '/jp/search') {
        const q    = url.searchParams.get('q')   || '';
        const set  = url.searchParams.get('set') || '';
        const page = url.searchParams.get('page') || '1';

        const params = new URLSearchParams({
          game:    'pokemon-japanese',
          orderBy: 'name',
          order:   'asc',
          page,
        });
        if (q)   params.set('q',   q);
        if (set) params.set('set', set);

        const upstream = await fetch(`${JUSTTCG_BASE}/cards?${params}`, {
          headers: justTCGHeaders(env),
        });
        const data = await upstream.json();
        return json(normaliseSearchResults(data), upstream.status);
      }

      // ── JP price fetch by card id ───────────────────────────────────
      if (path === '/jp/prices') {
        const id        = url.searchParams.get('id')        || '';
        const printing  = url.searchParams.get('printing')  || '';
        const condition = url.searchParams.get('condition') || 'NM';

        if (!id) return json({ error: 'id required' }, 400);

        const params = new URLSearchParams({ condition, include_price_history: 'false' });
        if (printing) params.set('printing', printing);

        const upstream = await fetch(`${JUSTTCG_BASE}/cards?id=${encodeURIComponent(id)}&${params}`, {
          headers: justTCGHeaders(env),
        });
        const data = await upstream.json();
        return json(normalisePriceResult(data), upstream.status);
      }

      // ── JP sets list ────────────────────────────────────────────────
      if (path === '/jp/sets') {
        const upstream = await fetch(
          `${JUSTTCG_BASE}/sets?game=pokemon-japanese&orderBy=release_date&order=desc`,
          { headers: justTCGHeaders(env) }
        );
        const data = await upstream.json();
        return json(normaliseSets(data), upstream.status);
      }

      // ── EN sets list (for promo set browsing) ──────────────────────
      if (path === '/en/sets') {
        const upstream = await fetch(
          `${JUSTTCG_BASE}/sets?game=pokemon&orderBy=release_date&order=desc`,
          { headers: justTCGHeaders(env) }
        );
        const data = await upstream.json();
        return json(normaliseSets(data), upstream.status);
      }

      // ── Health check ────────────────────────────────────────────────
      if (path === '/health') {
        return json({ ok: true, ts: Date.now() });
      }

      return json({ error: 'Not found' }, 404);

    } catch (err) {
      return json({ error: err.message || 'Internal error' }, 500);
    }
  },
};

/* ── Helpers ─────────────────────────────────────────────────── */

function justTCGHeaders(env) {
  return {
    'x-api-key':    env.JUSTTCG_API_KEY || '',
    'Content-Type': 'application/json',
    'Accept':       'application/json',
  };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

/**
 * Normalise JustTCG card list into the shape our tracker expects.
 * JustTCG card objects: { id, name, set_name, set_id, image_url, variants: [...] }
 * We return: { cards: [...normalised], total }
 */
function normaliseSearchResults(raw) {
  const cards = (raw?.data || []).map(card => ({
    id:       card.id,
    name:     card.name || '',
    number:   card.number || '',
    setName:  card.set_name || '',
    setId:    card.set_id   || '',
    imageUrl: card.image_url || card.image || '',
    // Collect unique printings so the user can pick a finish
    printings: [...new Set((card.variants || []).map(v => v.printing).filter(Boolean))],
    // Best NM market price across all printings (for display in search results)
    marketPreview: (() => {
      const nm = (card.variants || []).filter(v => v.condition === 'NM' || v.condition === 'Near Mint');
      const best = nm.sort((a, b) => (b.market_price_cents || 0) - (a.market_price_cents || 0))[0];
      return best ? best.market_price_cents / 100 : null;
    })(),
  }));
  return { cards, total: raw?.total || cards.length };
}

/**
 * Normalise a JustTCG single-card price response into { market, low, mid }.
 * JustTCG variant objects have: { condition, printing, market_price_cents,
 *   low_price_cents, mid_price_cents, ... }
 */
function normalisePriceResult(raw) {
  const variants = raw?.data?.[0]?.variants || [];
  if (!variants.length) return { market: null, low: null, mid: null, variants: [] };

  // Return all NM variants so the caller can pick the right printing
  const nmVariants = variants
    .filter(v => v.condition === 'NM' || v.condition === 'Near Mint')
    .map(v => ({
      printing: v.printing || 'Normal',
      market:   v.market_price_cents != null ? v.market_price_cents / 100 : null,
      low:      v.low_price_cents    != null ? v.low_price_cents    / 100 : null,
      mid:      v.mid_price_cents    != null ? v.mid_price_cents    / 100 : null,
    }));

  // Best guess for the requested printing (caller can also pick from variants array)
  const best = nmVariants[0] || { market: null, low: null, mid: null };

  return {
    market:   best.market,
    low:      best.low,
    mid:      best.mid,
    variants: nmVariants,
  };
}

/**
 * Normalise sets list into { id, name, releaseDate }.
 */
function normaliseSets(raw) {
  return (raw?.data || []).map(s => ({
    id:          s.id   || '',
    name:        s.name || '',
    releaseDate: s.release_date || '',
    cardCount:   s.cards_count  || 0,
  }));
}
