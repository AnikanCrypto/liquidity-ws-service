'use strict';

const { REFERENCE_3, TOP_ROWS } = require('./comparison');

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

// ==================== СТАТИЧЕСКАЯ РАЗМЕТКА (строится один раз) ====================
// Обе таблицы используют ОДНУ и ту же 9-колоночную сетку — так колонки
// "Ø ранг", "Ранг WhiteBIT" и "Рекомендация" всегда в одном и том же
// месте независимо от таблицы, а у таблицы 2 просто пустуют колонки
// C/D/E (там нет разбивки по трём конкретным биржам).

const TOTAL_COLS = 9;
// A=# | B=Монета | C=Binance | D=Bybit | E=OKX | F=Бирж | G=Ø ранг | H=Ранг WhiteBIT | I=Рекомендация

function buildLayout() {
  let row = 1;
  const timestampRow = row; row += 2; // + пустая строка

  const table1TitleRow = row; row += 1;
  const spot1TypeRow = row; row += 1;
  const spot1HeaderRow = row; row += 1;
  const spot1DataStart = row; row += TOP_ROWS;
  row += 1; // разделитель
  const fut1TypeRow = row; row += 1;
  const fut1HeaderRow = row; row += 1;
  const fut1DataStart = row; row += TOP_ROWS;
  row += 2; // разделитель перед второй таблицей

  const table2TitleRow = row; row += 1;
  const spot2TypeRow = row; row += 1;
  const spot2HeaderRow = row; row += 1;
  const spot2DataStart = row; row += TOP_ROWS;
  row += 1;
  const fut2TypeRow = row; row += 1;
  const fut2HeaderRow = row; row += 1;
  const fut2DataStart = row; row += TOP_ROWS;

  return {
    timestampRow,
    table1TitleRow,
    table1: {
      Spot: { typeRow: spot1TypeRow, headerRow: spot1HeaderRow, dataStart: spot1DataStart, dataEnd: spot1DataStart + TOP_ROWS - 1 },
      Futures: { typeRow: fut1TypeRow, headerRow: fut1HeaderRow, dataStart: fut1DataStart, dataEnd: fut1DataStart + TOP_ROWS - 1 },
    },
    table2TitleRow,
    table2: {
      Spot: { typeRow: spot2TypeRow, headerRow: spot2HeaderRow, dataStart: spot2DataStart, dataEnd: spot2DataStart + TOP_ROWS - 1 },
      Futures: { typeRow: fut2TypeRow, headerRow: fut2HeaderRow, dataStart: fut2DataStart, dataEnd: fut2DataStart + TOP_ROWS - 1 },
    },
    lastRow: row - 1,
  };
}

function buildStaticRequests(sheetId, layout) {
  const requests = [];

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

  mergeText(layout.table1TitleRow, 1, TOTAL_COLS, `ТАБЛИЦА 1 — консенсус: ${REFERENCE_3.join(' + ')} vs WhiteBIT`, { bg: TITLE_BG });
  ['Spot', 'Futures'].forEach(mt => {
    const t = layout.table1[mt];
    mergeText(t.typeRow, 1, TOTAL_COLS, mt, { bg: SUBTITLE_BG, fg: '#37324A', align: 'LEFT' });
    headerRow(t.headerRow, ['#', 'Монета', 'Binance', 'Bybit', 'OKX', 'Бирж', 'Ø ранг', 'Ранг WhiteBIT', 'Рекомендация']);
    border(t.dataStart, t.dataEnd);
  });

  mergeText(layout.table2TitleRow, 1, TOTAL_COLS, 'ТАБЛИЦА 2 — консенсус по 10 биржам vs WhiteBIT (рекомендации по листингу)', { bg: TITLE_BG });
  ['Spot', 'Futures'].forEach(mt => {
    const t = layout.table2[mt];
    mergeText(t.typeRow, 1, TOTAL_COLS, mt, { bg: SUBTITLE_BG, fg: '#37324A', align: 'LEFT' });
    headerRow(t.headerRow, ['#', 'Монета', '', '', '', 'Бирж (из 10)', 'Ø ранг', 'Ранг WhiteBIT', 'Рекомендация']);
    border(t.dataStart, t.dataEnd);
  });

  requests.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } });

  // Ширины колонок: A..I
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

function buildValueUpdates(sheetName, layout, comparisonData, timestampLabel) {
  const data = [];
  data.push({ range: a1(sheetName, 1, layout.timestampRow, TOTAL_COLS, layout.timestampRow), values: [[timestampLabel, ...Array(TOTAL_COLS - 1).fill('')]] });

  ['Spot', 'Futures'].forEach(mt => {
    const t1 = layout.table1[mt];
    const rows1 = comparisonData.table1[mt];
    const values1 = [];
    for (let i = 0; i < TOP_ROWS; i++) {
      const r = rows1[i];
      values1.push(r
        ? [r.position, r.coin, r.ranks.Binance || '', r.ranks.Bybit || '', r.ranks.OKX || '', r.count, Math.round(r.avgRank * 10) / 10, r.whiteBitRank || 'нет', r.recommendation]
        : Array(TOTAL_COLS).fill(''));
    }
    data.push({ range: a1(sheetName, 1, t1.dataStart, TOTAL_COLS, t1.dataEnd), values: values1 });

    const t2 = layout.table2[mt];
    const rows2 = comparisonData.table2[mt];
    const values2 = [];
    for (let i = 0; i < TOP_ROWS; i++) {
      const r = rows2[i];
      values2.push(r
        ? [r.position, r.coin, '', '', '', r.count, Math.round(r.avgRank * 10) / 10, r.whiteBitRank || 'нет', r.recommendation]
        : Array(TOTAL_COLS).fill(''));
    }
    data.push({ range: a1(sheetName, 1, t2.dataStart, TOTAL_COLS, t2.dataEnd), values: values2 });
  });

  return data;
}

// Подсветка колонки "Рекомендация" (I) по смыслу — пересчитывается
// каждый цикл отдельным набором repeatCell-запросов, т.к. значения
// (а значит и цвет) меняются от прогона к прогону.
function buildRecommendationColorRequests(sheetId, layout, comparisonData) {
  const requests = [];
  const recColIndex = 8; // колонка I, 0-based

  function paint(tableKey) {
    ['Spot', 'Futures'].forEach(mt => {
      const t = layout[tableKey][mt];
      const rows = comparisonData[tableKey][mt];
      for (let i = 0; i < TOP_ROWS; i++) {
        const r = rows[i];
        const rowIdx = t.dataStart + i;
        requests.push({
          repeatCell: {
            range: { sheetId, startRowIndex: rowIdx - 1, endRowIndex: rowIdx, startColumnIndex: recColIndex, endColumnIndex: recColIndex + 1 },
            cell: { userEnteredFormat: { backgroundColor: r ? rgb(recColor(r.recommendation)) : undefined } },
            fields: 'userEnteredFormat.backgroundColor',
          },
        });
      }
    });
  }

  paint('table1');
  paint('table2');
  return requests;
}

module.exports = { buildLayout, buildStaticRequests, buildValueUpdates, buildRecommendationColorRequests };
