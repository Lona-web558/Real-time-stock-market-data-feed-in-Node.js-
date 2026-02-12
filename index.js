/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║       REAL-TIME STOCK MARKET FEED  — v2.0               ║
 * ║  Native Node.js http server · SSE · REST API            ║
 * ║  No Express · var only · no arrow functions             ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 *  Endpoints:
 *    GET  /              → Live dashboard HTML page
 *    GET  /api/snapshot  → JSON snapshot of all stocks
 *    GET  /api/stock/:sym→ JSON for one symbol
 *    GET  /api/alerts    → JSON recent alerts list
 *    GET  /stream        → SSE stream (text/event-stream)
 *    POST /api/pause     → Toggle market on/off
 *    POST /api/reset     → Reset session opens to current prices
 */

var http    = require('http');
var events  = require('events');
var url     = require('url');

var PORT = 3000;

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

var CONFIG = {
    tickIntervalMs: 1000,
    volatility:     0.012,
    alertThreshold: 3,        // % move from open triggers alert
    historyLimit:   60
};

// ─────────────────────────────────────────────────────────────────────────────
// MARKET DATA
// ─────────────────────────────────────────────────────────────────────────────

var MARKET = {
    AAPL:  { name: 'Apple Inc.',            price: 189.25, open: 189.25, sector: 'Technology', volume: 0 },
    MSFT:  { name: 'Microsoft Corp.',       price: 415.80, open: 415.80, sector: 'Technology', volume: 0 },
    GOOGL: { name: 'Alphabet Inc.',         price: 175.40, open: 175.40, sector: 'Technology', volume: 0 },
    AMZN:  { name: 'Amazon.com Inc.',       price: 202.15, open: 202.15, sector: 'Consumer',   volume: 0 },
    NVDA:  { name: 'NVIDIA Corp.',          price: 875.60, open: 875.60, sector: 'Technology', volume: 0 },
    TSLA:  { name: 'Tesla Inc.',            price: 248.30, open: 248.30, sector: 'Automotive', volume: 0 },
    JPM:   { name: 'JPMorgan Chase & Co.',  price: 198.75, open: 198.75, sector: 'Finance',    volume: 0 },
    META:  { name: 'Meta Platforms Inc.',   price: 505.90, open: 505.90, sector: 'Technology', volume: 0 },
    V:     { name: 'Visa Inc.',             price: 277.40, open: 277.40, sector: 'Finance',    volume: 0 },
    WMT:   { name: 'Walmart Inc.',          price:  68.90, open:  68.90, sector: 'Consumer',   volume: 0 }
};

var priceHistory = {};
var tickCount    = 0;
var marketOpen   = true;
var alerts       = [];
var sseClients   = [];      // array of res objects for SSE

(function initHistory() {
    var syms = Object.keys(MARKET);
    var i;
    for (i = 0; i < syms.length; i++) {
        priceHistory[syms[i]] = [];
    }
}());

// ─────────────────────────────────────────────────────────────────────────────
// EVENT BUS
// ─────────────────────────────────────────────────────────────────────────────

var feedBus = new events.EventEmitter();
feedBus.setMaxListeners(50);

// ─────────────────────────────────────────────────────────────────────────────
// MATH / UTILS
// ─────────────────────────────────────────────────────────────────────────────

