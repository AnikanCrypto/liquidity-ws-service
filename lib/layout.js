'use strict';

// ==================== НАСТРОЙКИ ====================

const TOP_N = 20;
const COLS_PER_EXCHANGE = 3; // Ранг | Символ | Объём
const GAP_COLS = 1;
const HEADER_START_ROW = 3; // 1-indexed; row 1 = метка времени, row 2 = пустая

const QUOTE_ASSET = 'USDT';

const EXCHANGES = [
  { name: 'WhiteBIT', types: ['Spot', 'Futures', 'TradeFi'], colors: ['#00A896', '#DCFCF6'] },
  { name: 'Binance', types: ['Spot', 'Futures'], colors: ['#946200', '#FFF6D9'] },
  { name: 'Bybit', types: ['Spot', 'Futures'], colors: ['#B35900', '#FFEEDD'] },
  { name: 'OKX', types: ['Spot', 'Futures'], colors: ['#0B5CFF', '#E8F0FE'] },
  { name: 'Bitget', types: ['Spot', 'Futures'], colors: ['#C2185B', '#FBE0EB'] },
  { name: 'KuCoin', types: ['Spot', 'Futures'], colors: ['#2E7D32', '#E3F2E4'] },
  { name: 'MEXC', types: ['Spot', 'Futures'], colors: ['#3949AB', '#E5E8F7'] },
  { name: 'Gate.io', types: ['Spot', 'Futures'], colors: ['#C62828', '#FBE2E2'] },
  { name: 'Kraken', types: ['Spot', 'Futures'], colors: ['#5E35B1', '#EBE5F8'] },
  { name: 'HTX', types: ['Spot', 'Futures'], colors: ['#283593', '#E3E5F5'] },
  { name: 'Bitfinex', types: ['Spot', 'Futures'], colors: ['#33691E', '#E5EEDC'] },
];

const RANK_COLORS = { 1: '#FFF3CD', 2: '#EDEFF1', 3: '#FBE3C7' };
const MINI_HEADER_BG = '#F1F3F4';

// ==================== ВЫЧИСЛЕНИЕ СЕТКИ (один раз, координаты фиксированы) ====================

function buildLayout() {
  const totalCols = EXCHANGES.length * COLS_PER_EXCHANGE + (EXCHANGES.length - 1) * GAP_COLS;
  const exchanges = [];

  EXCHANGES.forEach((ex, i) => {
    const colStart = 1 + i * (COLS_PER_EXCHANGE + GAP_COLS); // 1-indexed
    let row = HEADER_START_ROW + 1; // сразу после заголовка биржи
    const types = [];

    ex.types.forEach(typeName => {
      const typeLabelRow = row; row++;
      const miniHeaderRow = row; row++;
      const dataStartRow = row; row += TOP_N;
      const dataEndRow = row - 1;
      row++; // строка-разделитель между типами

      types.push({ type: typeName, typeLabelRow, miniHeaderRow, dataStartRow, dataEndRow });
    });

    exchanges.push({
      name: ex.name,
      colStart,
      headerRow: HEADER_START_ROW,
      headerColor: ex.colors[0],
      tintColor: ex.colors[1],
      types,
      blockEndRow: row - 2, // без финальной пустой строки
    });
  });

  return { totalCols, exchanges };
}

// ==================== A1-НОТАЦИЯ ====================

