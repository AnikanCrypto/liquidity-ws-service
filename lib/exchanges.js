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

// TradeFi/токенизированные акции — тот же список, что и для WhiteBIT.
// Дополнено тикерами ETF/акций, которые видел на Bitget (rNVDA, rSPY,
// rQQQ и т.п. — у Bitget такие пары просто начинаются с буквы "R").
const TRADEFI_BASE_TICKERS = [
  'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'GOOG', 'META', 'NFLX',
  'COIN', 'HOOD', 'MSTR', 'AMD', 'AVGO', 'INTC', 'BA', 'JPM',
  'XAU', 'XAG', 'WTI', 'BRENT', 'XTI', 'XBR',
  'SPX', 'US500', 'NAS100', 'NDX', 'US30', 'DJI',
  'JP225', 'N225', 'KR200',
  'QQQ', 'SPY', 'VOO', 'IVV', 'SOXL', 'SOXS', 'PLTR', 'MRVL', 'SPCX', 'SNDK', 'CRCL', 'TSM',
];

// Bitget помечает ВСЕ токенизированные акции префиксом "R" перед тикером
// (rNVDAUSDT, rSPYUSDT, rMUUSDT, rCRMUSDT...) — таких пар у них уже
// сотни и появляются новые постоянно, перечислять их по названию
// бесполезно. Проще наоборот: настоящих крипто-тикеров, начинающихся
// на "R", в топах по объёму немного и они стабильны — держим их
// белым списком-исключением, а всё остальное с "R" в начале режем.
// ВАЖНО: 'RIO' сюда специально не входит — это тикер акции Rio Tinto
// (rRIOUSDT), а не крипто-проект, хотя название и похоже на RIO/Realio.
const BITGET_REAL_R_CRYPTO = new Set([
  'RVN', 'RUNE', 'RSR', 'RENDER', 'RNDR', 'ROSE', 'RARE', 'REN', 'RPL', 'RLC',
  'RAY', 'RDNT', 'RIF', 'RON', 'REZ', 'RSS3', 'RSC', 'RAD', 'RBN',
  'RFOX', 'RAIN', 'RIA', 'RCH',
]);

function isBitgetTokenizedStock(symbol, quoteAsset) {
  if (!symbol.startsWith('R')) return false;
  const base = symbol.slice(1, symbol.length - quoteAsset.length).toUpperCase();
  return !BITGET_REAL_R_CRYPTO.has(base);
}

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

// ==================== BITGET (REST poll) ====================

async function fetchBitget() {
  const [spotData, futuresData] = await Promise.all([
    getJson('https://api.bitget.com/api/v2/spot/market/tickers'),
    getJson('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES'),
  ]);
  const spotList = spotData.data || [];
  const futuresList = futuresData.data || [];

  const spot = spotList
    .filter(d => d.symbol.endsWith(QUOTE_ASSET) && !isBitgetTokenizedStock(d.symbol, QUOTE_ASSET))
    .map(d => ({ symbol: d.symbol, volume: parseFloat(d.usdtVolume || d.quoteVolume) }));
  const futures = futuresList
    .filter(d => d.symbol.endsWith(QUOTE_ASSET) && !isBitgetTokenizedStock(d.symbol, QUOTE_ASSET))
    .map(d => ({ symbol: d.symbol, volume: parseFloat(d.usdtVolume || d.quoteVolume) }));

  return { Spot: topByVolume(spot, TOP_N), Futures: topByVolume(futures, TOP_N) };
}

// ==================== KUCOIN (REST poll) ====================

async function fetchKuCoin() {
  const [spotData, futuresData] = await Promise.all([
    getJson('https://api.kucoin.com/api/v1/market/allTickers'),
    getJson('https://api-futures.kucoin.com/api/v1/contracts/active'),
  ]);
  const spotList = (spotData.data && spotData.data.ticker) || [];
  const futuresList = futuresData.data || [];

  const spot = spotList
    .filter(d => d.symbol.endsWith('-' + QUOTE_ASSET))
    .map(d => ({ symbol: d.symbol, volume: parseFloat(d.volValue) }));
  const futures = futuresList
    .filter(d => d.quoteCurrency === QUOTE_ASSET)
    .map(d => ({ symbol: d.symbol, volume: parseFloat(d.turnoverOf24h) }));

  return { Spot: topByVolume(spot, TOP_N), Futures: topByVolume(futures, TOP_N) };
}

