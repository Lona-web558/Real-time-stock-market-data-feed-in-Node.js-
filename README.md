# Real-time-stock-market-data-feed-in-Node.js-
Real time stock market data feed in Node.js 

# Real-Time Stock Market Feed

A simulated live stock market data feed built with **pure Node.js** — no Express, no external dependencies, no arrow functions, `var` only throughout. Runs a native HTTP server serving a live browser dashboard, a Server-Sent Events stream, and a REST API.

---

## Requirements

- Node.js (any version with built-in `http`, `events`, `url` modules — v12+ recommended)
- No `npm install` needed — zero external dependencies

---

## Quick Start

```bash
node stockFeed.js
```

Then open your browser at **http://localhost:3000**

---

## Browser Dashboard

The dashboard at `http://localhost:3000/` is a fully self-contained dark-themed UI served directly by the Node.js server. It includes:

- **Live ticker table** — all 10 symbols updating every second with price flash animations (green/red) and inline SVG sparklines
- **Session stats panel** — live gainer/loser count, top gainer and top loser
- **Alerts sidebar** — real-time feed of any stock that moves more than 3% from its session open
- **Pause / Resume** button — halts the price engine without closing the server
- **Reset** button — resets all session opens to current prices and clears alerts

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Live HTML dashboard |
| `GET` | `/stream` | SSE stream (`text/event-stream`) |
| `GET` | `/api/snapshot` | Full JSON snapshot of all stocks |
| `GET` | `/api/stock/:SYM` | JSON for a single symbol (e.g. `/api/stock/AAPL`) |
| `GET` | `/api/alerts` | Array of all session alerts |
| `POST` | `/api/pause` | Toggle market open/paused |
| `POST` | `/api/reset` | Reset session opens to current prices |

### Example — fetch a snapshot

```bash
curl http://localhost:3000/api/snapshot
```

```json
{
  "timestamp": "2026-02-12T20:01:45.000Z",
  "tickCount": 42,
  "marketOpen": true,
  "stocks": {
    "AAPL": {
      "name": "Apple Inc.",
      "sector": "Technology",
      "price": 191.34,
      "open": 189.25,
      "change": 2.09,
      "changePct": 1.10,
      "volume": 48200,
      "vwap": 190.12,
      "high": 193.50,
      "low": 187.80,
      "sma5": 190.44,
      "sma20": null
    }
  },
  "alerts": []
}
```

### Example — single stock

```bash
curl http://localhost:3000/api/stock/NVDA
```

Returns the same fields as the snapshot plus a `history` array of the last 20 price/volume/timestamp ticks.

### Example — pause and resume

```bash
curl -X POST http://localhost:3000/api/pause   # pauses
curl -X POST http://localhost:3000/api/pause   # resumes
```

---

## SSE Stream

Connect to `/stream` to receive a continuous real-time event stream. Two named events are emitted:

**`tick`** — fired every second with the full market snapshot:

```
event: tick
data: { "timestamp": "...", "tickCount": 43, "stocks": { ... } }
```

**`alert`** — fired whenever a stock moves more than 3% from its session open:

```
event: alert
data: { "symbol": "TSLA", "price": 256.10, "changePct": 3.14, "direction": "up", "time": "..." }
```

### Consuming the stream from JavaScript

```js
var source = new EventSource('http://localhost:3000/stream');

source.addEventListener('tick', function(e) {
    var data = JSON.parse(e.data);
    console.log('Tick #' + data.tickCount, data.stocks.AAPL.price);
});

source.addEventListener('alert', function(e) {
    var alert = JSON.parse(e.data);
    console.log('ALERT:', alert.symbol, alert.changePct + '%');
});
```

### Consuming the stream from the terminal

```bash
curl -N http://localhost:3000/stream
```

---

## Stocks Covered

| Symbol | Name | Sector |
|--------|------|--------|
| AAPL | Apple Inc. | Technology |
| MSFT | Microsoft Corp. | Technology |
| GOOGL | Alphabet Inc. | Technology |
| AMZN | Amazon.com Inc. | Consumer |
| NVDA | NVIDIA Corp. | Technology |
| TSLA | Tesla Inc. | Automotive |
| JPM | JPMorgan Chase & Co. | Finance |
| META | Meta Platforms Inc. | Technology |
| V | Visa Inc. | Finance |
| WMT | Walmart Inc. | Consumer |

---

## Configuration

All tunable values are in the `CONFIG` object at the top of `stockFeed.js`:

| Key | Default | Description |
|-----|---------|-------------|
| `tickIntervalMs` | `1000` | How often prices update (ms) |
| `volatility` | `0.012` | Max % price swing per tick (Gaussian) |
| `alertThreshold` | `3` | % move from open that triggers an alert |
| `historyLimit` | `60` | Max ticks stored per symbol in memory |

---

## How the Price Engine Works

Prices are generated using a **Box-Muller Gaussian transform** rather than flat `Math.random()`, producing the kind of normally distributed noise that mirrors real short-term price movement. Each tick:

1. A Gaussian random drift is multiplied by the volatility factor
2. The new price is applied: `price * (1 + drift)`
3. Price is floored at `$0.01` — it can never go negative
4. Volume is randomised inversely proportional to share price (higher-priced stocks trade in smaller lot sizes)
5. VWAP, SMA5, SMA20, session high/low are computed from the rolling history window

---

## Architecture

```
stockFeed.js
│
├── Price Engine        — tickMarket() fires every second
├── EventEmitter Bus    — feedBus emits tick / alert events
├── SSE Layer           — broadcastSSE() pushes to all browser clients
├── HTTP Server         — native http.createServer(), no Express
│   ├── GET  /          → inline HTML dashboard (no separate files)
│   ├── GET  /stream    → SSE endpoint
│   └── GET/POST /api/* → JSON REST endpoints
└── Analytics           → VWAP, SMA, high/low computed on demand
```

---

## Coding Constraints

This file is written in **traditional ES5-style JavaScript**:

- `var` only — no `const` or `let`
- No arrow functions — all callbacks use `function` keyword
- No template literals — string concatenation throughout
- Built-in modules only — `http`, `events`, `url` — no `npm install`
- No Express or any web framework

