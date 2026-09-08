'use strict';

// ==================== НАСТРОЙКИ ====================

const REFERENCE_3 = ['Binance', 'Bybit', 'OKX'];
const ALL_OTHER_10 = ['Binance', 'Bybit', 'OKX', 'Bitget', 'KuCoin', 'MEXC', 'Gate.io', 'Kraken', 'HTX', 'Bitfinex'];

const TARGET_SIZE = 20;   // сколько "идеальных" слотов строим по консенсусу
const ALIGNMENT_ROWS = 22; // сколько строк выделяем на листе (с запасом под pinned/capped)
const TOP_ROWS = ALIGNMENT_ROWS; // используется comparisonSheet.js для разметки

// ==================== БИЗНЕС-ПРАВИЛА ПО WHITEBIT ====================
// pinned: тикер -> фиксированная позиция на WhiteBIT, которую нельзя
//         менять (обычно — собственный токен биржи, которого физически
//         нет на других площадках, поэтому сравнивать не с чем).
// capped: тикер -> максимально допустимый ранг (эта монета НЕ должна
//         попадать выше этой позиции на WhiteBIT, даже если по спросу
//         на других биржах она популярна).
const POLICY_BY_MARKET_TYPE = {
  Futures: {
    pinned: { WBT: 5 },
    capped: { ASTER: 15, BNB: 15 },
  },
  Spot: {
    pinned: {},
    capped: {},
  },
  TradeFi: {
    pinned: {},
    capped: {},
  },
};

function getPolicy(marketType) {
  return POLICY_BY_MARKET_TYPE[marketType] || { pinned: {}, capped: {} };
}

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

  if (s === 'XBT') s = 'BTC'; // Kraken/KuCoin футы используют XBT вместо BTC
  return s;
}

// ==================== БАЗОВЫЕ СТРОИТЕЛЬНЫЕ БЛОКИ ====================
// state: { ExchangeName: { Spot: [{symbol, volume}], Futures: [...] } }