// ==================== MEXC (REST poll) ====================

async function fetchMexc() {
  const [spotData, futuresData] = await Promise.all([
    getJson('https://api.mexc.com/api/v3/ticker/24hr'),
    getJson('https://contract.mexc.com/api/v1/contract/ticker'),
  ]);
  const futuresList = futuresData.data || [];

  const spot = spotData
    .filter(d => d.symbol.endsWith(QUOTE_ASSET))
    .map(d => ({ symbol: d.symbol, volume: parseFloat(d.quoteVolume) }));
  const futures = futuresList
    .filter(d => d.symbol.endsWith('_' + QUOTE_ASSET))
    .map(d => ({ symbol: d.symbol, volume: parseFloat(d.amount24) }));

  return { Spot: topByVolume(spot, TOP_N), Futures: topByVolume(futures, TOP_N) };
}

// ==================== GATE.IO (REST poll) ====================

async function fetchGate() {
  const [spotData, futuresData] = await Promise.all([
    getJson('https://api.gateio.ws/api/v4/spot/tickers'),
    getJson('https://api.gateio.ws/api/v4/futures/usdt/tickers'),
  ]);

  const spot = spotData
    .filter(d => d.currency_pair.endsWith('_' + QUOTE_ASSET))
    .map(d => ({ symbol: d.currency_pair, volume: parseFloat(d.quote_volume) }));
  // Этот эндпоинт уже возвращает только USDT-контракты
  const futures = futuresData.map(d => ({ symbol: d.contract, volume: parseFloat(d.volume_24h_quote) }));

  return { Spot: topByVolume(spot, TOP_N), Futures: topByVolume(futures, TOP_N) };
}

// ==================== KRAKEN (REST poll) ====================
// Спот требует двухшаговый запрос (сначала список USDT-пар, потом
// тикеры по ним). Объём v[1] у Kraken — в базовой валюте, поэтому
// домножаем на средневзвешенную цену p[1], чтобы получить USDT.
// Futures на Kraken торгуются в основном в USD, а не в USDT — это
// особенность площадки, не баг фильтра.

async function fetchKraken() {
  const pairsData = await getJson('https://api.kraken.com/0/public/AssetPairs');
  const pairs = pairsData.result || {};
  const usdtPairNames = Object.keys(pairs).filter(name => {
    const q = pairs[name].quote;
    return q === 'USDT' || q === 'ZUSDT';
  });

  const spotItems = [];
  for (let i = 0; i < usdtPairNames.length; i += 100) {
    const chunk = usdtPairNames.slice(i, i + 100);
    const tickerData = await getJson('https://api.kraken.com/0/public/Ticker?pair=' + chunk.join(','));
    const result = tickerData.result || {};
    Object.keys(result).forEach(key => {
      const t = result[key];
      const volBase24h = parseFloat(t.v[1]);
      const vwap24h = parseFloat(t.p[1]);
      spotItems.push({ symbol: key, volume: volBase24h * vwap24h });
    });
  }

  const futuresData = await getJson('https://futures.kraken.com/derivatives/api/v3/tickers');
  const futuresList = futuresData.tickers || [];
  const futures = futuresList
    .filter(d => d.tag === 'perpetual' && d.pair && (d.pair.endsWith(':USD') || d.pair.endsWith(':USDT')))
    .map(d => ({ symbol: d.symbol, volume: parseFloat(d.volumeQuote) }));

  return { Spot: topByVolume(spotItems, TOP_N), Futures: topByVolume(futures, TOP_N) };
}

// ==================== HTX / HUOBI (REST poll) ====================

