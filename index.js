'use strict';

const express = require('express');
const { buildLayout, buildStaticRequests, buildValueUpdates } = require('./lib/layout');
const { buildComparisonData, REFERENCE_3, ALL_OTHER_10 } = require('./lib/comparison');
const {
  buildLayout: buildComparisonLayout,
  buildStaticRequests: buildComparisonStaticRequests,
  buildValueUpdates: buildComparisonValueUpdates,
  buildRecommendationColorRequests,
} = require('./lib/comparisonSheet');
const { createSheetsClient, getOrCreateSheetId, clearSheetFormatting, applyBatchUpdate, applyValueUpdates } = require('./lib/sheetsClient');
const {
  fetchWhiteBit, fetchBybit, fetchOkx,
  fetchBitget, fetchKuCoin, fetchMexc, fetchGate, fetchKraken, fetchHtx, fetchBitfinex,
  startBinanceTopWs,
} = require('./lib/exchanges');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'LiquidityTop';
const TABLE1_SHEET_NAME = process.env.TABLE1_SHEET_NAME || 'Сравнение-3-биржи';
const TABLE2_SHEET_NAME = process.env.TABLE2_SHEET_NAME || 'Сравнение-10-бирж';
const REST_POLL_MS = Number(process.env.REST_POLL_MS || 15000);   // WhiteBIT/Bybit/OKX
const SHEET_WRITE_MS = Number(process.env.SHEET_WRITE_MS || 30000); // как часто пишем в таблицу
const PORT = process.env.PORT || 3000;

if (!SPREADSHEET_ID) {
  console.error('SPREADSHEET_ID env var is required');
  process.exit(1);
}

// ==================== СОСТОЯНИЕ (в памяти) ====================

const state = {
  WhiteBIT: { Spot: [], Futures: [], TradeFi: [] },
  Binance: { Spot: [], Futures: [] },
  Bybit: { Spot: [], Futures: [] },
  OKX: { Spot: [], Futures: [] },
  Bitget: { Spot: [], Futures: [] },
  KuCoin: { Spot: [], Futures: [] },
  MEXC: { Spot: [], Futures: [] },
  'Gate.io': { Spot: [], Futures: [] },
  Kraken: { Spot: [], Futures: [] },
  HTX: { Spot: [], Futures: [] },
  Bitfinex: { Spot: [], Futures: [] },
};

let lastUpdateAt = {}; // exchange -> timestamp последнего успешного обновления

function setBlock(exchange, type, items) {
  state[exchange][type] = items;
  lastUpdateAt[exchange] = Date.now();
}

function setBlockError(exchange, type, message) {
  const prev = state[exchange][type];
  // Если раньше уже были нормальные данные — оставляем их видимыми и
  // просто помечаем как "устаревшие", а не стираем в ноль. Полностью
  // пустой/ошибочный блок показываем только если данных не было вообще
  // ни разу (например, самый первый запуск).
  if (Array.isArray(prev) && !prev.__error && prev.length > 0) {
    prev.__staleError = message;
    return;
  }
  const arr = [];
  arr.__error = message;
  state[exchange][type] = arr;
}

// ==================== REST-ПОЛЛИНГ (WhiteBIT / Bybit / OKX) ====================
// Binance теперь отдельно — топ-20 определяется REST'ом, а объём внутри
// топа обновляется через лёгкий WS (см. lib/exchanges.js: startBinanceTopWs)

async function pollWhiteBit() {
  try {
    const r = await fetchWhiteBit();
    setBlock('WhiteBIT', 'Spot', r.Spot);
    setBlock('WhiteBIT', 'Futures', r.Futures);
    setBlock('WhiteBIT', 'TradeFi', r.TradeFi);
  } catch (err) {
    console.warn('[WhiteBIT] poll failed:', err.message);
    setBlockError('WhiteBIT', 'Spot', err.message);
    setBlockError('WhiteBIT', 'Futures', err.message);
    setBlockError('WhiteBIT', 'TradeFi', err.message);
  }
}

async function pollBybit() {
  try {
    const r = await fetchBybit();
    setBlock('Bybit', 'Spot', r.Spot);
    setBlock('Bybit', 'Futures', r.Futures);
  } catch (err) {
    console.warn('[Bybit] poll failed:', err.message);
    setBlockError('Bybit', 'Spot', err.message);
    setBlockError('Bybit', 'Futures', err.message);
  }
}

