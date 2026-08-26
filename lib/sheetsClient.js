'use strict';

const fs = require('fs');
const { google } = require('googleapis');

const DEFAULT_SECRET_FILE_PATH = '/etc/secrets/service-account-key.json';

function loadServiceAccountKey() {
  const filePath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || DEFAULT_SECRET_FILE_PATH;
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64) {
    return JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, 'base64').toString('utf8'));
  }

  throw new Error(
    `Не найден ключ service account. Ожидался файл по пути ${filePath} ` +
    '(Render -> Environment -> Secret Files) либо переменная окружения ' +
    'GOOGLE_SERVICE_ACCOUNT_JSON или GOOGLE_SERVICE_ACCOUNT_JSON_BASE64.'
  );
}

function createSheetsClient() {
  const key = loadServiceAccountKey();
  const auth = new google.auth.JWT(
    key.client_email,
    null,
    key.private_key,
    ['https://www.googleapis.com/auth/spreadsheets'],
  );
  return google.sheets({ version: 'v4', auth });
}

async function getOrCreateSheetId(sheets, spreadsheetId, sheetName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find(s => s.properties.title === sheetName);
  if (existing) return existing.properties.sheetId;

  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
  });
  return res.data.replies[0].addSheet.properties.sheetId;
}

async function clearSheetFormatting(sheets, spreadsheetId, sheetId) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        { unmergeCells: { range: { sheetId } } },
        { updateCells: { range: { sheetId }, fields: 'userEnteredValue,userEnteredFormat' } },
      ],
    },
  });
}

async function applyBatchUpdate(sheets, spreadsheetId, requests) {
  if (!requests.length) return;
  const CHUNK = 400;
  for (let i = 0; i < requests.length; i += CHUNK) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: requests.slice(i, i + CHUNK) },
    });
  }
}

async function applyValueUpdates(sheets, spreadsheetId, data) {
  if (!data.length) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data },
  });
}

module.exports = { createSheetsClient, getOrCreateSheetId, clearSheetFormatting, applyBatchUpdate, applyValueUpdates };
