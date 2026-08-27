'use strict';

// ==================== НАСТРОЙКИ ====================

const REFERENCE_3 = ['Binance', 'Bybit', 'OKX'];
const ALL_OTHER_10 = ['Binance', 'Bybit', 'OKX', 'Bitget', 'KuCoin', 'MEXC', 'Gate.io', 'Kraken', 'HTX', 'Bitfinex'];
const TOP_ROWS = 20;

// ==================== НОРМАЛИЗАЦИЯ ТИКЕРОВ ====================
// У каждой биржи свой формат символа — приводим всё к одному базовому
// тикеру (например "BTC"), чтобы можно было сравнивать монеты между
// биржами независимо от их конкретной нотации:
//   WhiteBIT: BTC_USDT / BTC_PERP
//   Binance/Bybit/Bitget: BTCUSDT
//   OKX: BTC-USDT / BTC-USDT-SWAP
//   KuCoin spot: BTC-USDT   KuCoin futures: XBTUSDTM
//   MEXC/Gate.io: BTC_USDT
//   Kraken spot: обычно ...USDT   Kraken futures: PF_XBTUSD
//   Bitfinex: tBTCUST (спот) / tBTCF0:USTF0 (перпетуал)

function normalizeBase(rawSymbol, exchangeName) {
  let s = String(rawSymbol).toUpperCase();

  if (exchangeName === 'Bitfinex') {
    s = s.replace(/^T/, '');
    if (s.includes(':')) {
      s = s.split(':')[0];
      if (s.endsWith('F0')) s = s.slice(0, -2);
    } else if (s.endsWith('UST')) {
      s = s.slice(0, -3);
    }
    return s;
  }

  if (exchangeName === 'Kraken' && s.startsWith('PF_')) {
    s = s.slice(3);
  }

  if (s.includes('-')) {
    s = s.split('-')[0];
  } else if (s.endsWith('_PERP')) {
    s = s.slice(0, -5);
  } else if (s.endsWith('_USDT')) {
    s = s.slice(0, -5);
  } else if (s.endsWith('USDTM')) {
    s = s.slice(0, -5);
  } else if (s.endsWith('USDT')) {
    s = s.slice(0, -4);
  } else if (s.endsWith('USD')) {
    s = s.slice(0, -3);
  }

  if (s === 'XBT') s = 'BTC'; // Kraken/KuCoin futures используют XBT вместо BTC
  return s;
}

// ==================== ПОСТРОЕНИЕ КОНСЕНСУСА ====================
// state: { ExchangeName: { Spot: [{symbol, volume}], Futures: [...] } }
// (та же структура, что уже используется для основного листа LiquidityTop)

function buildRankMap(state, exchangeName, marketType) {
  const items = (state[exchangeName] && state[exchangeName][marketType]) || [];
  const map = new Map();
  if (Array.isArray(items) && !items.__error) {
    items.forEach((item, idx) => {
      if (!item || !item.symbol) return;
      const coin = normalizeBase(item.symbol, exchangeName);
      // Если у монеты несколько пар на бирже — берём лучший (наименьший) ранг
      if (!map.has(coin)) map.set(coin, idx + 1);
    });
  }
  return map;
}

function buildConsensus(state, exchangeNames, marketType) {
  const rankMaps = {};
  exchangeNames.forEach(ex => { rankMaps[ex] = buildRankMap(state, ex, marketType); });

  const coins = new Set();
  exchangeNames.forEach(ex => rankMaps[ex].forEach((_, coin) => coins.add(coin)));

  const rows = Array.from(coins).map(coin => {
    const ranks = {};
    let sum = 0, count = 0;
    exchangeNames.forEach(ex => {
      const r = rankMaps[ex].get(coin);
      ranks[ex] = r || null;
      if (r) { sum += r; count++; }
    });
    return { coin, ranks, count, avgRank: count ? sum / count : Infinity };
  });

  // Сортировка: сначала монеты, которые в топ-20 сразу у нескольких бирж
  // (это и есть "рыночный консенсус"), затем по среднему рангу внутри них.
  rows.sort((a, b) => (b.count - a.count) || (a.avgRank - b.avgRank));
  return rows;
}

function buildRecommendation(consensusPosition, whiteBitRank, count, totalExchanges) {
  const strongSignal = count >= Math.ceil(totalExchanges / 2); // популярна у большинства бирж из набора
  if (whiteBitRank == null) {
    return strongSignal
      ? 'Добавить в топ (сейчас нет в топ-20 WhiteBIT)'
      : 'Есть у части бирж — на усмотрение';
  }
  const delta = whiteBitRank - consensusPosition;
  if (delta >= 4) return `Поднять с #${whiteBitRank} ближе к #${consensusPosition}`;
  if (delta <= -4) return 'На WhiteBIT торгуется активнее среднего — ок';
  return 'Соответствует рынку';
}

function buildComparisonData(state) {
  const result = { table1: {}, table2: {} };

  ['Spot', 'Futures'].forEach(marketType => {
    const whiteBitRanks = buildRankMap(state, 'WhiteBIT', marketType);

    const consensus3 = buildConsensus(state, REFERENCE_3, marketType).slice(0, TOP_ROWS);
    result.table1[marketType] = consensus3.map((row, idx) => {
      const wbRank = whiteBitRanks.get(row.coin) || null;
      return {
        ...row,
        position: idx + 1,
        whiteBitRank: wbRank,
        recommendation: buildRecommendation(idx + 1, wbRank, row.count, REFERENCE_3.length),
      };
    });

    const consensus10 = buildConsensus(state, ALL_OTHER_10, marketType).slice(0, TOP_ROWS);
    result.table2[marketType] = consensus10.map((row, idx) => {
      const wbRank = whiteBitRanks.get(row.coin) || null;
      return {
        ...row,
        position: idx + 1,
        whiteBitRank: wbRank,
        recommendation: buildRecommendation(idx + 1, wbRank, row.count, ALL_OTHER_10.length),
      };
    });
  });

  return result;
}

module.exports = { normalizeBase, buildConsensus, buildComparisonData, REFERENCE_3, ALL_OTHER_10, TOP_ROWS };