function colLetter(colIndex1based) {
  let n = colIndex1based;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function a1(sheetName, colStart, rowStart, colEnd, rowEnd) {
  const c1 = colLetter(colStart);
  const c2 = colLetter(colEnd);
  return `'${sheetName}'!${c1}${rowStart}:${c2}${rowEnd}`;
}

// ==================== СТАТИЧЕСКОЕ ОФОРМЛЕНИЕ (строится один раз при старте) ====================

function buildStaticRequests(sheetId, layout) {
  const requests = [];

  // Расширяем физическую сетку листа под нужную ширину ПЕРВЫМ делом —
  // на случай, если лист остался шире/уже от прошлых версий.
  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { columnCount: layout.totalCols + 5 } },
      fields: 'gridProperties.columnCount',
    },
  });

  const rgb = hex => {
    const h = hex.replace('#', '');
    return {
      red: parseInt(h.substring(0, 2), 16) / 255,
      green: parseInt(h.substring(2, 4), 16) / 255,
      blue: parseInt(h.substring(4, 6), 16) / 255,
    };
  };

  function mergeAndFormat(rowStart, colStart, numCols, { bg, fg, bold, fontSize, align, value }) {
    const range = {
      sheetId,
      startRowIndex: rowStart - 1,
      endRowIndex: rowStart,
      startColumnIndex: colStart - 1,
      endColumnIndex: colStart - 1 + numCols,
    };
    if (numCols > 1) {
      requests.push({ mergeCells: { range, mergeType: 'MERGE_ALL' } });
    }
    if (value !== undefined) {
      requests.push({
        updateCells: {
          range,
          rows: [{
            values: [{
              userEnteredValue: { stringValue: value },
              userEnteredFormat: {
                backgroundColor: bg ? rgb(bg) : undefined,
                horizontalAlignment: align || 'CENTER',
                textFormat: { foregroundColor: fg ? rgb(fg) : undefined, bold: !!bold, fontSize: fontSize || 10 },
              },
            }],
          }],
          fields: 'userEnteredValue,userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)',
        },
      });
    } else {
      requests.push({
        repeatCell: {
          range,
          cell: {
            userEnteredFormat: {
              backgroundColor: bg ? rgb(bg) : undefined,
              horizontalAlignment: align || 'CENTER',
              textFormat: { foregroundColor: fg ? rgb(fg) : undefined, bold: !!bold, fontSize: fontSize || 10 },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)',
        },
      });
    }
  }

  function formatRange(rowStart, rowEnd, colStart, colEnd, format, fields = 'userEnteredFormat') {
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: rowStart - 1,
          endRowIndex: rowEnd,
          startColumnIndex: colStart - 1,
          endColumnIndex: colEnd,
        },
        cell: { userEnteredFormat: format },
        fields,
      },
    });
  }

  // Метка времени сверху, во всю ширину
  mergeAndFormat(1, 1, layout.totalCols, { bg: '#1F1B2E', fg: '#FFFFFF', bold: true });

  layout.exchanges.forEach(ex => {
    mergeAndFormat(ex.headerRow, ex.colStart, COLS_PER_EXCHANGE, {
      bg: ex.headerColor, fg: '#FFFFFF', bold: true, fontSize: 12, value: ex.name.toUpperCase(),
    });

    ex.types.forEach(t => {
      mergeAndFormat(t.typeLabelRow, ex.colStart, COLS_PER_EXCHANGE, {
        bg: ex.tintColor, fg: ex.headerColor, bold: true, align: 'LEFT',
      });

      requests.push({
        updateCells: {
          range: {
            sheetId,
            startRowIndex: t.miniHeaderRow - 1,
            endRowIndex: t.miniHeaderRow,
            startColumnIndex: ex.colStart - 1,
            endColumnIndex: ex.colStart - 1 + COLS_PER_EXCHANGE,
          },
          rows: [{
            values: ['Ранг', 'Символ', `Объём (${QUOTE_ASSET})`].map(v => ({
              userEnteredValue: { stringValue: v },
              userEnteredFormat: {
                backgroundColor: rgb(MINI_HEADER_BG),
                horizontalAlignment: 'CENTER',
                textFormat: { bold: true },
              },
            })),
          }],
          fields: 'userEnteredValue,userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)',
        },
      });

      formatRange(t.dataStartRow, t.dataEndRow, ex.colStart, ex.colStart, { horizontalAlignment: 'CENTER' });
      formatRange(t.dataStartRow, t.dataEndRow, ex.colStart + 2, ex.colStart + 2, {
        horizontalAlignment: 'RIGHT',
        numberFormat: { type: 'NUMBER', pattern: '[>=1000000000]0.00,,,"B";[>=1000000]0.00,,"M";#,##0' },
      });
      requests.push({
        updateBorders: {
          range: {
            sheetId,
            startRowIndex: t.dataStartRow - 1,
            endRowIndex: t.dataEndRow,
            startColumnIndex: ex.colStart - 1,
            endColumnIndex: ex.colStart - 1 + COLS_PER_EXCHANGE,
          },
          top: { style: 'SOLID', color: rgb('#D0D3D6') },
          bottom: { style: 'SOLID', color: rgb('#D0D3D6') },
          left: { style: 'SOLID', color: rgb('#D0D3D6') },
          right: { style: 'SOLID', color: rgb('#D0D3D6') },
          innerHorizontal: { style: 'SOLID', color: rgb('#D0D3D6') },
          innerVertical: { style: 'SOLID', color: rgb('#D0D3D6') },
        },
      });

      [1, 2, 3].forEach(r => {
        const rowIdx = t.dataStartRow + r - 1;
        if (rowIdx <= t.dataEndRow) {
          formatRange(rowIdx, rowIdx, ex.colStart, ex.colStart + COLS_PER_EXCHANGE - 1, { backgroundColor: rgb(RANK_COLORS[r]) }, 'userEnteredFormat.backgroundColor');
        }
      });
    });

    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: ex.colStart - 1, endIndex: ex.colStart },
        properties: { pixelSize: 55 },
        fields: 'pixelSize',
      },
    });
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: ex.colStart, endIndex: ex.colStart + 1 },
        properties: { pixelSize: 150 },
        fields: 'pixelSize',
      },
    });
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: ex.colStart + 1, endIndex: ex.colStart + 2 },
        properties: { pixelSize: 130 },
        fields: 'pixelSize',
      },
    });

    requests.push({
      addDimensionGroup: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: ex.colStart - 1, endIndex: ex.colStart - 1 + COLS_PER_EXCHANGE },
      },
    });
  });

  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount',
    },
  });

  return requests;
}

