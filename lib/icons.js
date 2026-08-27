'use strict';

// Источник: репозиторий с иконками под тикеры, торгующиеся на Binance —
// живой и относительно свежий (в отличие от старых заброшенных icon-паков),
// поэтому покрывает и новые токены (SUI, PEPE, WLD и т.п.), не только
// классику вроде BTC/ETH. Берём напрямую с raw.githubusercontent.com —
// CDN-зеркало (jsdelivr) отдаёт заголовки, которые IMAGE() в Google
// Sheets не всегда корректно распознаёт.
const ICON_BASE_URL = 'https://raw.githubusercontent.com/prasangapokharel/crypto-icons/v1.0.0/binance';

// Топ ~100 тикеров — только настоящая крипта, без токенизированных акций
// (это сознательное решение: акции пока без иконок).
const TOP_ICON_TICKERS = new Set([
  'BTC', 'ETH', 'USDT', 'USDC', 'BNB', 'XRP', 'SOL', 'ADA', 'DOGE', 'TRX',
  'LTC', 'BCH', 'DOT', 'LINK', 'UNI', 'AVAX', 'ATOM', 'NEAR', 'MATIC', 'ALGO',
  'XLM', 'VET', 'FIL', 'ICP', 'HBAR', 'EGLD', 'SAND', 'MANA', 'AXS', 'THETA',
  'FTM', 'XTZ', 'EOS', 'GRT', 'CHZ', 'APT', 'ARB', 'OP', 'SUI', 'SEI',
  'INJ', 'TIA', 'PEPE', 'SHIB', 'BONK', 'FLOKI', 'ORDI', 'RENDER', 'RNDR', 'IMX',
  'LDO', 'CAKE', 'DYDX', 'GALA', '1INCH', 'COMP', 'SNX', 'CRV', 'YFI', 'ZEC',
  'XMR', 'ETC', 'DASH', 'WAVES', 'KSM', 'AR', 'FLOW', 'KAVA', 'RUNE', 'GMT',
  'APE', 'SUSHI', 'ENS', 'LRC', 'CELO', 'ANKR', 'IOTA', 'ZIL', 'QTUM', 'OMG',
  'NANO', 'BAT', 'ZRX', 'STORJ', 'REN', 'UMA', 'BAND', 'FET', 'AGIX', 'RLC',
  'CTSI', 'SKL', 'COTI', 'HOT', 'GLM', 'MKR', 'AAVE', 'WLD', 'JUP', 'PYTH',
  'ONDO', 'ENA', 'TAO', 'HYPE', 'PENGU', 'TRUMP', 'PAXG', 'XAUT', 'USDE', 'ENJ',
]);

function iconFormula(baseTicker) {
  if (!baseTicker || !TOP_ICON_TICKERS.has(baseTicker.toUpperCase())) return '';
  const url = `${ICON_BASE_URL}/${baseTicker.toUpperCase()}.png`;
  // mode 4 = произвольный размер (ширина, высота) в пикселях — держим
  // иконку компактной, чтобы не раздувать высоту строки.
  return `=IMAGE("${url}",4,16,16)`;
}

module.exports = { TOP_ICON_TICKERS, iconFormula };