function randomGaussian() {
    var u = 0, v = 0;
    while (u === 0) { u = Math.random(); }
    while (v === 0) { v = Math.random(); }
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

function randomVolume(price) {
    var base = Math.floor(80000 / price);
    return Math.floor(base * (0.4 + Math.random() * 1.6)) * 100;
}

function calcVWAP(sym) {
    var hist = priceHistory[sym];
    if (!hist || hist.length === 0) { return 0; }
    var pv = 0, tv = 0, i;
    for (i = 0; i < hist.length; i++) {
        pv += hist[i].price * hist[i].volume;
        tv += hist[i].volume;
    }
    return tv === 0 ? 0 : round2(pv / tv);
}

function calcSMA(sym, periods) {
    var hist = priceHistory[sym];
    if (!hist || hist.length < periods) { return null; }
    var slice = hist.slice(-periods);
    var sum = 0, i;
    for (i = 0; i < slice.length; i++) { sum += slice[i].price; }
    return round2(sum / slice.length);
}

function calcHighLow(sym) {
    var hist = priceHistory[sym];
    if (!hist || hist.length === 0) { return { high: 0, low: 0 }; }
    var hi = hist[0].price, lo = hist[0].price, i;
    for (i = 1; i < hist.length; i++) {
        if (hist[i].price > hi) { hi = hist[i].price; }
        if (hist[i].price < lo) { lo = hist[i].price; }
    }
    return { high: round2(hi), low: round2(lo) };
}

function getSnapshot() {
    var syms = Object.keys(MARKET);
    var snap = {
        timestamp:   new Date().toISOString(),
        tickCount:   tickCount,
        marketOpen:  marketOpen,
        stocks:      {},
        alerts:      alerts.slice(0, 10)
    };
    var i, sym, s, hl;
    for (i = 0; i < syms.length; i++) {
        sym = syms[i];
        s   = MARKET[sym];
        hl  = calcHighLow(sym);
        snap.stocks[sym] = {
            name:      s.name,
            sector:    s.sector,
            price:     s.price,
            open:      s.open,
            change:    round2(s.price - s.open),
            changePct: round2(((s.price - s.open) / s.open) * 100),
            volume:    s.volume,
            vwap:      calcVWAP(sym),
            high:      hl.high,
            low:       hl.low,
            sma5:      calcSMA(sym, 5),
            sma20:     calcSMA(sym, 20)
        };
    }
    return snap;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRICE ENGINE
// ─────────────────────────────────────────────────────────────────────────────

function tickMarket() {
    if (!marketOpen) { return; }
    tickCount++;

    var syms = Object.keys(MARKET);
    var i, sym, s, newPrice, change, pct, vol;

    for (i = 0; i < syms.length; i++) {
        sym      = syms[i];
        s        = MARKET[sym];
        newPrice = round2(Math.max(s.price * (1 + randomGaussian() * CONFIG.volatility), 0.01));
        change   = round2(newPrice - s.open);
        pct      = round2((change / s.open) * 100);
        vol      = randomVolume(newPrice);

        s.price  = newPrice;
        s.volume = vol;

        priceHistory[sym].push({ price: newPrice, volume: vol, ts: Date.now() });
        if (priceHistory[sym].length > CONFIG.historyLimit) {
            priceHistory[sym].shift();
        }

        if (Math.abs(pct) >= CONFIG.alertThreshold) {
            var alert = {
                symbol:    sym,
                name:      s.name,
                price:     newPrice,
                changePct: pct,
                direction: pct > 0 ? 'up' : 'down',
                time:      new Date().toISOString()
            };
            alerts.unshift(alert);
            if (alerts.length > 30) { alerts.pop(); }
            feedBus.emit('alert', alert);
        }
    }

    feedBus.emit('tick', getSnapshot());
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE — broadcast to all connected browser clients
// ─────────────────────────────────────────────────────────────────────────────

function broadcastSSE(eventName, data) {
    var payload = 'event: ' + eventName + '\ndata: ' + JSON.stringify(data) + '\n\n';
    var i;
    for (i = sseClients.length - 1; i >= 0; i--) {
        try {
            sseClients[i].write(payload);
        } catch (e) {
            sseClients.splice(i, 1);
        }
    }
}

feedBus.on('tick', function(snap) {
    broadcastSSE('tick', snap);
});

feedBus.on('alert', function(alert) {
    broadcastSSE('alert', alert);
});

// ─────────────────────────────────────────────────────────────────────────────
// HTML DASHBOARD  (served at GET /)
// ─────────────────────────────────────────────────────────────────────────────

function getDashboardHTML() {
    return '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
'<title>Market Feed</title>\n' +
'<style>\n' +
'  @import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;600&family=IBM+Plex+Sans:wght@300;500;700&display=swap");\n' +
'\n' +
'  :root {\n' +
'    --bg:       #090e14;\n' +
'    --surface:  #0d1520;\n' +
'    --border:   #1a2740;\n' +
'    --text:     #c8d8e8;\n' +
'    --dim:      #4a6080;\n' +
'    --up:       #00e8a0;\n' +
'    --down:     #ff4560;\n' +
'    --accent:   #0af;\n' +
'    --gold:     #f4c842;\n' +
'    --mono:     "IBM Plex Mono", monospace;\n' +
'    --sans:     "IBM Plex Sans", sans-serif;\n' +
'  }\n' +
'\n' +
'  * { box-sizing: border-box; margin: 0; padding: 0; }\n' +
'\n' +
'  body {\n' +
'    background: var(--bg);\n' +
'    color: var(--text);\n' +
'    font-family: var(--mono);\n' +
'    font-size: 13px;\n' +
'    min-height: 100vh;\n' +
'  }\n' +
'\n' +
'  /* ── HEADER ── */\n' +
'  header {\n' +
'    display: flex;\n' +
'    align-items: center;\n' +
'    justify-content: space-between;\n' +
'    padding: 14px 28px;\n' +
'    border-bottom: 1px solid var(--border);\n' +
'    background: var(--surface);\n' +
'    position: sticky;\n' +
'    top: 0;\n' +
'    z-index: 100;\n' +
'  }\n' +
'\n' +
'  .brand {\n' +
'    font-family: var(--sans);\n' +
'    font-weight: 700;\n' +
'    font-size: 16px;\n' +
'    letter-spacing: .08em;\n' +
'    color: var(--accent);\n' +
'    display: flex;\n' +
'    align-items: center;\n' +
'    gap: 10px;\n' +
'  }\n' +
'\n' +
'  .brand .dot {\n' +
'    width: 8px; height: 8px;\n' +
'    border-radius: 50%;\n' +
'    background: var(--up);\n' +
'    animation: pulse 1.2s ease-in-out infinite;\n' +
'  }\n' +
'\n' +
'  .brand .dot.paused { background: var(--gold); animation: none; }\n' +
'\n' +
'  @keyframes pulse {\n' +
'    0%,100% { opacity: 1; transform: scale(1); }\n' +
'    50%      { opacity: .4; transform: scale(.7); }\n' +
'  }\n' +
'\n' +
'  .header-meta {\n' +
'    display: flex;\n' +
'    align-items: center;\n' +
'    gap: 24px;\n' +
'    font-size: 11px;\n' +
'    color: var(--dim);\n' +
'  }\n' +
'\n' +
'  .header-meta span b { color: var(--text); }\n' +
'\n' +
'  .controls { display: flex; gap: 8px; }\n' +
'\n' +
'  button {\n' +
'    font-family: var(--mono);\n' +
'    font-size: 11px;\n' +
'    padding: 5px 14px;\n' +
'    border: 1px solid var(--border);\n' +
'    background: transparent;\n' +
'    color: var(--dim);\n' +
'    cursor: pointer;\n' +
'    letter-spacing: .06em;\n' +
'    transition: all .15s;\n' +
'  }\n' +
'\n' +
'  button:hover { border-color: var(--accent); color: var(--accent); }\n' +
'  button.danger:hover { border-color: var(--down); color: var(--down); }\n' +
'\n' +
'  /* ── LAYOUT ── */\n' +
'  .layout {\n' +
'    display: grid;\n' +
'    grid-template-columns: 1fr 300px;\n' +
'    grid-template-rows: auto 1fr;\n' +
'    gap: 1px;\n' +
'    background: var(--border);\n' +
'    height: calc(100vh - 53px);\n' +
'    overflow: hidden;\n' +
'  }\n' +
'\n' +
'  .panel {\n' +
'    background: var(--bg);\n' +
'    overflow: auto;\n' +
'  }\n' +
'\n' +
'  .panel-header {\n' +
'    padding: 10px 20px;\n' +
'    font-size: 10px;\n' +
'    letter-spacing: .12em;\n' +
'    color: var(--dim);\n' +
'    border-bottom: 1px solid var(--border);\n' +
'    background: var(--surface);\n' +
'    text-transform: uppercase;\n' +
'    position: sticky;\n' +
'    top: 0;\n' +
'    z-index: 10;\n' +
'  }\n' +
'\n' +
'  /* ── TICKER TABLE ── */\n' +
'  .ticker-panel { grid-row: 1 / 3; }\n' +
'\n' +
'  table {\n' +
'    width: 100%;\n' +
'    border-collapse: collapse;\n' +
'  }\n' +
'\n' +
'  thead th {\n' +
'    padding: 9px 16px;\n' +
'    text-align: right;\n' +
'    font-size: 10px;\n' +
'    font-weight: 400;\n' +
'    letter-spacing: .1em;\n' +
'    color: var(--dim);\n' +
'    border-bottom: 1px solid var(--border);\n' +
'    white-space: nowrap;\n' +
'    position: sticky;\n' +
'    top: 41px;\n' +
'    background: var(--surface);\n' +
'    z-index: 5;\n' +
'  }\n' +
'\n' +
'  thead th:first-child,\n' +
'  thead th:nth-child(2) { text-align: left; }\n' +
'\n' +
'  tbody tr {\n' +
'    border-bottom: 1px solid var(--border);\n' +
'    transition: background .1s;\n' +
'  }\n' +
'\n' +
'  tbody tr:hover { background: var(--surface); }\n' +
'\n' +
'  tbody td {\n' +
'    padding: 11px 16px;\n' +
'    text-align: right;\n' +
'    white-space: nowrap;\n' +
'    font-size: 12px;\n' +
'  }\n' +
'\n' +
'  tbody td:first-child {\n' +
'    text-align: left;\n' +
'    font-weight: 600;\n' +
'    font-size: 13px;\n' +
'    color: var(--accent);\n' +
'    letter-spacing: .04em;\n' +
'  }\n' +
'\n' +
'  tbody td:nth-child(2) {\n' +
'    text-align: left;\n' +
'    color: var(--dim);\n' +
'    font-size: 11px;\n' +
'  }\n' +
'\n' +
'  .up   { color: var(--up);   }\n' +
'  .down { color: var(--down); }\n' +
'  .flat { color: var(--dim);  }\n' +
'\n' +
'  .flash-up   { animation: flashUp   .4s ease; }\n' +
'  .flash-down { animation: flashDown .4s ease; }\n' +
'\n' +
'  @keyframes flashUp {\n' +
'    0%   { background: rgba(0,232,160,.18); }\n' +
'    100% { background: transparent; }\n' +
'  }\n' +
'  @keyframes flashDown {\n' +
'    0%   { background: rgba(255,69,96,.18); }\n' +
'    100% { background: transparent; }\n' +
'  }\n' +
'\n' +
'  .badge {\n' +
'    display: inline-block;\n' +
'    font-size: 9px;\n' +
'    padding: 1px 5px;\n' +
'    border-radius: 2px;\n' +
'    letter-spacing: .06em;\n' +
'    margin-left: 6px;\n' +
'    vertical-align: middle;\n' +
'  }\n' +
'\n' +
'  .badge-tech  { background: rgba(0,170,255,.12); color: var(--accent);  border: 1px solid rgba(0,170,255,.3); }\n' +
'  .badge-fin   { background: rgba(244,200,66,.1);  color: var(--gold);   border: 1px solid rgba(244,200,66,.3); }\n' +
'  .badge-con   { background: rgba(180,160,220,.1); color: #b4a0e0;       border: 1px solid rgba(180,160,220,.3); }\n' +
'  .badge-auto  { background: rgba(0,232,160,.1);   color: var(--up);     border: 1px solid rgba(0,232,160,.3); }\n' +
'\n' +
'  /* ── MINI SPARKLINE ── */\n' +
'  .spark {\n' +
'    display: inline-block;\n' +
'    vertical-align: middle;\n' +
'  }\n' +
'\n' +
'  /* ── SIDE PANELS ── */\n' +
'  .side-top    { border-bottom: 1px solid var(--border); }\n' +
'\n' +
'  .stat-grid {\n' +
'    display: grid;\n' +
'    grid-template-columns: 1fr 1fr;\n' +
'    gap: 1px;\n' +
'    background: var(--border);\n' +
'  }\n' +
'\n' +
'  .stat-cell {\n' +
'    background: var(--bg);\n' +
'    padding: 14px 16px;\n' +
'  }\n' +
'\n' +
'  .stat-label {\n' +
'    font-size: 9px;\n' +
'    letter-spacing: .1em;\n' +
'    color: var(--dim);\n' +
'    text-transform: uppercase;\n' +
'    margin-bottom: 6px;\n' +
'  }\n' +
'\n' +
'  .stat-value {\n' +
'    font-size: 20px;\n' +
'    font-weight: 600;\n' +
'    line-height: 1;\n' +
'  }\n' +
'\n' +
'  /* ── ALERT FEED ── */\n' +
'  .alert-list { padding: 0; }\n' +
'\n' +
'  .alert-item {\n' +
'    display: flex;\n' +
'    align-items: center;\n' +
'    gap: 10px;\n' +
'    padding: 10px 16px;\n' +
'    border-bottom: 1px solid var(--border);\n' +
'    animation: slideIn .3s ease;\n' +
'  }\n' +
'\n' +
'  @keyframes slideIn {\n' +
'    from { opacity: 0; transform: translateX(12px); }\n' +
'    to   { opacity: 1; transform: translateX(0); }\n' +
'  }\n' +
'\n' +
'  .alert-arrow {\n' +
'    font-size: 16px;\n' +
'    width: 20px;\n' +
'    text-align: center;\n' +
'    flex-shrink: 0;\n' +
'  }\n' +
'\n' +
'  .alert-sym {\n' +
'    font-weight: 600;\n' +
'    font-size: 13px;\n' +
'    color: var(--accent);\n' +
'    width: 50px;\n' +
'    flex-shrink: 0;\n' +
'  }\n' +
'\n' +
'  .alert-body { flex: 1; }\n' +
'  .alert-price { font-size: 12px; }\n' +
'  .alert-pct   { font-size: 10px; color: var(--dim); }\n' +
'\n' +
'  .alert-time {\n' +
'    font-size: 9px;\n' +
'    color: var(--dim);\n' +
'    flex-shrink: 0;\n' +
'  }\n' +
'\n' +
'  .no-alerts {\n' +
'    padding: 20px 16px;\n' +
'    color: var(--dim);\n' +
'    font-size: 11px;\n' +
'  }\n' +
'\n' +
'  /* ── CONNECTION BANNER ── */\n' +
'  #conn-banner {\n' +
'    position: fixed;\n' +
'    bottom: 16px;\n' +
'    right: 16px;\n' +
'    padding: 8px 16px;\n' +
'    font-size: 11px;\n' +
'    background: var(--surface);\n' +
'    border: 1px solid var(--border);\n' +
'    color: var(--dim);\n' +
'    opacity: 0;\n' +
'    transition: opacity .3s;\n' +
'    pointer-events: none;\n' +
'  }\n' +
'\n' +
'  #conn-banner.show { opacity: 1; }\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'\n' +
'<header>\n' +
'  <div class="brand">\n' +
'    <div class="dot" id="live-dot"></div>\n' +
'    MARKET FEED\n' +
'  </div>\n' +
'  <div class="header-meta">\n' +
'    <span>TICKS <b id="tick-count">0</b></span>\n' +
'    <span>CLIENTS <b id="client-count">1</b></span>\n' +
'    <span id="clock">--:--:--</span>\n' +
'  </div>\n' +
'  <div class="controls">\n' +
'    <button id="btn-pause" onclick="togglePause()">⏸ PAUSE</button>\n' +
'    <button id="btn-reset" class="danger" onclick="resetSession()">↺ RESET</button>\n' +
'  </div>\n' +
'</header>\n' +
'\n' +
'<div class="layout">\n' +
'\n' +
'  <!-- LEFT: TICKER -->\n' +
'  <div class="panel ticker-panel">\n' +
'    <div class="panel-header">LIVE TICKER</div>\n' +
'    <table>\n' +
'      <thead>\n' +
'        <tr>\n' +
'          <th>SYMBOL</th>\n' +
'          <th>NAME</th>\n' +
'          <th>PRICE</th>\n' +
'          <th>CHANGE</th>\n' +
'          <th>CHG %</th>\n' +
'          <th>VOLUME</th>\n' +
'          <th>VWAP</th>\n' +
'          <th>HIGH</th>\n' +
'          <th>LOW</th>\n' +
'          <th>SMA5</th>\n' +
'          <th>SMA20</th>\n' +
'          <th>TREND</th>\n' +
'        </tr>\n' +
'      </thead>\n' +
'      <tbody id="ticker-body">\n' +
'        <tr><td colspan="12" style="padding:40px;text-align:center;color:var(--dim)">Connecting…</td></tr>\n' +
'      </tbody>\n' +
'    </table>\n' +
'  </div>\n' +
'\n' +
'  <!-- RIGHT TOP: STATS -->\n' +
'  <div class="panel side-top">\n' +
'    <div class="panel-header">SESSION STATS</div>\n' +
'    <div class="stat-grid">\n' +
'      <div class="stat-cell">\n' +
'        <div class="stat-label">Gainers</div>\n' +
'        <div class="stat-value up" id="stat-gainers">—</div>\n' +
'      </div>\n' +
'      <div class="stat-cell">\n' +
'        <div class="stat-label">Losers</div>\n' +
'        <div class="stat-value down" id="stat-losers">—</div>\n' +
'      </div>\n' +
'      <div class="stat-cell">\n' +
'        <div class="stat-label">Top Gainer</div>\n' +
'        <div class="stat-value" id="stat-top-g" style="font-size:16px;color:var(--up)">—</div>\n' +
'      </div>\n' +
'      <div class="stat-cell">\n' +
'        <div class="stat-label">Top Loser</div>\n' +
'        <div class="stat-value" id="stat-top-l" style="font-size:16px;color:var(--down)">—</div>\n' +
'      </div>\n' +
'    </div>\n' +
'  </div>\n' +
'\n' +
'  <!-- RIGHT BOTTOM: ALERTS -->\n' +
'  <div class="panel">\n' +
'    <div class="panel-header">ALERTS  <span style="color:var(--down)" id="alert-badge"></span></div>\n' +
'    <div class="alert-list" id="alert-list">\n' +
'      <div class="no-alerts">No alerts yet — moves &gt;3% will appear here</div>\n' +
'    </div>\n' +
'  </div>\n' +
'\n' +
'</div>\n' +
'\n' +
'<div id="conn-banner">⚡ Reconnecting…</div>\n' +
'\n' +
'<script>\n' +
'// ─── State ───────────────────────────────────────────────\n' +
'var prevPrices   = {};\n' +
'var sparkData    = {};\n' +
'var alertCount   = 0;\n' +
'var paused       = false;\n' +
'var evtSource    = null;\n' +
'\n' +
'var SECTOR_BADGE = {\n' +
'  Technology: "badge-tech",\n' +
'  Finance:    "badge-fin",\n' +
'  Consumer:   "badge-con",\n' +
'  Automotive: "badge-auto"\n' +
'};\n' +
'\n' +
'// ─── Clock ───────────────────────────────────────────────\n' +
'function updateClock() {\n' +
'  document.getElementById("clock").textContent =\n' +
'    new Date().toTimeString().slice(0, 8);\n' +
'}\n' +
'setInterval(updateClock, 1000);\n' +
'updateClock();\n' +
'\n' +
'// ─── SSE Connection ─────────────────────────────────────\n' +
'function connect() {\n' +
'  var banner = document.getElementById("conn-banner");\n' +
'  evtSource  = new EventSource("/stream");\n' +
'\n' +
'  evtSource.addEventListener("tick", function(e) {\n' +
'    var data = JSON.parse(e.data);\n' +
'    updateTicker(data);\n' +
'    updateStats(data);\n' +
'    document.getElementById("tick-count").textContent = data.tickCount;\n' +
'    paused = !data.marketOpen;\n' +
'    var dot = document.getElementById("live-dot");\n' +
'    if (paused) {\n' +
'      dot.classList.add("paused");\n' +
'      document.getElementById("btn-pause").textContent = "▶ RESUME";\n' +
'    } else {\n' +
'      dot.classList.remove("paused");\n' +
'      document.getElementById("btn-pause").textContent = "⏸ PAUSE";\n' +
'    }\n' +
'    banner.classList.remove("show");\n' +
'  });\n' +
'\n' +
'  evtSource.addEventListener("alert", function(e) {\n' +
'    var a = JSON.parse(e.data);\n' +
'    prependAlert(a);\n' +
'  });\n' +
'\n' +
'  evtSource.onerror = function() {\n' +
'    banner.classList.add("show");\n' +
'    evtSource.close();\n' +
'    setTimeout(connect, 2000);\n' +
'  };\n' +
'}\n' +
'\n' +
'connect();\n' +
'\n' +
'// ─── Ticker Rendering ───────────────────────────────────\n' +
'function updateTicker(snap) {\n' +
'  var tbody  = document.getElementById("ticker-body");\n' +
'  var syms   = Object.keys(snap.stocks);\n' +
'  var i, sym, s, row, cls, arrow;\n' +
'\n' +
'  for (i = 0; i < syms.length; i++) {\n' +
'    sym = syms[i];\n' +
'    s   = snap.stocks[sym];\n' +
'\n' +
'    // track sparkline data\n' +
'    if (!sparkData[sym]) { sparkData[sym] = []; }\n' +
'    sparkData[sym].push(s.price);\n' +
'    if (sparkData[sym].length > 30) { sparkData[sym].shift(); }\n' +
'\n' +
'    row = document.getElementById("row-" + sym);\n' +
'    if (!row) {\n' +
'      row    = document.createElement("tr");\n' +
'      row.id = "row-" + sym;\n' +
'      tbody.innerHTML = "";\n' +
'      // rebuild all rows in order\n' +
'      var j, r;\n' +
'      for (j = 0; j < syms.length; j++) {\n' +
'        r    = document.createElement("tr");\n' +
'        r.id = "row-" + syms[j];\n' +
'        tbody.appendChild(r);\n' +
'      }\n' +
'      row = document.getElementById("row-" + sym);\n' +
'    }\n' +
'\n' +
'    cls   = s.changePct > 0 ? "up" : (s.changePct < 0 ? "down" : "flat");\n' +
'    arrow = s.changePct > 0 ? "▲" : (s.changePct < 0 ? "▼" : "─");\n' +
'\n' +
'    var prevPrice = prevPrices[sym];\n' +
'    var flashCls  = "";\n' +
'    if (prevPrice !== undefined) {\n' +
'      if (s.price > prevPrice) { flashCls = "flash-up"; }\n' +
'      else if (s.price < prevPrice) { flashCls = "flash-down"; }\n' +
'    }\n' +
'    prevPrices[sym] = s.price;\n' +
'\n' +
'    var badgeCls = SECTOR_BADGE[s.sector] || "";\n' +
'\n' +
'    row.className = flashCls;\n' +
'    row.innerHTML =\n' +
'      "<td>" + sym + "</td>" +\n' +
'      "<td>" + s.name + " <span class=\\"badge " + badgeCls + "\\">" + s.sector + "</span></td>" +\n' +
'      "<td class=\\"" + cls + "\\">" + "$" + s.price.toFixed(2) + "</td>" +\n' +
'      "<td class=\\"" + cls + "\\">" + (s.change >= 0 ? "+" : "") + s.change.toFixed(2) + "</td>" +\n' +
'      "<td class=\\"" + cls + "\\">" + arrow + " " + (s.changePct >= 0 ? "+" : "") + s.changePct.toFixed(2) + "%</td>" +\n' +
'      "<td style=\\"color:var(--dim)\\">" + formatVol(s.volume) + "</td>" +\n' +
'      "<td style=\\"color:var(--dim)\\">" + "$" + s.vwap.toFixed(2) + "</td>" +\n' +
'      "<td style=\\"color:var(--up)\\">" + "$" + s.high.toFixed(2) + "</td>" +\n' +
'      "<td style=\\"color:var(--down)\\">" + "$" + s.low.toFixed(2) + "</td>" +\n' +
'      "<td style=\\"color:var(--dim)\\">" + (s.sma5  !== null ? "$" + s.sma5.toFixed(2)  : "─") + "</td>" +\n' +
'      "<td style=\\"color:var(--dim)\\">" + (s.sma20 !== null ? "$" + s.sma20.toFixed(2) : "─") + "</td>" +\n' +
'      "<td>" + renderSparkSVG(sparkData[sym], cls) + "</td>";\n' +
'  }\n' +
'}\n' +
'\n' +
'function formatVol(v) {\n' +
'  if (v >= 1000000) { return (v / 1000000).toFixed(1) + "M"; }\n' +
'  if (v >= 1000)    { return (v / 1000).toFixed(0) + "K"; }\n' +
'  return String(v);\n' +
'}\n' +
'\n' +
'function renderSparkSVG(data, cls) {\n' +
'  if (!data || data.length < 2) { return "<svg width=\\"60\\" height=\\"20\\"></svg>"; }\n' +
'  var min = data[0], max = data[0], i;\n' +
'  for (i = 1; i < data.length; i++) {\n' +
'    if (data[i] < min) { min = data[i]; }\n' +
'    if (data[i] > max) { max = data[i]; }\n' +
'  }\n' +
'  var range = max - min || 1;\n' +
'  var W = 60, H = 20;\n' +
'  var pts = "";\n' +
'  for (i = 0; i < data.length; i++) {\n' +
'    var x = (i / (data.length - 1)) * W;\n' +
'    var y = H - ((data[i] - min) / range) * (H - 2) - 1;\n' +
'    pts += (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);\n' +
'  }\n' +
'  var color = cls === "up" ? "var(--up)" : (cls === "down" ? "var(--down)" : "var(--dim)");\n' +
'  return "<svg class=\\"spark\\" width=\\"" + W + "\\" height=\\"" + H + "\\" viewBox=\\"0 0 " + W + " " + H + "\\">" +\n' +
'    "<path d=\\"" + pts + "\\" fill=\\"none\\" stroke=\\"" + color + "\\" stroke-width=\\"1.2\\"/></svg>";\n' +
'}\n' +
'\n' +
'// ─── Stats Panel ────────────────────────────────────────\n' +
'function updateStats(snap) {\n' +
'  var syms = Object.keys(snap.stocks);\n' +
'  var gainers = 0, losers = 0;\n' +
'  var topG = null, topGPct = -Infinity;\n' +
'  var topL = null, topLPct =  Infinity;\n' +
'  var i, sym, pct;\n' +
'  for (i = 0; i < syms.length; i++) {\n' +
'    sym = syms[i];\n' +
'    pct = snap.stocks[sym].changePct;\n' +
'    if (pct >= 0) { gainers++; } else { losers++; }\n' +
'    if (pct > topGPct) { topGPct = pct; topG = sym; }\n' +
'    if (pct < topLPct) { topLPct = pct; topL = sym; }\n' +
'  }\n' +
'  document.getElementById("stat-gainers").textContent = gainers;\n' +
'  document.getElementById("stat-losers").textContent  = losers;\n' +
'  document.getElementById("stat-top-g").textContent   = topG ? topG + " +" + topGPct.toFixed(2) + "%" : "—";\n' +
'  document.getElementById("stat-top-l").textContent   = topL ? topL + " " + topLPct.toFixed(2) + "%" : "—";\n' +
'}\n' +
'\n' +
'// ─── Alerts Panel ───────────────────────────────────────\n' +
'function prependAlert(a) {\n' +
'  alertCount++;\n' +
'  document.getElementById("alert-badge").textContent = "(" + alertCount + ")";\n' +
'\n' +
'  var list = document.getElementById("alert-list");\n' +
'  var noMsg = list.querySelector(".no-alerts");\n' +
'  if (noMsg) { list.removeChild(noMsg); }\n' +
'\n' +
'  var cls   = a.direction === "up" ? "up" : "down";\n' +
'  var arrow = a.direction === "up" ? "▲" : "▼";\n' +
'  var time  = a.time.slice(11, 19);\n' +
'\n' +
'  var item = document.createElement("div");\n' +
'  item.className = "alert-item";\n' +
'  item.innerHTML =\n' +
'    "<div class=\\"alert-arrow " + cls + "\\">" + arrow + "</div>" +\n' +
'    "<div class=\\"alert-sym\\">" + a.symbol + "</div>" +\n' +
'    "<div class=\\"alert-body\\">" +\n' +
'      "<div class=\\"alert-price " + cls + "\\">" + "$" + a.price.toFixed(2) + "</div>" +\n' +
'      "<div class=\\"alert-pct\\">" + (a.changePct >= 0 ? "+" : "") + a.changePct.toFixed(2) + "% from open</div>" +\n' +
'    "</div>" +\n' +
'    "<div class=\\"alert-time\\">" + time + "</div>";\n' +
'\n' +
'  list.insertBefore(item, list.firstChild);\n' +
'\n' +
'  // cap at 20 alerts displayed\n' +
'  while (list.children.length > 20) {\n' +
'    list.removeChild(list.lastChild);\n' +
'  }\n' +
'}\n' +
'\n' +
'// ─── Controls ───────────────────────────────────────────\n' +
'function togglePause() {\n' +
'  fetch("/api/pause", { method: "POST" });\n' +
'}\n' +
'\n' +
'function resetSession() {\n' +
'  alertCount = 0;\n' +
'  document.getElementById("alert-badge").textContent = "";\n' +
'  document.getElementById("alert-list").innerHTML =\n' +
'    "<div class=\\"no-alerts\\">No alerts yet — moves >3% will appear here</div>";\n' +
'  fetch("/api/reset", { method: "POST" });\n' +
'}\n' +
'</script>\n' +
'</body>\n' +
'</html>';
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP SERVER — pure Node.js http, no Express
// ─────────────────────────────────────────────────────────────────────────────

function sendJSON(res, statusCode, data) {
    var body = JSON.stringify(data, null, 2);
    res.writeHead(statusCode, {
        'Content-Type':  'application/json',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
}

function sendHTML(res, html) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
}

function readBody(req, callback) {
    var body = '';
    req.on('data', function(chunk) { body += chunk.toString(); });
    req.on('end', function() { callback(body); });
}

var server = http.createServer(function(req, res) {
    var parsed   = url.parse(req.url, true);
    var pathname = parsed.pathname;
    var method   = req.method;

    // ── CORS preflight ──
    if (method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
    }

    // ── GET / → Dashboard ──
    if (method === 'GET' && pathname === '/') {
        sendHTML(res, getDashboardHTML());
        return;
    }

    // ── GET /stream → SSE ──
    if (method === 'GET' && pathname === '/stream') {
        res.writeHead(200, {
            'Content-Type':  'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection':    'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        res.write(':ok\n\n');

        // send current snapshot immediately on connect
        res.write('event: tick\ndata: ' + JSON.stringify(getSnapshot()) + '\n\n');

        sseClients.push(res);

        req.on('close', function() {
            var idx = sseClients.indexOf(res);
            if (idx !== -1) { sseClients.splice(idx, 1); }
        });
        return;
    }

    // ── GET /api/snapshot ──
    if (method === 'GET' && pathname === '/api/snapshot') {
        sendJSON(res, 200, getSnapshot());
        return;
    }

    // ── GET /api/stock/:sym ──
    var symMatch = pathname.match(/^\/api\/stock\/([A-Z]+)$/i);
    if (method === 'GET' && symMatch) {
        var sym = symMatch[1].toUpperCase();
        if (!MARKET[sym]) {
            sendJSON(res, 404, { error: 'Symbol not found: ' + sym });
            return;
        }
        var s  = MARKET[sym];
        var hl = calcHighLow(sym);
        sendJSON(res, 200, {
            symbol:    sym,
            name:      s.name,
            sector:    s.sector,
            price:     s.price,
            open:      s.open,
            change:    round2(s.price - s.open),
            changePct: round2(((s.price - s.open) / s.open) * 100),
            volume:    s.volume,
            vwap:      calcVWAP(sym),
            high:      hl.high,
            low:       hl.low,
            sma5:      calcSMA(sym, 5),
            sma20:     calcSMA(sym, 20),
            history:   priceHistory[sym].slice(-20)
        });
        return;
    }

    // ── GET /api/alerts ──
    if (method === 'GET' && pathname === '/api/alerts') {
        sendJSON(res, 200, { alerts: alerts });
        return;
    }

    // ── POST /api/pause ──
    if (method === 'POST' && pathname === '/api/pause') {
        readBody(req, function() {
            marketOpen = !marketOpen;
            sendJSON(res, 200, { marketOpen: marketOpen });
        });
        return;
    }

    // ── POST /api/reset ──
    if (method === 'POST' && pathname === '/api/reset') {
        readBody(req, function() {
            var syms = Object.keys(MARKET);
            var i;
            for (i = 0; i < syms.length; i++) {
                MARKET[syms[i]].open  = MARKET[syms[i]].price;
                priceHistory[syms[i]] = [];
            }
            tickCount  = 0;
            alerts     = [];
            sendJSON(res, 200, { ok: true, message: 'Session reset' });
        });
        return;
    }

    // ── 404 ──
    sendJSON(res, 404, { error: 'Not found', path: pathname });
});

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────

function boot() {
    // warm-up: 10 silent ticks before going live
    var warmup = 0;
    var warmupTimer = setInterval(function() {
        tickMarket();
        warmup++;
        if (warmup >= 10) {
            clearInterval(warmupTimer);
            startServer();
        }
    }, 50);
}

function startServer() {
    server.listen(PORT, '127.0.0.1', function() {
        console.log('');
        console.log('  \x1b[36m\x1b[1m╔══════════════════════════════════════╗\x1b[0m');
        console.log('  \x1b[36m\x1b[1m║   MARKET FEED  —  Node.js v' + process.versions.node + '\x1b[0m');
        console.log('  \x1b[36m\x1b[1m╚══════════════════════════════════════╝\x1b[0m');
        console.log('');
        console.log('  \x1b[32m▸\x1b[0m  Dashboard   →  http://localhost:' + PORT + '/');
        console.log('  \x1b[32m▸\x1b[0m  SSE stream  →  http://localhost:' + PORT + '/stream');
        console.log('  \x1b[32m▸\x1b[0m  Snapshot    →  http://localhost:' + PORT + '/api/snapshot');
        console.log('  \x1b[32m▸\x1b[0m  One stock   →  http://localhost:' + PORT + '/api/stock/AAPL');
        console.log('  \x1b[32m▸\x1b[0m  Alerts      →  http://localhost:' + PORT + '/api/alerts');
        console.log('');
        console.log('  \x1b[2mPress Ctrl+C to stop\x1b[0m');
        console.log('');

        // main tick engine
        var tickTimer = setInterval(function() {
            tickMarket();
        }, CONFIG.tickIntervalMs);

        // heartbeat to keep SSE connections alive
        var heartbeat = setInterval(function() {
            var i;
            for (i = sseClients.length - 1; i >= 0; i--) {
                try {
                    sseClients[i].write(':heartbeat\n\n');
                } catch (e) {
                    sseClients.splice(i, 1);
                }
            }
        }, 15000);

        process.on('SIGINT', function() {
            clearInterval(tickTimer);
            clearInterval(heartbeat);
            server.close(function() {
                console.log('\n  \x1b[36mServer stopped.\x1b[0m\n');
                process.exit(0);
            });
        });
    });
}

boot();