async function pollOkx() {
  try {
    const r = await fetchOkx();
    setBlock('OKX', 'Spot', r.Spot);
    setBlock('OKX', 'Futures', r.Futures);
  } catch (err) {
    console.warn('[OKX] poll failed:', err.message);
    setBlockError('OKX', 'Spot', err.message);
    setBlockError('OKX', 'Futures', err.message);
  }
}

// Общий шаблон опроса для бирж с одинаковой формой ответа {Spot, Futures}
function makeSimplePoller(exchangeName, fetchFn) {
  return async function poll() {
    try {
      const r = await fetchFn();
      setBlock(exchangeName, 'Spot', r.Spot);
      setBlock(exchangeName, 'Futures', r.Futures);
    } catch (err) {
      console.warn(`[${exchangeName}] poll failed:`, err.message);
      setBlockError(exchangeName, 'Spot', err.message);
      setBlockError(exchangeName, 'Futures', err.message);
    }
  };
}

const pollBitget = makeSimplePoller('Bitget', fetchBitget);
const pollKuCoin = makeSimplePoller('KuCoin', fetchKuCoin);
const pollMexc = makeSimplePoller('MEXC', fetchMexc);
const pollGate = makeSimplePoller('Gate.io', fetchGate);
const pollKraken = makeSimplePoller('Kraken', fetchKraken);
const pollHtx = makeSimplePoller('HTX', fetchHtx);
const pollBitfinex = makeSimplePoller('Bitfinex', fetchBitfinex);

function startRestPolling() {
  const pollers = [pollWhiteBit, pollBybit, pollOkx, pollBitget, pollKuCoin, pollMexc, pollGate, pollKraken, pollHtx, pollBitfinex];
  const tick = () => pollers.forEach(fn => fn());
  const firstTick = Promise.allSettled(pollers.map(fn => fn()));
  setInterval(tick, REST_POLL_MS);
  return firstTick;
}

// ==================== BINANCE (топ-20 REST + live WS) ====================

function startBinance() {
  return startBinanceTopWs(
    (marketType, items) => setBlock('Binance', marketType, items),
    (marketType, message) => setBlockError('Binance', marketType, message),
  );
}

// ==================== ЗАПИСЬ В GOOGLE SHEETS ====================

let sheets;
let layout;
let table1SheetId, table1Layout;
let table2SheetId, table2Layout;

const TABLE1_HEADER = ['#', 'Монета', 'Binance', 'Bybit', 'OKX', 'Бирж', 'Ø ранг', 'Ранг WhiteBIT', 'Рекомендация'];
const TABLE2_HEADER = ['#', 'Монета', '', '', '', 'Бирж (из 10)', 'Ø ранг', 'Ранг WhiteBIT', 'Рекомендация'];

function table1RowBuilder(r) {
  return [r.position, r.coin, r.ranks.Binance || '', r.ranks.Bybit || '', r.ranks.OKX || '', r.count, Math.round(r.avgRank * 10) / 10, r.whiteBitRank || 'нет', r.recommendation];
}
function table2RowBuilder(r) {
  return [r.position, r.coin, '', '', '', r.count, Math.round(r.avgRank * 10) / 10, r.whiteBitRank || 'нет', r.recommendation];
}

async function initSheet() {
  sheets = createSheetsClient();
  layout = buildLayout();
  const sheetId = await getOrCreateSheetId(sheets, SPREADSHEET_ID, SHEET_NAME);

  await clearSheetFormatting(sheets, SPREADSHEET_ID, sheetId);

  try {
    const staticRequests = buildStaticRequests(sheetId, layout);
    await applyBatchUpdate(sheets, SPREADSHEET_ID, staticRequests);
  } catch (err) {
    // Например, группы колонок уже существуют с прошлого деплоя —
    // не критично, значения всё равно обновятся дальше.
    console.warn('[Sheets] static layout build had issues (probably fine on redeploy):', err.message);
  }

  return sheetId;
}

