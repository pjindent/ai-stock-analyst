# 📊 AI Stock Analyst

A token-efficient stock analysis app built with Claude AI. Fetches live market data from **yfinance** (free, no API key) via a local Python server, then uses Claude to write a ~300-token recommendation — no web search tokens wasted on data retrieval.

> **Full write-up:** [Building a Token-Efficient Stock Analyst with Claude Skills](./stock-analyst-article.docx)

---

## How It Works

```
Claude Artifact (browser)
        │
        ▼  GET /batch?tickers=AAPL,NVDA   (0 tokens — direct HTTP)
Local Python Server  ──▶  yfinance / Finnhub  ──▶  price, P/E, RSI, MACD, OBV, news
        │
        ▼  pre-built JSON passed to Claude
Anthropic Claude API  ──▶  rating, target, stop-loss, bull/bear case  (~300 tokens)
```

**Token cost per ticker: ~300** (recommendation only — all data fetched by the local server at zero token cost)

| Approach | Tokens / ticker | Works in sandbox? |
|---|---|---|
| Claude web search (naive) | ~2,500–6,000 | ✅ |
| Direct API call from artifact | ~300 | ❌ CORS blocked |
| **Local Python server (this app)** | **~300** | **✅ via localhost** |

---

## Features

- **Live market data** — price, change %, market cap, volume
- **Fundamentals** — P/E, Forward P/E, PEG, P/B, EPS (trailing + forward), dividend yield, beta, ROE, revenue growth, gross margins
- **Technicals** — SMA 50 & 200, RSI (14), MACD (12/26/9), OBV trend — all calculated in Python from 1-year daily candles
- **52-week range** — visual position bar
- **60-day sparkline** chart
- **AI recommendation** — rating, entry price, 12-month target, stop-loss, upside %, confidence, bull/bear case, Zacks rank estimate
- **Watchlist** — persists across sessions via Claude's storage API
- **Smart caching** — market data cached 5 min, recommendations persist until manually refreshed
- **Batch fetch** — up to 6 tickers in one server call
- **Hybrid mode** — Quick card view for all tickers, Full Report on demand per ticker

---

## Files

| File | Purpose |
|---|---|
| `server.py` | Local Python data server (Flask + yfinance) |
| `stock-analyzer.jsx` | Claude React artifact (the UI) |
| `stock-analyst-skill.zip` | Claude Skill package (upload to claude.ai) |
| `stock-analyst-article.docx` | Full case study write-up |

---

## Quick Start

### 1. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/ai-stock-analyst.git
cd ai-stock-analyst
```

### 2. Install Python dependencies

```bash
pip install yfinance flask flask-cors requests
```

### 3. (Optional) Add a Finnhub key for fallback data

```bash
# Mac / Linux
export FINNHUB_KEY=your_key_here

# Windows
set FINNHUB_KEY=your_key_here
```

Get a free key at [finnhub.io](https://finnhub.io) — 60 calls/min on the free tier.

### 4. Start the local server

```bash
python server.py
```

You should see:
```
╔══════════════════════════════════════════════════╗
║       Stock Analyst Local Data Server            ║
╠══════════════════════════════════════════════════╣
║  Running on: http://localhost:7823               ║
║  yfinance:   ✓ ready                             ║
╚══════════════════════════════════════════════════╝
```

### 5. Verify it's working

```bash
curl http://localhost:7823/health
# → {"status": "ok", "yfinance": true, ...}

curl "http://localhost:7823/stock/AAPL"
# → full JSON data for Apple
```

### 6. Upload the Claude Skill

1. Go to [claude.ai](https://claude.ai)
2. Open your profile → **Customize → Skills**
3. Click **Add Skill** and upload `stock-analyst-skill.zip`

### 7. Open the artifact in Claude

Open `stock-analyzer.jsx` in claude.ai. The green **"Online · 0 tokens"** indicator confirms your server is connected.

---

## Usage

1. Type up to 6 ticker symbols (comma or space separated): `AAPL NVDA TSLA GOOG`
2. Click **Fetch Data →** — the server retrieves live data, zero tokens used
3. Cards appear for each ticker with price, RSI, P/E, technical signal
4. Click **⚡ Get AI Recommendation** on any card — Claude analyzes the pre-fetched data (~300 tokens)
5. Click **View Full Detail →** for the complete report with sparkline, news, bull/bear case

### API Endpoints

```
GET /health                          Server status
GET /stock/AAPL                      Single ticker
GET /batch?tickers=AAPL,NVDA,TSLA    Up to 6 tickers
```

### Supported Tickers

- **US stocks**: `AAPL`, `NVDA`, `MSFT`, `TSLA`, `META`, `GOOG`
- **ETFs**: `SPY`, `QQQ`, `VTI`
- **Indices**: `^GSPC`, `^NDX`
- **International**: `RELIANCE.NS` (NSE), `VOD.L` (LSE), `SAP.DE` (XETRA)

---

## Configuration

**Change the port:**
```bash
PORT=8080 python server.py
```
Then update line 4 of `stock-analyzer.jsx`:
```javascript
const SERVER = "http://localhost:8080";
```

---

## Token Breakdown

For a typical session — scan 4 tickers, get 2 full reports:

| Action | Tokens |
|---|---|
| Fetch data for 4 tickers (server) | 0 |
| Quick scan cards (no AI call needed) | 0 |
| Full AI recommendation × 2 | ~600 |
| Re-fetch same tickers (cached) | 0 |
| **Total** | **~600** |

Compare to the naive web-search approach: ~40,000 tokens for the same session.

---

## Requirements

- Python 3.8+
- `yfinance`, `flask`, `flask-cors`, `requests`
- A [claude.ai](https://claude.ai) account (free or Pro)
- The server must be running locally when using the artifact

---

## Background

This app was built iteratively through a conversation with Claude, starting from a single prompt. The full story — including two failed approaches and five token optimisation techniques — is documented in `stock-analyst-article.docx`.

Key lessons:
- Claude artifacts **cannot** make outbound HTTP calls to external APIs (CORS-blocked sandbox)
- A local Python server sidesteps this entirely via localhost
- Separating data fetching (code) from synthesis (Claude) reduces token cost by ~90%

---

## Disclaimer

This application is for **educational and demonstration purposes only**. Nothing in this app constitutes financial advice. Always do your own research before making investment decisions.

---

## License

MIT
