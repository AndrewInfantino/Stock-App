// Serverless price + daily-change proxy. Free on Vercel. No API key.
// GET /api/prices?symbols=AAPL,MSFT,SHOP.TO -> { data: { AAPL:{p,c}, ... }, ts }
//   p = latest price, c = daily change %.  Yahoo chart endpoint, Stooq fallback.

const YAHOO_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

async function fromYahoo(symbol) {
  for (const host of YAHOO_HOSTS) {
    try {
      const url = host + "/v8/finance/chart/" + encodeURIComponent(symbol) + "?interval=1d&range=1d";
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!r.ok) continue;
      const j = await r.json();
      const meta = j && j.chart && j.chart.result && j.chart.result[0] ? j.chart.result[0].meta : null;
      const p = meta ? meta.regularMarketPrice : null;
      if (typeof p !== "number" || p <= 0) continue;
      const prev = meta.previousClose != null ? meta.previousClose : meta.chartPreviousClose;
      const c = typeof prev === "number" && prev > 0 ? ((p - prev) / prev) * 100 : null;
      return { p, c };
    } catch (e) { /* next host */ }
  }
  return null;
}

async function fromStooq(symbol) {
  try {
    const sym = symbol.includes(".") ? symbol.toLowerCase() : symbol.toLowerCase() + ".us";
    const url = "https://stooq.com/q/l/?s=" + encodeURIComponent(sym) + "&f=sd2t2ohlcv&h&e=csv";
    const r = await fetch(url);
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
  const data = {};
  await Promise.all(symbols.map(async (s) => {
    let q = await fromYahoo(s);
    if (q == null) q = await fromStooq(s);
    if (q != null) data[s] = q;
  }));
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  res.status(200).json({ data, ts: Date.now() });
};
