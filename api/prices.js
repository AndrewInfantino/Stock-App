// Serverless price + daily-change + P/E proxy. Runs free on Vercel.
// GET /api/prices?symbols=AAPL,MSFT,SHOP.TO
//   -> { data: { AAPL: { p: price, c: dayChangePct, pe: trailingPE|null }, ... } }
//
// Primary: Yahoo v7 batch quote (needs a crumb+cookie) -> price, change, P/E in one call.
// Fallback: Yahoo chart endpoint per symbol (no auth) -> price + change (pe stays null),
//           then Stooq -> price only. So prices work even if the crumb flow fails.

const YAHOO_HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
];
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

let CRUMB = null;
let COOKIE = null;

async function ensureCrumb() {
  if (CRUMB && COOKIE) return true;
  try {
    const r1 = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA } });
    let cookies = [];
    if (typeof r1.headers.getSetCookie === "function") cookies = r1.headers.getSetCookie();
    else { const sc = r1.headers.get("set-cookie"); if (sc) cookies = [sc]; }
    COOKIE = cookies.map((c) => c.split(";")[0]).join("; ");
    if (!COOKIE) return false;
    const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, Cookie: COOKIE, Accept: "text/plain" },
    });
    const crumb = (await r2.text()).trim();
    if (crumb && crumb.length < 40 && !crumb.includes("<")) { CRUMB = crumb; return true; }
  } catch (e) { /* fall through */ }
  return false;
}

async function fetchQuotes(symbols) {
  const out = {};
  if (!(await ensureCrumb())) return out;
  for (const host of YAHOO_HOSTS) {
    try {
      const url =
        host + "/v7/finance/quote?symbols=" +
        encodeURIComponent(symbols.join(",")) + "&crumb=" + encodeURIComponent(CRUMB);
      const r = await fetch(url, { headers: { "User-Agent": UA, Cookie: COOKIE } });
      if (!r.ok) { if (r.status === 401) { CRUMB = null; COOKIE = null; } continue; }
      const j = await r.json();
      const arr = (j && j.quoteResponse && j.quoteResponse.result) || [];
      for (const q of arr) {
        if (!q || !q.symbol) continue;
        const p = q.regularMarketPrice;
        if (typeof p !== "number" || p <= 0) continue;
        out[q.symbol] = {
          p,
          c: typeof q.regularMarketChangePercent === "number" ? q.regularMarketChangePercent : null,
          pe: typeof q.trailingPE === "number" ? q.trailingPE : null,
        };
      }
      if (Object.keys(out).length) return out;
    } catch (e) { /* try next host */ }
  }
  return out;
}

async function fromYahooChart(symbol) {
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
      return { p, c, pe: null };
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
    return isFinite(close) && close > 0 ? { p: close, c: null, pe: null } : null;
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  const raw = (req.query && req.query.symbols) || "";
  const symbols = String(raw).split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);

  let data = {};
  try { data = await fetchQuotes(symbols); } catch (e) { data = {}; }

  // Fill any symbol the batch quote missed (price is what matters most)
  await Promise.all(
    symbols.map(async (s) => {
      if (data[s] && typeof data[s].p === "number" && data[s].p > 0) return;
      let q = await fromYahooChart(s);
      if (q == null) q = await fromStooq(s);
      if (q != null) data[s] = q;
    })
  );

  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  res.status(200).json({ data, ts: Date.now() });
};