function buildRankMap(state, exchangeName, marketType) {
  const items = (state[exchangeName] && state[exchangeName][marketType]) || [];
  const map = new Map();
  if (Array.isArray(items) && !items.__error) {
    items.forEach((item, idx) => {
      if (!item || !item.symbol) return;
      const coin = normalizeBase(item.symbol, exchangeName);
      if (!map.has(coin)) map.set(coin, idx + 1); // лучший (наименьший) ранг, если пар несколько
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

  rows.sort((a, b) => (b.count - a.count) || (a.avgRank - b.avgRank));
  return rows;
}

// ==================== ПОСТРОЕНИЕ ЦЕЛЕВОГО ПОРЯДКА ====================
// Строим "как должно быть на WhiteBIT" с учётом занятых pinned-слотов и
// без учёта capped-монет (их в целевой топ не подставляем — они там
// не должны быть по определению).

function buildTargetOrder(consensusRows, policy, size) {
  const targetMap = new Map();
  const takenPositions = new Set();

  Object.entries(policy.pinned).forEach(([coin, pos]) => {
    targetMap.set(coin, pos);
    takenPositions.add(pos);
  });

  const cappedCoins = new Set(Object.keys(policy.capped));
  let nextPos = 1;
  for (const row of consensusRows) {
    if (targetMap.has(row.coin) || cappedCoins.has(row.coin)) continue;
    while (takenPositions.has(nextPos)) nextPos++;
    if (nextPos > size) break;
    targetMap.set(row.coin, nextPos);
    takenPositions.add(nextPos);
    nextPos++;
  }

  return targetMap;
}

// ==================== ИТОГОВЫЕ СТРОКИ СРАВНЕНИЯ ====================

function buildAlignmentRows(state, marketType, referenceExchanges) {
  const policy = getPolicy(marketType);
  const consensusRows = buildConsensus(state, referenceExchanges, marketType);
  const consensusByCoin = new Map(consensusRows.map(r => [r.coin, r]));
  const targetMap = buildTargetOrder(consensusRows, policy, TARGET_SIZE);
  const whiteBitRanks = buildRankMap(state, 'WhiteBIT', marketType);

  const coins = new Set([
    ...targetMap.keys(),
    ...whiteBitRanks.keys(),
    ...Object.keys(policy.pinned),
    ...Object.keys(policy.capped),
  ]);

  const rows = [];
  coins.forEach(coin => {
    const actualRank = whiteBitRanks.has(coin) ? whiteBitRanks.get(coin) : null;
    const targetRank = targetMap.has(coin) ? targetMap.get(coin) : null;
    const isPinned = Object.prototype.hasOwnProperty.call(policy.pinned, coin);
    const isCapped = Object.prototype.hasOwnProperty.call(policy.capped, coin);
    const consensusRow = consensusByCoin.get(coin) || null;

    // Монета вообще ни при делах — ни на WhiteBIT, ни в целевом топе, ни под правилом — пропускаем
    if (actualRank == null && targetRank == null && !isPinned && !isCapped) return;

    let status, colorKey, delta = null;

    if (isPinned) {
      if (actualRank == null) {
        status = `Ожидался на #${targetRank} (нативный токен), но сейчас не найден в топ-20 — проверить`;
        colorKey = 'violation';
      } else if (actualRank === targetRank) {
        status = `Зафиксировано на #${targetRank} (нативный токен) — не трогать`;
        colorKey = 'pinned';
      } else {
        status = `Нативный токен — ожидается #${targetRank}, сейчас #${actualRank} (не трогать, но свериться)`;
        colorKey = 'pinned';
      }
    } else if (isCapped) {
      const cap = policy.capped[coin];
      if (actualRank != null && actualRank <= cap) {
        status = `Не должен быть в топ-${cap} (сейчас #${actualRank})`;
        colorKey = 'violation';
      } else {
        status = actualRank != null ? `Вне топ-${cap} — ок (#${actualRank})` : `Вне топ-${cap} — ок`;
        colorKey = 'good';
      }
    } else if (targetRank == null) {
      status = 'Есть на WhiteBIT, но нет в топ-20 у сравниваемых бирж';
      colorKey = 'neutral';
    } else if (actualRank == null) {
      status = `Добавить на позицию ~#${targetRank} (сейчас нет в топ-20 WhiteBIT)`;
      colorKey = 'add';
    } else {
      delta = actualRank - targetRank;
      if (Math.abs(delta) <= 2) {
        status = `Совпадает (#${actualRank})`;
        colorKey = 'good';
      } else if (delta > 0) {
        status = `Поднять с #${actualRank} до #${targetRank}`;
        colorKey = 'raise';
      } else {
        status = `Опустить с #${actualRank} до #${targetRank}`;
        colorKey = 'lower';
      }
    }

    rows.push({
      coin,
      targetRank,
      actualRank,
      delta,
      isPinned,
      isCapped,
      ranks: consensusRow ? consensusRow.ranks : Object.fromEntries(referenceExchanges.map(ex => [ex, null])),
      count: consensusRow ? consensusRow.count : 0,
      avgRank: consensusRow && Number.isFinite(consensusRow.avgRank) ? consensusRow.avgRank : null,
      status,
      colorKey,
    });
  });

  rows.sort((a, b) => {
    const pa = a.targetRank != null ? a.targetRank : (a.actualRank != null ? a.actualRank : 999) + 0.5;
    const pb = b.targetRank != null ? b.targetRank : (b.actualRank != null ? b.actualRank : 999) + 0.5;
    return pa - pb;
  });

  return rows.slice(0, ALIGNMENT_ROWS);
}

function buildComparisonData(state) {
  const result = { table1: {}, table2: {} };
  ['Spot', 'Futures'].forEach(marketType => {
    result.table1[marketType] = buildAlignmentRows(state, marketType, REFERENCE_3);
    result.table2[marketType] = buildAlignmentRows(state, marketType, ALL_OTHER_10);
  });
  return result;
}

module.exports = {
  normalizeBase,
  buildConsensus,
  buildComparisonData,
  REFERENCE_3,
  ALL_OTHER_10,
  TOP_ROWS,
  TARGET_SIZE,
  POLICY_BY_MARKET_TYPE,
};
