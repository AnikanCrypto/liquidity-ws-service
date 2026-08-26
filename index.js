'use strict';

const express = require('express');
const { buildLayout, buildStaticRequests, buildValueUpdates } = require('./lib/layout');
const { createSheetsClient, getOrCreateSheetId, clearSheetFormatting, applyBatchUpdate, applyValueUpdates } = require('./lib/sheetsClient');
const { fetchWhiteBit, fetchBybit, fetchOkx, startBinanceTopWs } = require('./lib/exchanges');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'LiquidityTop';
const REST_POLL_MS = Number(process.env.REST_POLL_MS || 15000);
const SHEET_WRITE_MS = Number(process.env.SHEET_WRITE_MS || 30000);
const PORT = process.env.PORT || 3000;

if (!SPREADSHEET_ID) {
  console.error('SPREADSHEET_ID env var is required');
  process.exit(1);
}

const state = {
  WhiteBIT: { Spot: [], Futures: [], TradeFi: [] },
  Binance: { Spot: [], Futures: [] },
  Bybit: { Spot: [], Futures: [] },
  OKX: { Spot: [], Futures: [] },
};

let lastUpdateAt = {};

function setBlock(exchange, type, items) {
  state[exchange][type] = items;
  lastUpdateAt[exchange] = Date.now();
}

function setBlockError(exchange, type, message) {
  const prev = state[exchange][type];
  if (Array.isArray(prev) && !prev.__error && prev.length > 0) {
    prev.__staleError = message;
    return;
  }
  const arr = [];
  arr.__error = message;
  state[exchange][type] = arr;
}

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

function startRestPolling() {
  const tick = () => { pollWhiteBit(); pollBybit(); pollOkx(); };
  const firstTick = Promise.allSettled([pollWhiteBit(), pollBybit(), pollOkx()]);
  setInterval(tick, REST_POLL_MS);
  return firstTick;
}

function startBinance() {
  return startBinanceTopWs(
    (marketType, items) => setBlock('Binance', marketType, items),
    (marketType, message) => setBlockError('Binance', marketType, message),
  );
}

let sheets;
let layout;

async function initSheet() {
  sheets = createSheetsClient();
  layout = buildLayout();
  const sheetId = await getOrCreateSheetId(sheets, SPREADSHEET_ID, SHEET_NAME);

  await clearSheetFormatting(sheets, SPREADSHEET_ID, sheetId);

  try {
    const staticRequests = buildStaticRequests(sheetId, layout);
    await applyBatchUpdate(sheets, SPREADSHEET_ID, staticRequests);
  } catch (err) {
    console.warn('[Sheets] static layout build had issues (probably fine on redeploy):', err.message);
  }

  return sheetId;
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
}

function startHealthServer() {
  const app = express();
  app.get('/', (req, res) => {
    res.json({ ok: true, lastUpdateAt });
  });
  app.get('/health', (req, res) => res.send('ok'));
  app.listen(PORT, () => console.log(`Health server listening on ${PORT}`));
}

function startSelfPing() {
  const externalUrl = process.env.RENDER_EXTERNAL_URL;
  if (!externalUrl) {
    console.log('[self-ping] RENDER_EXTERNAL_URL не задан (не на Render?) — само-пинг выключен');
    return;
  }
  const url = externalUrl.replace(/\/$/, '') + '/health';
  setInterval(() => {
    fetch(url).then(() => console.log('[self-ping] ok')).catch(err => console.warn('[self-ping] failed:', err.message));
  }, 10 * 60 * 1000);
}

(async () => {
  await initSheet();
  startHealthServer();
  startSelfPing();
  await Promise.all([startRestPolling(), startBinance()]);
  await pushToSheet();
  setInterval(pushToSheet, SHEET_WRITE_MS);
})().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