async function fetchHtx() {
  const [spotData, futuresData] = await Promise.all([
    getJson('https://api.huobi.pro/market/tickers'),
    getJson('https://api.hbdm.com/linear-swap-ex/market/detail/batch_merged'),
  ]);
  const spotList = spotData.data || [];
  const futuresList = futuresData.ticks || [];

  const spot = spotList
    .filter(d => d.symbol.endsWith(QUOTE_ASSET.toLowerCase()))
    .map(d => ({ symbol: d.symbol.toUpperCase(), volume: parseFloat(d.vol) }));
  const futures = futuresList
    .filter(d => d.contract_code.endsWith('-' + QUOTE_ASSET))
    .map(d => ({ symbol: d.contract_code, volume: parseFloat(d.trade_turnover) }));

  return { Spot: topByVolume(spot, TOP_N), Futures: topByVolume(futures, TOP_N) };
}

// ==================== BITFINEX (REST poll) ====================
// VOLUME у Bitfinex — в базовой валюте (штуках монеты), поэтому
// домножаем на LAST_PRICE, чтобы получить нотационный объём в USDT
// (у Bitfinex это технически UST — их привязанный к USDT токен).
// Перпетуалов у Bitfinex всего несколько штук — короткий список
// в Futures это нормально, не баг фильтра.

async function fetchBitfinex() {
  const data = await getJson('https://api-pub.bitfinex.com/v2/tickers?symbols=ALL');

  const spot = data
    .filter(d => typeof d[0] === 'string' && d[0].charAt(0) === 't' && d[0].endsWith('UST') && d[0].indexOf(':') === -1)
    .map(d => ({ symbol: d[0], volume: parseFloat(d[8]) * parseFloat(d[7]) }));
  const futures = data
    .filter(d => typeof d[0] === 'string' && d[0].charAt(0) === 't' && d[0].indexOf(':USTF0') !== -1)
    .map(d => ({ symbol: d[0], volume: parseFloat(d[8]) * parseFloat(d[7]) }));

  return { Spot: topByVolume(spot, TOP_N), Futures: topByVolume(futures, TOP_N) };
}

// ==================== BINANCE (топ-20 через REST, live-объём через WS) ====================
// Идея: НЕ тянуть весь рынок (тысячи тикеров) через балк-поток — именно
// это не тянул бесплатный инстанс Render. Вместо этого лёгким REST-
// запросом (раз в BINANCE_RERANK_MS) определяем текущий топ-20 по
// объёму, а дальше подписываемся через WS только на эти 20 символов —
// это уже совсем небольшой поток данных.

// Раз в BINANCE_RERANK_MS (по умолчанию 30 минут — совпадает с частотой
// записи в таблицу, чаще пересчитывать топ смысла нет) лёгким REST-
// запросом определяем текущий топ-20, а WS подписывается только на них.
const RERANK_MS = Number(process.env.BINANCE_RERANK_MS || 30 * 60 * 1000);
const MIN_RETRY_MS = 60 * 1000;   // при ошибке начинаем с минуты...
const MAX_RETRY_MS = 15 * 60 * 1000; // ...и растим до 15 минут (экспоненциально)

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
      old._intentionalClose = true; // чтобы close-хендлер старого сокета не переподключался сам
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
      if (ws._intentionalClose) return; // сами закрыли ради переподписки — не реконнектим
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
      // HTTP 418/429 у Binance = временный бан IP за частые запросы —
      // не долбим повторно сразу, а отступаем экспоненциально, уважая
      // Retry-After если он есть.
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

  // Первый rerank дожидаемся перед стартом таймера — чтобы сразу были
  // хоть какие-то данные для первой записи в таблицу (если он падает,
  // ошибка всё равно попадёт в onError, а не зависнет молча).
  return rerank();
}

module.exports = {
  fetchWhiteBit, fetchBybit, fetchOkx,
  fetchBitget, fetchKuCoin, fetchMexc, fetchGate, fetchKraken, fetchHtx, fetchBitfinex,
  startBinanceTopWs,
};
