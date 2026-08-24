// Serverless price + daily-change + P/E proxy. Free on Vercel.
// GET /api/prices?symbols=AAPL,MSFT,SHOP.TO  -> { data:{SYM:{p,c,pe}}, ts, peCount }
//
// PRICE + CHANGE : Yahoo v8 chart (open, no auth). This is the reliable path and it
//                  NEVER depends on the P/E handshake.
// P/E            : Yahoo v7 quote (needs cookie+crumb). Best effort, runs in parallel,
//                  and negative-caches failure so it can't slow the price path.

const YAHOO_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

let CREDS = null;          // { cookie, crumb }
let credsFailUntil = 0;    // negative cache: skip the handshake until this time

async function fetchT(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal })); }
  finally { clearTimeout(t); }
}

function collectCookies(res) {
  let arr = [];
  if (typeof res.headers.getSetCookie === "function") arr = res.headers.getSetCookie();
  else { const sc = res.headers.get("set-cookie"); if (sc) arr = [sc]; }
  return arr.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

async function getCreds() {
  if (CREDS) return CREDS;
  if (Date.now() < credsFailUntil) return null; // don't hammer while known-broken
  let cookie = "";
  try {
    const r = await fetchT("https://fc.yahoo.com/", { headers: { "User-Agent": UA } }, 2500);
    cookie = collectCookies(r);
  } catch (e) { /* ignore */ }
  if (!cookie) { credsFailUntil = Date.now() + 5 * 60 * 1000; return null; }
  for (const host of YAHOO_HOSTS) {
    try {
      const rc = await fetchT(host + "/v1/test/getcrumb",
        { headers: { "User-Agent": UA, Cookie: cookie, Accept: "text/plain" } }, 2500);
      const crumb = (await rc.text()).trim();
      if (crumb && crumb.length < 40 && !crumb.includes("<") && !/error/i.test(crumb)) {
        CREDS = { cookie, crumb };
        return CREDS;
      }
    } catch (e) { /* next host */ }
  }
  credsFailUntil = Date.now() + 5 * 60 * 1000;
  return null;
}

async function fetchPEs(symbols, creds) {
  const out = {};
  for (const host of YAHOO_HOSTS) {
    try {
      const url = host + "/v7/finance/quote?symbols=" +
        encodeURIComponent(symbols.join(",")) + "&crumb=" + encodeURIComponent(creds.crumb);
      const r = await fetchT(url, { headers: { "User-Agent": UA, Cookie: creds.cookie } }, 3500);
      if (!r.ok) { if (r.status === 401 || r.status === 403) { CREDS = null; credsFailUntil = Date.now() + 5 * 60 * 1000; } continue; }
      const j = await r.json();
      const arr = (j && j.quoteResponse && j.quoteResponse.result) || [];
      for (const q of arr) if (q && q.symbol && typeof q.trailingPE === "number") out[q.symbol] = q.trailingPE;
      if (Object.keys(out).length) return out;
    } catch (e) { /* next host */ }
  }
  return out;
}

async function fromChart(symbol) {
  for (const host of YAHOO_HOSTS) {
    try {
      const url = host + "/v8/finance/chart/" + encodeURIComponent(symbol) + "?interval=1d&range=1d";
      const r = await fetchT(url, { headers: { "User-Agent": UA } }, 4000);
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
    const r = await fetchT(url, {}, 4000);
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

  const data = {};

  // Kick off price fetching and the P/E handshake AT THE SAME TIME.
  const pricePromise = Promise.all(
    symbols.map(async (s) => {
      let q = await fromChart(s);
      if (q == null) q = await fromStooq(s);
      if (q != null) data[s] = q;
    })
  );
  const credsPromise = getCreds().catch(() => null);

  await pricePromise;              // prices are guaranteed here regardless of P/E
  const creds = await credsPromise;

  if (creds) {
    try {
      const pes = await fetchPEs(symbols, creds);
      for (const s of Object.keys(pes)) if (data[s]) data[s].pe = pes[s];
    } catch (e) { /* P/E stays null */ }
  }

  const peCount = Object.values(data).filter((d) => typeof d.pe === "number").length;
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  const body = { data, ts: Date.now(), peCount };
  if (req.query && req.query.debug) body._crumb = !!CREDS;
  res.status(200).json(body);
};