// ==================== ОБНОВЛЕНИЕ ЗНАЧЕНИЙ (каждый тик) ====================
// state: { [exchangeName]: { [typeName]: [{symbol, volume}, ...] } }

function buildValueUpdates(sheetName, layout, state, timestampLabel) {
  const data = [];

  data.push({ range: a1(sheetName, 1, 1, layout.totalCols, 1), values: [[timestampLabel]] });

  layout.exchanges.forEach(ex => {
    ex.types.forEach(t => {
      const items = (state[ex.name] && state[ex.name][t.type]) || null;
      const isError = items && items.__error;
      const isStale = items && items.__staleError;
      const count = items && !isError ? items.length : 0;
      let label;
      if (isError) {
        label = `${t.type} — ошибка: ${items.__error}`;
      } else if (isStale) {
        label = `${t.type} — топ ${count} (обновление не удалось, показаны последние данные)`;
      } else {
        label = `${t.type} — топ ${count} по объёму`;
      }
      data.push({ range: a1(sheetName, ex.colStart, t.typeLabelRow, ex.colStart + COLS_PER_EXCHANGE - 1, t.typeLabelRow), values: [[label, '', '']] });

      const rows = [];
      for (let r = 0; r < TOP_N; r++) {
        const item = items && !isError ? items[r] : null;
        rows.push(item ? [r + 1, item.symbol, item.volume] : ['', '', '']);
      }
      data.push({ range: a1(sheetName, ex.colStart, t.dataStartRow, ex.colStart + COLS_PER_EXCHANGE - 1, t.dataEndRow), values: rows });
    });
  });

  return data;
}

module.exports = { TOP_N, QUOTE_ASSET, EXCHANGES, buildLayout, buildStaticRequests, buildValueUpdates, a1, colLetter };
