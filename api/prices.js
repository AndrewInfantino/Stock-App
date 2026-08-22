// Serverless price + daily-change + P/E proxy. Free on Vercel.
// GET /api/prices?symbols=AAPL,MSFT,SHOP.TO
//   -> { data: { AAPL: { p, c, pe }, ... }, ts, peCount }
//
// price + daily change  : Yahoo v8 chart endpoint (open, no auth) — always works.
// P/E ratio             : Yahoo v7 quote endpoint (needs a cookie + crumb) — best effort.
//                         If the crumb handshake fails, price/change still return; pe = null.
// Add ?debug=1 to see whether the crumb was obtained.

const YAHOO_HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
];
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

let CREDS = null; // { cookie, crumb }

function collectCookies(res) {
  let arr = [];
  if (typeof res.headers.getSetCookie === "function") arr = res.headers.getSetCookie();
  else { const sc = res.headers.get("set-cookie"); if (sc) arr = [sc]; }
  return arr.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

async function getCreds() {
  if (CREDS) return CREDS;
  // Step 1: obtain an A1/A3 cookie from any Yahoo surface that will set one.
  const cookieSources = [
    "https://fc.yahoo.com/",
    "https://finance.yahoo.com/quote/AAPL/",
    "https://finance.yahoo.com/",
    "https://www.yahoo.com/",
  ];
  let cookie = "";
  for (const u of cookieSources) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "text/html,*/*" } });
      const c = collectCookies(r);
      if (c) { cookie = c; break; }
    } catch (e) { /* next source */ }
  }
  if (!cookie) return null;
  // Step 2: exchange the cookie for a crumb.
  for (const host of YAHOO_HOSTS) {
    try {
      const rc = await fetch(host + "/v1/test/getcrumb", {
        headers: { "User-Agent": UA, Cookie: cookie, Accept: "text/plain" },
      });
      const crumb = (await rc.text()).trim();
      if (crumb && crumb.length < 40 && !crumb.includes("<") && !/error/i.test(crumb)) {
        CREDS = { cookie, crumb };
        return CREDS;
      }
    } catch (e) { /* next host */ }
  }
  return null;
}

async function fetchQuotes(symbols) {
  const out = {};
  const creds = await getCreds();
  if (!creds) return out;
  for (const host of YAHOO_HOSTS) {
    try {
      const url =
        host + "/v7/finance/quote?symbols=" +
        encodeURIComponent(symbols.join(",")) + "&crumb=" + encodeURIComponent(creds.crumb);
      const r = await fetch(url, { headers: { "User-Agent": UA, Cookie: creds.cookie } });
      if (!r.ok) { if (r.status === 401 || r.status === 403) CREDS = null; continue; }
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
    } catch (e) { /* next host */ }
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

  // Ensure every symbol has at least price+change even if the quote call missed it.
  await Promise.all(
    symbols.map(async (s) => {
      if (data[s] && typeof data[s].p === "number" && data[s].p > 0) return;
      let q = await fromYahooChart(s);
      if (q == null) q = await fromStooq(s);
      if (q != null) data[s] = q;
    })
  );

  const peCount = Object.values(data).filter((d) => typeof d.pe === "number").length;
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  const body = { data, ts: Date.now(), peCount };
  if (req.query && req.query.debug) body._crumb = !!CREDS;
  res.status(200).json(body);
};
