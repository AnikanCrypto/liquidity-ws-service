'use strict';

const { TOP_ROWS } = require('./comparison');

const HEADER_BG = '#1F1B2E';
const TITLE_BG = '#37324A';
const SUBTITLE_BG = '#EDEAF5';
const COL_HEADER_BG = '#F1F3F4';
const REC_COLORS = {
  add: '#FCE8E6',   // добавить в листинг
  raise: '#FFF3CD', // поднять ранг
  good: '#E3F2E4',  // всё ок / торгуется активнее среднего
};

function rgb(hex) {
  const h = hex.replace('#', '');
  return {
    red: parseInt(h.substring(0, 2), 16) / 255,
    green: parseInt(h.substring(2, 4), 16) / 255,
    blue: parseInt(h.substring(4, 6), 16) / 255,
  };
}

function recColor(rec) {
  if (rec.startsWith('Добавить')) return REC_COLORS.add;
  if (rec.startsWith('Поднять')) return REC_COLORS.raise;
  return REC_COLORS.good;
}

// ==================== СТАТИЧЕСКАЯ РАЗМЕТКА ====================
// Функции здесь работают с ОДНОЙ таблицей (Spot+Futures друг под другом)
// на весь лист — вызываются дважды с разными sheetId, каждый раз для
// своего отдельного листа ("Сравнение-3-биржи" и "Сравнение-10-бирж").

const TOTAL_COLS = 9; // # | Монета | Binance | Bybit | OKX | Бирж | Ø ранг | Ранг WhiteBIT | Рекомендация

function buildLayout() {
  let row = 1;
  const timestampRow = row; row += 2; // + пустая строка

  const titleRow = row; row += 1;
  const spotTypeRow = row; row += 1;
  const spotHeaderRow = row; row += 1;
  const spotDataStart = row; row += TOP_ROWS;
  row += 1; // разделитель
  const futTypeRow = row; row += 1;
  const futHeaderRow = row; row += 1;
  const futDataStart = row; row += TOP_ROWS;

  return {
    timestampRow,
    titleRow,
    Spot: { typeRow: spotTypeRow, headerRow: spotHeaderRow, dataStart: spotDataStart, dataEnd: spotDataStart + TOP_ROWS - 1 },
    Futures: { typeRow: futTypeRow, headerRow: futHeaderRow, dataStart: futDataStart, dataEnd: futDataStart + TOP_ROWS - 1 },
    lastRow: row - 1,
  };
}

