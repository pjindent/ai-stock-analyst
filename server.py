#!/usr/bin/env python3
"""
Stock Analyst Local Data Server
================================
Runs on http://localhost:7823
Fetches market data from yfinance (free, no key) and optionally Finnhub.
The Claude artifact calls this server — no web search tokens needed.

Install & run:
    pip install yfinance flask flask-cors requests
    python server.py

Optional — for Finnhub fallback:
    set FINNHUB_KEY=your_key_here   (Windows)
    export FINNHUB_KEY=your_key_here  (Mac/Linux)
"""

import os, math, json, traceback
from datetime import datetime, timedelta
from flask import Flask, jsonify, request
from flask_cors import CORS

# ── Optional imports (graceful fallback if not installed) ────────────────────
try:
    import yfinance as yf
    HAS_YF = True
except ImportError:
    HAS_YF = False
    print("⚠  yfinance not installed. Run: pip install yfinance")

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

FINNHUB_KEY = os.environ.get("FINNHUB_KEY", "")
PORT = int(os.environ.get("PORT", 7823))

app = Flask(__name__)
CORS(app, origins=["*"])  # Allow calls from Claude artifact (any origin)


# ── HELPERS ──────────────────────────────────────────────────────────────────

def safe(val, decimals=2):
    """Return rounded float or None — avoids NaN/Inf JSON issues."""
    if val is None:
        return None
    try:
        f = float(val)
        if math.isnan(f) or math.isinf(f):
            return None
        return round(f, decimals)
    except (TypeError, ValueError):
        return None


def calc_rsi(closes, period=14):
    if len(closes) < period + 1:
        return None
    gains = losses = 0.0
    for i in range(len(closes) - period, len(closes)):
        d = closes[i] - closes[i - 1]
        if d > 0:
            gains += d
        else:
            losses -= d
    ag, al = gains / period, losses / period
    if al == 0:
        return 100.0
    return round(100 - 100 / (1 + ag / al), 2)


def calc_sma(closes, n):
    if len(closes) < n:
        return None
    return round(sum(closes[-n:]) / n, 2)


def calc_ema(closes, n):
    if len(closes) < n:
        return None
    k = 2 / (n + 1)
    e = sum(closes[:n]) / n
    for v in closes[n:]:
        e = v * k + e * (1 - k)
    return round(e, 4)


def calc_macd(closes):
    if len(closes) < 35:
        return None
    series = []
    for i in range(26, len(closes) + 1):
        e12 = calc_ema(closes[:i], 12)
        e26 = calc_ema(closes[:i], 26)
        if e12 and e26:
            series.append(e12 - e26)
    if not series:
        return None
    macd_line = series[-1]
    signal    = calc_ema(series, 9) if len(series) >= 9 else None
    histogram = round(macd_line - signal, 4) if signal is not None else None
    return {
        "macdLine":  round(macd_line, 4),
        "signal":    round(signal, 4) if signal else None,
        "histogram": histogram,
        "trend":     "bullish" if histogram and histogram > 0 else "bearish"
    }


