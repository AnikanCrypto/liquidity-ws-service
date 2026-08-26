'use strict';

const WebSocket = require('ws');
const { TOP_N, QUOTE_ASSET } = require('./layout');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function getJson(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status} для ${url}`);
    err.status = resp.status;
    const retryAfter = resp.headers.get('retry-after');
    if (retryAfter) err.retryAfterMs = parseInt(retryAfter, 10) * 1000;
    throw err;
  }
  return resp.json();
}

function topByVolume(items, n) {
  return items
    .filter(x => Number.isFinite(x.volume) && x.volume > 0)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, n);
}

const TRADEFI_BASE_TICKERS = [
  'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'GOOG', 'META', 'NFLX',
  'COIN', 'HOOD', 'MSTR', 'AMD', 'AVGO', 'INTC', 'BA', 'JPM',
  'XAU', 'XAG', 'WTI', 'BRENT', 'XTI', 'XBR',
  'SPX', 'US500', 'NAS100', 'NDX', 'US30', 'DJI',
  'JP225', 'N225', 'KR200',
];

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

  const futures = swapList
    .filter(d => d.instId.endsWith('-' + QUOTE_ASSET + '-SWAP'))
    .map(d => ({ symbol: d.instId, volume: parseFloat(d.volCcy24h) * parseFloat(d.last) }));

  return { Spot: topByVolume(spot, TOP_N), Futures: topByVolume(futures, TOP_N) };
}

const RERANK_MS = Number(process.env.BINANCE_RERANK_MS || 30 * 60 * 1000);
const MIN_RETRY_MS = 60 * 1000;
const MAX_RETRY_MS = 15 * 60 * 1000;

async function fetchBinanceRanking() {
  const [spotData, futuresData] = await Promise.all([
    getJson('https://api.binance.com/api/v3/ticker/24hr'),
    getJson('https://fapi.binance.com/fapi/v1/ticker/24hr'),
  ]);
  const spot = spotData
    .filter(d => d.symbol.endsWith(QUOTE_ASSET))
    .map(d => ({ symbol: d.symbol, volume: parseFloat(d.quoteVolume) }));
  const futures = futuresData
    .filter(d => d.symbol.endsWith(QUOTE_ASSET))
    .map(d => ({ symbol: d.symbol, volume: parseFloat(d.quoteVolume) }));

  return { Spot: topByVolume(spot, TOP_N), Futures: topByVolume(futures, TOP_N) };
}

function startBinanceTopWs(onUpdate, onError) {
  const sockets = { Spot: null, Futures: null };
  const volumeMaps = { Spot: new Map(), Futures: new Map() };
  const symbolSets = { Spot: new Set(), Futures: new Set() };
  const hosts = {
    Spot: 'wss://stream.binance.com:9443/stream?streams=',
    Futures: 'wss://fstream.binance.com/stream?streams=',
  };
  let consecutiveFailures = 0;

  function emit(marketType) {
    const items = Array.from(volumeMaps[marketType], ([symbol, volume]) => ({ symbol, volume }));
    onUpdate(marketType, topByVolume(items, TOP_N));
  }

  function connectFor(marketType, symbols) {
    const old = sockets[marketType];
    if (old) {
      old._intentionalClose = true;
      old.terminate();
    }
    if (symbols.length === 0) return;

    const streams = symbols.map(s => `${s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(hosts[marketType] + streams);
    sockets[marketType] = ws;

    ws.on('open', () => console.log(`[Binance ${marketType}] WS подписан на топ-${symbols.length}`));
    ws.on('message', raw => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        return;
      }
      const d = msg && msg.data;
      if (!d || typeof d.s !== 'string') return;
      volumeMaps[marketType].set(d.s, parseFloat(d.q));
      emit(marketType);
    });
    ws.on('close', () => {
      if (ws._intentionalClose) return;
      console.warn(`[Binance ${marketType}] WS закрылся неожиданно, переподключаюсь через 5с`);
      setTimeout(() => connectFor(marketType, Array.from(symbolSets[marketType])), 5000);
    });
    ws.on('error', err => console.warn(`[Binance ${marketType}] WS error:`, err.message));
  }

  async function rerank() {
    try {
      const ranking = await fetchBinanceRanking();
      consecutiveFailures = 0;

      ['Spot', 'Futures'].forEach(marketType => {
        const items = ranking[marketType];
        const newSet = new Set(items.map(i => i.symbol));

        items.forEach(i => volumeMaps[marketType].set(i.symbol, i.volume));
        Array.from(volumeMaps[marketType].keys()).forEach(sym => {
          if (!newSet.has(sym)) volumeMaps[marketType].delete(sym);
        });

        const changed = symbolSets[marketType].size !== newSet.size ||
          Array.from(newSet).some(s => !symbolSets[marketType].has(s));
        symbolSets[marketType] = newSet;

        if (changed || !sockets[marketType]) {
          connectFor(marketType, Array.from(newSet));
        }
        emit(marketType);
      });

      scheduleNext(RERANK_MS);
    } catch (err) {
      consecutiveFailures++;
      const backoff = err.retryAfterMs || Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** (consecutiveFailures - 1));
      console.warn(`[Binance] rerank failed (попытка ${consecutiveFailures}):`, err.message, `— повтор через ${Math.round(backoff / 1000)}с`);
      if (typeof onError === 'function') onError('Spot', err.message);
      if (typeof onError === 'function') onError('Futures', err.message);
      scheduleNext(backoff);
    }
  }

  function scheduleNext(delay) {
    setTimeout(rerank, delay);
  }

  return rerank();
}

module.exports = { fetchWhiteBit, fetchBybit, fetchOkx, startBinanceTopWs };
