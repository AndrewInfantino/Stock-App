// Serverless price proxy. Runs on Vercel (free). Fetches quotes server-side
// so the browser never hits a CORS wall. No API key required.
// GET /api/prices?symbols=AAPL,MSFT,SHOP.TO  ->  { prices: { AAPL: 306.48, ... } }

const YAHOO_HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
];
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15";

async function fromYahoo(symbol) {
  for (const host of YAHOO_HOSTS) {
    try {
      const url =
        host +
        "/v8/finance/chart/" +
        encodeURIComponent(symbol) +
        "?interval=1d&range=1d";
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!r.ok) continue;
      const j = await r.json();
      const meta =
        j && j.chart && j.chart.result && j.chart.result[0]
          ? j.chart.result[0].meta
          : null;
      const p = meta ? meta.regularMarketPrice : null;
      if (typeof p !== "number" || p <= 0) continue;
      const prev =
        meta.previousClose != null ? meta.previousClose : meta.chartPreviousClose;
      const change =
        typeof prev === "number" && prev > 0 ? ((p - prev) / prev) * 100 : null;
      return { p, c: change };
    } catch (e) {
      /* try next host */
    }
  }
  return null;
}

async function fromStooq(symbol) {
  try {
    const sym = symbol.includes(".")
      ? symbol.toLowerCase()
      : symbol.toLowerCase() + ".us";
    const url =
      "https://stooq.com/q/l/?s=" +
      encodeURIComponent(sym) +
      "&f=sd2t2ohlcv&h&e=csv";
    const r = await fetch(url);
    if (!r.ok) return null;
    const text = await r.text();
    const lines = text.trim().split("\n");
    if (lines.length < 2) return null;
    const close = parseFloat(lines[1].split(",")[6]);
    return isFinite(close) && close > 0 ? { p: close, c: null } : null;
  } catch (e) {
    return null;
  }
}

module.exports = async (req, res) => {
  const raw = (req.query && req.query.symbols) || "";
  const symbols = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);

  const data = {};
  await Promise.all(
    symbols.map(async (sym) => {
      let q = await fromYahoo(sym);
      if (q == null) q = await fromStooq(sym);
      if (q != null) data[sym] = q; // { p: price, c: dailyChangePct|null }
    })
  );

  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  res.status(200).json({ data, ts: Date.now() });
};
