'use strict';

const WebSocket = require('ws');
const { TOP_N, QUOTE_ASSET } = require('./layout');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function getJson(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} для ${url}`);
  return resp.json();
}

function topByVolume(items, n) {
  return items
    .filter(x => Number.isFinite(x.volume) && x.volume > 0)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, n);
}

// TradeFi-инструменты WhiteBIT — тот же ручной список, что и в Apps Script
// версии; в паблик API нет флага, отличающего их от крипто-фьючерсов.
const TRADEFI_BASE_TICKERS = [
  'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'GOOG', 'META', 'NFLX',
  'COIN', 'HOOD', 'MSTR', 'AMD', 'AVGO', 'INTC', 'BA', 'JPM',
  'XAU', 'XAG', 'WTI', 'BRENT', 'XTI', 'XBR',
  'SPX', 'US500', 'NAS100', 'NDX', 'US30', 'DJI',
  'JP225', 'N225', 'KR200',
];

// ==================== WHITEBIT (REST poll) ====================

async function fetchWhiteBit() {
  const [markets, tickers] = await Promise.all([
    getJson('https://whitebit.com/api/v4/public/markets'),
    getJson('https://whitebit.com/api/v4/public/ticker'),
  ]);

  const volumeOf = name => {
    const t = tickers[name];
    if (!t) return NaN;
    return parseFloat(t.quote_volume ?? t.quoteVolume ?? t.deal);
  };

  const spot = markets
    .filter(m => m.type === 'spot' && m.money === QUOTE_ASSET)
    .map(m => ({ symbol: m.name, volume: volumeOf(m.name) }));

  const futuresAll = markets.filter(m => m.type === 'futures' && m.money === QUOTE_ASSET);
  const cryptoFutures = [];
  const tradeFi = [];
  futuresAll.forEach(m => {
    const item = { symbol: m.name, volume: volumeOf(m.name) };
    (TRADEFI_BASE_TICKERS.includes(m.stock.toUpperCase()) ? tradeFi : cryptoFutures).push(item);
  });

  return {
    Spot: topByVolume(spot, TOP_N),
    Futures: topByVolume(cryptoFutures, TOP_N),
    TradeFi: topByVolume(tradeFi, TOP_N),
  };
}

// ==================== BYBIT (REST poll) ====================

async function fetchBybit() {
  const [spotData, linearData] = await Promise.all([
    getJson('https://api.bybit.com/v5/market/tickers?category=spot'),
    getJson('https://api.bybit.com/v5/market/tickers?category=linear'),
  ]);
  const spotList = (spotData.result && spotData.result.list) || [];
  const linearList = (linearData.result && linearData.result.list) || [];

  const spot = spotList
    .filter(d => d.symbol.endsWith(QUOTE_ASSET))
    .map(d => ({ symbol: d.symbol, volume: parseFloat(d.turnover24h) }));
  const futures = linearList
    .filter(d => d.symbol.endsWith(QUOTE_ASSET))
    .map(d => ({ symbol: d.symbol, volume: parseFloat(d.turnover24h) }));

  return { Spot: topByVolume(spot, TOP_N), Futures: topByVolume(futures, TOP_N) };
}

// ==================== OKX (REST poll) ====================

async function fetchOkx() {
  const [spotData, swapData] = await Promise.all([
    getJson('https://www.okx.com/api/v5/market/tickers?instType=SPOT'),
    getJson('https://www.okx.com/api/v5/market/tickers?instType=SWAP'),
  ]);
  const spotList = spotData.data || [];
  const swapList = swapData.data || [];

  const spot = spotList
    .filter(d => d.instId.endsWith('-' + QUOTE_ASSET))
    .map(d => ({ symbol: d.instId, volume: parseFloat(d.volCcy24h) }));

  // volCcy24h у OKX для SWAP — объём в базовой валюте, не в USDT.
  // Домножаем на цену last, чтобы получить нотационный объём в USDT
  // (та же поправка, что и в Apps Script версии).
  const futures = swapList
    .filter(d => d.instId.endsWith('-' + QUOTE_ASSET + '-SWAP'))
    .map(d => ({ symbol: d.instId, volume: parseFloat(d.volCcy24h) * parseFloat(d.last) }));

  return { Spot: topByVolume(spot, TOP_N), Futures: topByVolume(futures, TOP_N) };
}

// ==================== BINANCE (WebSocket bulk stream) ====================
// !ticker@arr пушит статистику по ВСЕМ парам разом (~раз в секунду) —
// единственная из четырёх бирж, где действительно есть балк-поток.

function startBinanceWs(onUpdate) {
  connect('wss://stream.binance.com:9443/ws/!ticker@arr', 'Spot');
  connect('wss://fstream.binance.com/ws/!ticker@arr', 'Futures');

  function connect(url, marketType, attempt = 0) {
    const ws = new WebSocket(url);

    ws.on('open', () => {
      console.log(`[Binance ${marketType}] WS connected`);
    });

    ws.on('message', raw => {
      let arr;
      try {
        arr = JSON.parse(raw.toString());
      } catch (e) {
        return;
      }
      if (!Array.isArray(arr)) return;
      const items = arr
        .filter(d => typeof d.s === 'string' && d.s.endsWith(QUOTE_ASSET))
        .map(d => ({ symbol: d.s, volume: parseFloat(d.q) })); // q = quote asset volume
      onUpdate(marketType, topByVolume(items, TOP_N));
    });

    ws.on('close', () => {
      console.warn(`[Binance ${marketType}] WS closed, reconnecting...`);
      scheduleReconnect();
    });
    ws.on('error', err => {
      console.warn(`[Binance ${marketType}] WS error: ${err.message}`);
      ws.close();
    });

    function scheduleReconnect() {
      const delay = Math.min(30000, 1000 * 2 ** attempt);
      setTimeout(() => connect(url, marketType, attempt + 1), delay);
    }
  }
}

module.exports = { fetchWhiteBit, fetchBybit, fetchOkx, startBinanceWs };