function buildStaticRequests(sheetId, layout, titleText, headerLabels) {
  const requests = [];

  // Та же подстраховка, что и в основном листе — расширяем сетку под
  // нужную ширину до любых merge/format запросов.
  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { columnCount: TOTAL_COLS + 5 } },
      fields: 'gridProperties.columnCount',
    },
  });

  function mergeText(rowStart, colStart, numCols, value, { bg, fg = '#FFFFFF', bold = true, align = 'CENTER' } = {}) {
    const range = { sheetId, startRowIndex: rowStart - 1, endRowIndex: rowStart, startColumnIndex: colStart - 1, endColumnIndex: colStart - 1 + numCols };
    if (numCols > 1) requests.push({ mergeCells: { range, mergeType: 'MERGE_ALL' } });
    requests.push({
      updateCells: {
        range,
        rows: [{ values: [{ userEnteredValue: { stringValue: value }, userEnteredFormat: { backgroundColor: bg ? rgb(bg) : undefined, horizontalAlignment: align, textFormat: { foregroundColor: rgb(fg), bold } } }] }],
        fields: 'userEnteredValue,userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)',
      },
    });
  }

  function headerRow(rowIdx, labels) {
    requests.push({
      updateCells: {
        range: { sheetId, startRowIndex: rowIdx - 1, endRowIndex: rowIdx, startColumnIndex: 0, endColumnIndex: labels.length },
        rows: [{ values: labels.map(v => ({ userEnteredValue: { stringValue: v }, userEnteredFormat: { backgroundColor: rgb(COL_HEADER_BG), horizontalAlignment: 'CENTER', textFormat: { bold: true } } })) }],
        fields: 'userEnteredValue,userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)',
      },
    });
  }

  function border(rowStart, rowEnd) {
    requests.push({
      updateBorders: {
        range: { sheetId, startRowIndex: rowStart - 1, endRowIndex: rowEnd, startColumnIndex: 0, endColumnIndex: TOTAL_COLS },
        top: { style: 'SOLID', color: rgb('#D0D3D6') }, bottom: { style: 'SOLID', color: rgb('#D0D3D6') },
        left: { style: 'SOLID', color: rgb('#D0D3D6') }, right: { style: 'SOLID', color: rgb('#D0D3D6') },
        innerHorizontal: { style: 'SOLID', color: rgb('#D0D3D6') }, innerVertical: { style: 'SOLID', color: rgb('#D0D3D6') },
      },
    });
  }

  mergeText(layout.timestampRow, 1, TOTAL_COLS, '', { bg: HEADER_BG });
  mergeText(layout.titleRow, 1, TOTAL_COLS, titleText, { bg: TITLE_BG });

  ['Spot', 'Futures'].forEach(mt => {
    const t = layout[mt];
    mergeText(t.typeRow, 1, TOTAL_COLS, mt, { bg: SUBTITLE_BG, fg: '#37324A', align: 'LEFT' });
    headerRow(t.headerRow, headerLabels);
    border(t.dataStart, t.dataEnd);
  });

  requests.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } });

  const widths = [40, 110, 80, 80, 80, 70, 70, 100, 320];
  widths.forEach((w, i) => {
    requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: w }, fields: 'pixelSize' } });
  });

  return requests;
}

// ==================== ОБНОВЛЕНИЕ ЗНАЧЕНИЙ (каждый цикл) ====================

function colLetter(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function a1(sheetName, c1, r1, c2, r2) {
  return `'${sheetName}'!${colLetter(c1)}${r1}:${colLetter(c2)}${r2}`;
}

// rowsByType: { Spot: [...], Futures: [...] } — уже готовые consensus-строки
// rowBuilder: (row) => [значения ячеек в порядке колонок]
function buildValueUpdates(sheetName, layout, rowsByType, timestampLabel, rowBuilder) {
  const data = [];
  data.push({ range: a1(sheetName, 1, layout.timestampRow, TOTAL_COLS, layout.timestampRow), values: [[timestampLabel, ...Array(TOTAL_COLS - 1).fill('')]] });

  ['Spot', 'Futures'].forEach(mt => {
    const t = layout[mt];
    const rows = rowsByType[mt];
    const values = [];
    for (let i = 0; i < TOP_ROWS; i++) {
      const r = rows[i];
      values.push(r ? rowBuilder(r) : Array(TOTAL_COLS).fill(''));
    }
    data.push({ range: a1(sheetName, 1, t.dataStart, TOTAL_COLS, t.dataEnd), values });
  });

  return data;
}

// Подсветка колонки "Рекомендация" (9-я, индекс 8) по смыслу —
// пересчитывается каждый цикл, т.к. значения (а значит и цвет) меняются.
function buildRecommendationColorRequests(sheetId, layout, rowsByType) {
  const requests = [];
  const recCol = 8;
  ['Spot', 'Futures'].forEach(mt => {
    const t = layout[mt];
    const rows = rowsByType[mt];
    for (let i = 0; i < TOP_ROWS; i++) {
      const r = rows[i];
      const rowIdx = t.dataStart + i;
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: rowIdx - 1, endRowIndex: rowIdx, startColumnIndex: recCol, endColumnIndex: recCol + 1 },
          cell: { userEnteredFormat: { backgroundColor: r ? rgb(recColor(r.recommendation)) : undefined } },
          fields: 'userEnteredFormat.backgroundColor',
        },
      });
    }
  });
  return requests;
}

module.exports = { buildLayout, buildStaticRequests, buildValueUpdates, buildRecommendationColorRequests };
