// Serverless price + daily-change proxy. Free on Vercel, no API key.
// GET /api/prices?symbols=AAPL,MSFT,SHOP.TO -> { data: { AAPL:{p,c}, ... }, ts }
//
// PRIMARY: Yahoo "spark" endpoint returns MANY symbols in ONE request, so a whole
// batch is a single call instead of one-request-per-ticker. This avoids the burst
// rate-limiting that was leaving most tickers blank.
// FALLBACK: per-symbol chart, then Stooq, only for whatever the batch missed.

const YAHOO_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

async function fetchT(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal })); }
  finally { clearTimeout(t); }
}

function priceChange(meta, resp) {
  let p = meta && meta.regularMarketPrice;
  if (typeof p !== "number" || p <= 0) {
    const q = resp && resp.indicators && resp.indicators.quote && resp.indicators.quote[0];
    const closes = q && q.close;
    if (Array.isArray(closes)) {
      for (let i = closes.length - 1; i >= 0; i--) { if (typeof closes[i] === "number") { p = closes[i]; break; } }
    }
  }
  if (typeof p !== "number" || p <= 0) return null;
  const prev = meta && (meta.previousClose != null ? meta.previousClose : meta.chartPreviousClose);
  const c = typeof prev === "number" && prev > 0 ? ((p - prev) / prev) * 100 : null;
  return { p, c };
}

async function fromSpark(symbols) {
  const out = {};
  for (const host of YAHOO_HOSTS) {
    try {
      const url = host + "/v8/finance/spark?symbols=" + encodeURIComponent(symbols.join(",")) + "&range=1d&interval=1d";
      const r = await fetchT(url, { headers: { "User-Agent": UA, Accept: "application/json" } }, 8000);
      if (!r.ok) continue;
      const j = await r.json();
      const results = j && j.spark && j.spark.result ? j.spark.result : [];
      for (const item of results) {
        const sym = item && item.symbol;
        const resp = item && item.response && item.response[0];
        const meta = resp && resp.meta;
        if (!sym || !meta) continue;
        const pc = priceChange(meta, resp);
        if (pc) out[sym] = pc;
      }
      if (Object.keys(out).length) return out;
    } catch (e) { /* next host */ }
  }
  return out;
}

async function fromChart(symbol) {
  for (const host of YAHOO_HOSTS) {
    try {
      const url = host + "/v8/finance/chart/" + encodeURIComponent(symbol) + "?interval=1d&range=1d";
      const r = await fetchT(url, { headers: { "User-Agent": UA } }, 4500);
      if (!r.ok) continue;
      const j = await r.json();
      const resp = j && j.chart && j.chart.result && j.chart.result[0];
      const meta = resp && resp.meta;
      if (!meta) continue;
      const pc = priceChange(meta, resp);
      if (pc) return pc;
    } catch (e) { /* next host */ }
  }
  return null;
}

async function fromStooq(symbol) {
  try {
    const sym = symbol.includes(".") ? symbol.toLowerCase() : symbol.toLowerCase() + ".us";
    const url = "https://stooq.com/q/l/?s=" + encodeURIComponent(sym) + "&f=sd2t2ohlcv&h&e=csv";
    const r = await fetchT(url, {}, 4500);
    if (!r.ok) return null;
    const lines = (await r.text()).trim().split("\n");
    if (lines.length < 2) return null;
    const close = parseFloat(lines[1].split(",")[6]);
    return isFinite(close) && close > 0 ? { p: close, c: null } : null;
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  const raw = (req.query && req.query.symbols) || "";
  const symbols = String(raw).split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);

  let data = {};
  try { data = await fromSpark(symbols); } catch (e) { data = {}; }

  const missing = symbols.filter((s) => !(data[s] && typeof data[s].p === "number" && data[s].p > 0));
  await Promise.all(missing.map(async (s) => {
    let q = await fromChart(s);
    if (q == null) q = await fromStooq(s);
    if (q != null) data[s] = q;
  }));

  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  res.status(200).json({ data, ts: Date.now() });
};
