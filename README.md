# Approach — buy-target watchlist

A simple mobile web app: all your stocks with live prices, and how far each one
is (in %) from a target price you set. Sort by closeness to target or by the
day's biggest gainers/losers. No accounts, no notifications, no cost.

## Important: prices only work once it's deployed

If you open `index.html` directly on your computer, Refresh will say
**"couldn't load prices."** That is expected — not a bug. Live prices come from
the `/api/prices` function, which needs a server. Deploy to Vercel (below) and
prices work immediately on the live URL.

---

## Deploy it free (about 5 minutes)

You need a free GitHub account and a free Vercel account (sign into Vercel using
your GitHub — easiest path).

### 1. Put the code on GitHub
- github.com → **+** → **New repository** → name it `approach` → **Create**.
- On the empty repo, click **uploading an existing file**.
- Drag in EVERYTHING from this folder: `index.html`, the `api` folder (with
  `prices.js`), `manifest.webmanifest`, and the three icon PNGs
  (`apple-touch-icon.png`, `icon-192.png`, `icon-512.png`).
- **Commit changes.**

### 2. Deploy on Vercel
- vercel.com → **Add New… → Project** → **Import** your `approach` repo.
- Leave all settings default (Framework Preset: **Other**). Click **Deploy**.
- ~30 seconds later you get a live URL like `https://approach-xxxx.vercel.app`.

### 3. Add it to your phone (with the icon)
- Open the Vercel URL in Safari (iPhone) or Chrome (Android).
- **Share → Add to Home Screen.** It installs with the chevron icon and opens
  full screen like an app.

Open it and prices load automatically.

---

## Using it

- **Refresh** — pulls the latest prices (also auto-refreshes when you open it).
- **Big number** on each card = how far price is from your target (e.g.
  `+32.9% above target`); turns copper in the 20/15/10% bands, green at/below target.
- **Coloured pill** by each ticker = today's move (green up / red down).
- **Sort chips** — Closest to target · ▲ Gainers · ▼ Losers.
- **Change a target** — tap the target number on a card.
- **Add a stock** — tap “+ Add a stock”, enter ticker + target.
- **Remove** — tap Remove. **Search** — filter by ticker or company.

Canadian/other tickers use their suffix (e.g. `SHOP.TO`, `PLTR.NE`).

---

## Notes
- Prices are ~15 min delayed (free public data) — for watching, not live trading.
- Gainers/Losers rank by the day-change pulled on Refresh; hit Refresh first.
- Your list is saved in this browser only (no sync across devices).
- A few Canadian CDR tickers may occasionally show `--` if the free source
  doesn't carry them; the target still shows.

### Optional: test locally with prices
Install Node, then `npm i -g vercel` and run `vercel dev` in this folder — that
runs the price function on your machine at `http://localhost:3000`.