async function initComparisonSheets() {
  table1Layout = buildComparisonLayout();
  table1SheetId = await getOrCreateSheetId(sheets, SPREADSHEET_ID, TABLE1_SHEET_NAME);
  await clearSheetFormatting(sheets, SPREADSHEET_ID, table1SheetId);
  try {
    const requests = buildComparisonStaticRequests(table1SheetId, table1Layout, `Консенсус: ${REFERENCE_3.join(' + ')} vs WhiteBIT`, TABLE1_HEADER);
    await applyBatchUpdate(sheets, SPREADSHEET_ID, requests);
  } catch (err) {
    console.warn('[Sheets] table1 static layout had issues (probably fine on redeploy):', err.message);
  }

  table2Layout = buildComparisonLayout();
  table2SheetId = await getOrCreateSheetId(sheets, SPREADSHEET_ID, TABLE2_SHEET_NAME);
  await clearSheetFormatting(sheets, SPREADSHEET_ID, table2SheetId);
  try {
    const requests = buildComparisonStaticRequests(table2SheetId, table2Layout, `Консенсус по ${ALL_OTHER_10.length} биржам vs WhiteBIT (рекомендации по листингу)`, TABLE2_HEADER);
    await applyBatchUpdate(sheets, SPREADSHEET_ID, requests);
  } catch (err) {
    console.warn('[Sheets] table2 static layout had issues (probably fine on redeploy):', err.message);
  }
}

async function pushToSheet() {
  try {
    const tzLabel = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Kyiv' });
    const data = buildValueUpdates(SHEET_NAME, layout, state, 'Обновлено: ' + tzLabel + ' (реальное время)');
    await applyValueUpdates(sheets, SPREADSHEET_ID, data);
    console.log('[Sheets] pushed at', tzLabel);
  } catch (err) {
    console.error('[Sheets] push failed:', err.message);
  }

  try {
    const tzLabel = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Kyiv' });
    const comparisonData = buildComparisonData(state);

    const t1Values = buildComparisonValueUpdates(TABLE1_SHEET_NAME, table1Layout, comparisonData.table1, 'Обновлено: ' + tzLabel, table1RowBuilder);
    await applyValueUpdates(sheets, SPREADSHEET_ID, t1Values);
    const t1Colors = buildRecommendationColorRequests(table1SheetId, table1Layout, comparisonData.table1);
    await applyBatchUpdate(sheets, SPREADSHEET_ID, t1Colors);

    const t2Values = buildComparisonValueUpdates(TABLE2_SHEET_NAME, table2Layout, comparisonData.table2, 'Обновлено: ' + tzLabel, table2RowBuilder);
    await applyValueUpdates(sheets, SPREADSHEET_ID, t2Values);
    const t2Colors = buildRecommendationColorRequests(table2SheetId, table2Layout, comparisonData.table2);
    await applyBatchUpdate(sheets, SPREADSHEET_ID, t2Colors);

    console.log('[Sheets] comparison pushed at', tzLabel);
  } catch (err) {
    console.error('[Sheets] comparison push failed:', err.message);
  }
}

// ==================== HEALTH-СЕРВЕР (нужен, чтобы Render не считал сервис мёртвым) ====================

function startHealthServer() {
  const app = express();
  app.get('/', (req, res) => {
    res.json({ ok: true, lastUpdateAt });
  });
  app.get('/health', (req, res) => res.send('ok'));
  app.listen(PORT, () => console.log(`Health server listening on ${PORT}`));
}

// Render (бесплатный тариф) усыпляет Web Service после 15 минут без
// входящих HTTP-запросов — а у нас весь трафик исходящий (WS к Binance,
// поллинг бирж), входящих никто не делает. Чтобы не заводить внешний
// cron, сервис пингует сам себя: Render автоматически прокидывает
// RENDER_EXTERNAL_URL с публичным адресом сервиса.
function startSelfPing() {
  const externalUrl = process.env.RENDER_EXTERNAL_URL;
  if (!externalUrl) {
    console.log('[self-ping] RENDER_EXTERNAL_URL не задан (не на Render?) — само-пинг выключен');
    return;
  }
  const url = externalUrl.replace(/\/$/, '') + '/health';
  setInterval(() => {
    fetch(url).then(() => console.log('[self-ping] ok')).catch(err => console.warn('[self-ping] failed:', err.message));
  }, 10 * 60 * 1000); // каждые 10 минут — с запасом до 15-минутного лимита
}

// ==================== СТАРТ ====================

(async () => {
  await initSheet();
  await initComparisonSheets();
  startHealthServer();
  startSelfPing();
  await Promise.all([startRestPolling(), startBinance()]); // дожидаемся первых данных по всем биржам...
  await pushToSheet();      // ...и сразу пишем в таблицу, не дожидаясь SHEET_WRITE_MS
  setInterval(pushToSheet, SHEET_WRITE_MS); // дальше уже по расписанию (например, раз в 30 минут)
})().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