def calc_obv(closes, volumes, n=20):
    length = min(len(closes), len(volumes), n)
    if length < 5:
        return "neutral"
    obv, arr = 0, [0]
    start = len(closes) - length
    for i in range(start + 1, len(closes)):
        v = volumes[i] or 0
        if closes[i] > closes[i - 1]:
            obv += v
        elif closes[i] < closes[i - 1]:
            obv -= v
        arr.append(obv)
    mid = arr[len(arr) // 2]
    if obv > mid * 1.02:
        return "rising"
    if obv < mid * 0.98:
        return "falling"
    return "neutral"


def overall_signal(ma50_sig, ma200_sig, rsi, macd_trend, obv):
    bull = bear = 0
    if ma50_sig  == "above": bull += 1
    elif ma50_sig == "below": bear += 1
    if ma200_sig == "above": bull += 1
    elif ma200_sig == "below": bear += 1
    if rsi:
        if rsi > 55: bull += 1
        elif rsi < 45: bear += 1
    if macd_trend == "bullish": bull += 1
    elif macd_trend == "bearish": bear += 1
    if obv == "rising": bull += 1
    elif obv == "falling": bear += 1
    if bull > bear + 1: return "bullish"
    if bear > bull + 1: return "bearish"
    return "neutral"


# ── yfinance DATA FETCH ───────────────────────────────────────────────────────

def fetch_yfinance(ticker):
    t = yf.Ticker(ticker)
    info = t.info or {}

    # 1-year daily history
    hist = t.history(period="1y", interval="1d")
    closes  = [safe(v) for v in hist["Close"].tolist()  if v is not None]
    volumes = [safe(v, 0) for v in hist["Volume"].tolist() if v is not None]

    if not closes:
        raise ValueError(f"No price history found for {ticker}")

    cp      = closes[-1]
    pc      = closes[-2] if len(closes) > 1 else cp
    change  = round(cp - pc, 2)
    chg_pct = round((change / pc) * 100, 2) if pc else 0

    w52h = safe(info.get("fiftyTwoWeekHigh"))
    w52l = safe(info.get("fiftyTwoWeekLow"))
    w52pos = None
    if w52h and w52l and w52h != w52l:
        w52pos = round(((cp - w52l) / (w52h - w52l)) * 100)

    ma50  = calc_sma(closes, 50)
    ma200 = calc_sma(closes, 200)
    rsi   = calc_rsi(closes)
    macd  = calc_macd(closes)
    obv   = calc_obv(closes, volumes)

    ma50_sig  = ("above" if cp > ma50  else "below") if ma50  else None
    ma200_sig = ("above" if cp > ma200 else "below") if ma200 else None
    tech_sig  = overall_signal(ma50_sig, ma200_sig, rsi,
                               macd["trend"] if macd else None, obv)

    rsi_sig = "neutral"
    if rsi:
        rsi_sig = "overbought" if rsi > 70 else "oversold" if rsi < 30 else "neutral"

    # Market cap formatting
    mc_raw = info.get("marketCap")
    if mc_raw:
        if mc_raw >= 1e12:
            mc_fmt = f"${mc_raw/1e12:.2f}T"
        elif mc_raw >= 1e9:
            mc_fmt = f"${mc_raw/1e9:.1f}B"
        else:
            mc_fmt = f"${mc_raw/1e6:.0f}M"
    else:
        mc_fmt = None

    vol_raw = info.get("volume")
    vol_fmt = f"{vol_raw/1e6:.1f}M" if vol_raw else None

    return {
        "ticker":      ticker.upper(),
        "companyName": info.get("longName") or info.get("shortName") or ticker,
        "sector":      info.get("sector", ""),
        "industry":    info.get("industry", ""),
        "exchange":    info.get("exchange", ""),
        "source":      "yfinance",
        "asOf":        datetime.now().strftime("%B %d, %Y %H:%M"),
        "price": {
            "current":       cp,
            "change":        change,
            "changePct":     chg_pct,
            "open":          safe(info.get("open")),
            "dayHigh":       safe(info.get("dayHigh")),
            "dayLow":        safe(info.get("dayLow")),
            "prevClose":     safe(info.get("previousClose")),
            "week52High":    w52h,
            "week52Low":     w52l,
            "week52Pos":     w52pos,
            "marketCap":     mc_fmt,
            "volume":        vol_fmt,
            "avgVolume":     f"{info.get('averageVolume',0)/1e6:.1f}M" if info.get("averageVolume") else None,
        },
        "valuation": {
            "peRatio":    safe(info.get("trailingPE")),
            "forwardPE":  safe(info.get("forwardPE")),
            "pegRatio":   safe(info.get("pegRatio")),
            "pbRatio":    safe(info.get("priceToBook")),
            "psRatio":    safe(info.get("priceToSalesTrailing12Months")),
            "epsTrailing":safe(info.get("trailingEps")),
            "epsForward": safe(info.get("forwardEps")),
            "divYield":   f"{safe(info.get('dividendYield',''))*100:.2f}%" if info.get("dividendYield") else None,
            "beta":       safe(info.get("beta")),
            "roe":        f"{safe(info.get('returnOnEquity',''))*100:.1f}%" if info.get("returnOnEquity") else None,
            "revenueGrowth": f"{safe(info.get('revenueGrowth',''))*100:.1f}%" if info.get("revenueGrowth") else None,
            "grossMargins":  f"{safe(info.get('grossMargins',''))*100:.1f}%" if info.get("grossMargins") else None,
        },
        "technicals": {
            "ma50":           ma50,
            "ma200":          ma200,
            "priceVsMa50":    ma50_sig,
            "priceVsMa200":   ma200_sig,
            "rsi":            rsi,
            "rsiSignal":      rsi_sig,
            "macd":           macd["trend"]     if macd else "neutral",
            "macdLine":       macd["macdLine"]  if macd else None,
            "macdSignal":     macd["signal"]    if macd else None,
            "macdHist":       macd["histogram"] if macd else None,
            "obv":            obv,
            "overallTechnical": tech_sig,
            "sparkline":      closes[-60:],
        },
        "news": fetch_news_yf(t),
    }


def fetch_news_yf(ticker_obj):
    """Fetch recent news via yfinance."""
    try:
        news = ticker_obj.news or []
        items = []
        for n in news[:6]:
            items.append({
                "title":     n.get("title", ""),
                "publisher": n.get("publisher", ""),
                "time":      datetime.fromtimestamp(n.get("providerPublishTime", 0))
                             .strftime("%b %d, %Y"),
                "url":       n.get("link", ""),
            })
        return items
    except Exception:
        return []


# ── FINNHUB FALLBACK ─────────────────────────────────────────────────────────

def fetch_finnhub(ticker):
    """Fallback to Finnhub if FINNHUB_KEY is set and yfinance fails."""
    if not FINNHUB_KEY or not HAS_REQUESTS:
        raise ValueError("Finnhub key not configured")

    base = "https://finnhub.io/api/v1"
    def fh(path):
        r = requests.get(f"{base}{path}&token={FINNHUB_KEY}", timeout=10)
        r.raise_for_status()
        return r.json()

    now   = int(datetime.now().timestamp())
    year  = now - 365 * 86400
    quote   = fh(f"/quote?symbol={ticker}")
    profile = fh(f"/stock/profile2?symbol={ticker}")
    metrics = fh(f"/stock/metric?symbol={ticker}&metric=all")
    candles = fh(f"/stock/candle?symbol={ticker}&resolution=D&from={year}&to={now}")

    if not quote or quote.get("c", 0) == 0:
        raise ValueError(f"No Finnhub data for {ticker}")

    closes  = candles.get("c", [])
    volumes = candles.get("v", [])
    m       = metrics.get("metric", {})
    cp      = quote["c"]
    pc      = quote.get("pc", cp)

    w52h   = m.get("52WeekHigh")
    w52l   = m.get("52WeekLow")
    w52pos = round(((cp - w52l) / (w52h - w52l)) * 100) if w52h and w52l and w52h != w52l else None

    ma50      = calc_sma(closes, 50)
    ma200     = calc_sma(closes, 200)
    rsi       = calc_rsi(closes)
    macd      = calc_macd(closes)
    obv       = calc_obv(closes, volumes)
    ma50_sig  = ("above" if cp > ma50  else "below") if ma50  else None
    ma200_sig = ("above" if cp > ma200 else "below") if ma200 else None
    tech_sig  = overall_signal(ma50_sig, ma200_sig, rsi,
                               macd["trend"] if macd else None, obv)

    return {
        "ticker":      ticker.upper(),
        "companyName": profile.get("name", ticker),
        "sector":      profile.get("finnhubIndustry", ""),
        "exchange":    profile.get("exchange", ""),
        "source":      "finnhub",
        "asOf":        datetime.now().strftime("%B %d, %Y %H:%M"),
        "price": {
            "current":    safe(cp),
            "change":     safe(cp - pc),
            "changePct":  safe(((cp - pc) / pc) * 100) if pc else 0,
            "week52High": safe(w52h),
            "week52Low":  safe(w52l),
            "week52Pos":  w52pos,
            "marketCap":  f"${profile.get('marketCapitalization',0)/1000:.1f}B" if profile.get("marketCapitalization") else None,
        },
        "valuation": {
            "peRatio":   safe(m.get("peNormalizedAnnual")),
            "forwardPE": safe(m.get("peForward")),
            "pbRatio":   safe(m.get("pbAnnual")),
            "epsTrailing": safe(m.get("epsAnnual")),
            "beta":      safe(m.get("beta")),
        },
        "technicals": {
            "ma50": ma50, "ma200": ma200,
            "priceVsMa50": ma50_sig, "priceVsMa200": ma200_sig,
            "rsi": rsi,
            "rsiSignal": "overbought" if rsi and rsi > 70 else "oversold" if rsi and rsi < 30 else "neutral",
            "macd":     macd["trend"]     if macd else "neutral",
            "macdLine": macd["macdLine"]  if macd else None,
            "macdHist": macd["histogram"] if macd else None,
            "obv": obv, "overallTechnical": tech_sig,
            "sparkline": closes[-60:],
        },
        "news": [],
    }


# ── ROUTES ───────────────────────────────────────────────────────────────────

@app.route("/health")
def health():
    return jsonify({
        "status":    "ok",
        "yfinance":  HAS_YF,
        "finnhub":   bool(FINNHUB_KEY),
        "timestamp": datetime.now().isoformat()
    })


@app.route("/stock/<ticker>")
def stock(ticker):
    t = ticker.upper().strip()
    try:
        if HAS_YF:
            data = fetch_yfinance(t)
        elif FINNHUB_KEY:
            data = fetch_finnhub(t)
        else:
            return jsonify({"error": "No data source available. Install yfinance or set FINNHUB_KEY."}), 503
        return jsonify(data)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/batch")
def batch():
    """
    GET /batch?tickers=AAPL,NVDA,TSLA
    Returns array of stock data objects.
    """
    raw     = request.args.get("tickers", "")
    tickers = [t.strip().upper() for t in raw.split(",") if t.strip()][:6]
    if not tickers:
        return jsonify({"error": "No tickers provided"}), 400

    results, errors = [], []
    for t in tickers:
        try:
            if HAS_YF:
                results.append(fetch_yfinance(t))
            elif FINNHUB_KEY:
                results.append(fetch_finnhub(t))
            else:
                errors.append(f"{t}: no data source")
        except Exception as e:
            errors.append(f"{t}: {str(e)}")

    return jsonify({"results": results, "errors": errors})


# ── MAIN ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"""
╔══════════════════════════════════════════════════╗
║       Stock Analyst Local Data Server            ║
╠══════════════════════════════════════════════════╣
║  Running on: http://localhost:{PORT}                ║
║  yfinance:   {'✓ ready' if HAS_YF else '✗ not installed (pip install yfinance)'}              ║
║  Finnhub:    {'✓ key set' if FINNHUB_KEY else '○ not configured (optional)'}            ║
╠══════════════════════════════════════════════════╣
║  Endpoints:                                      ║
║    GET /health                                   ║
║    GET /stock/AAPL                               ║
║    GET /batch?tickers=AAPL,NVDA,TSLA             ║
╚══════════════════════════════════════════════════╝
    """)
    app.run(host="0.0.0.0", port=PORT, debug=False)
