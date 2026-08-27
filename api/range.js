// 52-week low/high per symbol, batched. Free, no key.
// GET /api/range?symbols=AAPL,SHOP.TO -> { data: { AAPL:{low,high}, ... }, ts }
// Uses Yahoo spark with range=1y (one request for many symbols). 52-week levels move
// slowly, so this is cached hard and the app only refreshes it about once a day.

const YAHOO_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

async function fetchT(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal })); }
  finally { clearTimeout(t); }
}

async function rangeBatch(symbols) {
  const out = {};
  for (const host of YAHOO_HOSTS) {
    try {
      const url = host + "/v8/finance/spark?symbols=" + encodeURIComponent(symbols.join(",")) + "&range=1y&interval=1d";
      const r = await fetchT(url, { headers: { "User-Agent": UA, Accept: "application/json" } }, 9000);
      if (!r.ok) continue;
      const j = await r.json();
      const results = j && j.spark && j.spark.result ? j.spark.result : [];
      for (const item of results) {
        const sym = item && item.symbol;
        const resp = item && item.response && item.response[0];
        if (!sym || !resp) continue;
        const meta = resp.meta || {};
        let low = typeof meta.fiftyTwoWeekLow === "number" ? meta.fiftyTwoWeekLow : null;
        let high = typeof meta.fiftyTwoWeekHigh === "number" ? meta.fiftyTwoWeekHigh : null;
        if (low == null || high == null) {
          const q = resp.indicators && resp.indicators.quote && resp.indicators.quote[0];
          const closes = q && q.close;
          if (Array.isArray(closes)) {
            let mn = Infinity, mx = -Infinity;
            for (const v of closes) { if (typeof v === "number") { if (v < mn) mn = v; if (v > mx) mx = v; } }
            if (low == null && isFinite(mn)) low = mn;
            if (high == null && isFinite(mx)) high = mx;
          }
        }
        const o = {};
        if (typeof low === "number" && low > 0) o.low = low;
        if (typeof high === "number" && high > 0) o.high = high;
        if (o.low || o.high) out[sym] = o;
      }
      if (Object.keys(out).length) return out;
    } catch (e) { /* next host */ }
  }
  return out;
}

module.exports = async (req, res) => {
  const raw = (req.query && req.query.symbols) || "";
  const symbols = String(raw).split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
  let data = {};
  try { data = await rangeBatch(symbols); } catch (e) { data = {}; }
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
  res.status(200).json({ data, ts: Date.now() });
};
