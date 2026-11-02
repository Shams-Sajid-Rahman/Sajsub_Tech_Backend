// A final check on every answer: a price or stock count may only appear if a tool returned it
// during this turn. The model is told the same, but this doesn't rely on it obeying.

const MONEY_KEYS = new Set(['price', 'discountPrice', 'effectivePrice', 'savings']);
const BUDGET_KEYS = new Set(['minPrice', 'maxPrice']);
const STOCK_KEYS = new Set(['stockQuantity', 'stockLeft']);

const BENGALI_DIGITS = '০১২৩৪৫৬৭৮৯';

const toLatinDigits = (text) => text.replace(/[০-৯]/g, (digit) => BENGALI_DIGITS.indexOf(digit));
const toNumber = (text) => Number(String(text).replace(/,/g, ''));

const NUMBER = '(\\d[\\d,]*(?:\\.\\d+)?)';
const CURRENCY_BEFORE = new RegExp(`(?:৳|\\$|\\b(?:tk|bdt|usd|taka)\\b\\.?)\\s*${NUMBER}`, 'gi');
const CURRENCY_AFTER = new RegExp(`${NUMBER}\\s*(?:৳|টাকা|\\b(?:tk|bdt|usd|taka|dollars?)\\b)`, 'gi');
const STOCK_PATTERNS = [
  new RegExp(`${NUMBER}\\s*(?:units?|pieces?|pcs|items?|ইউনিট|টি|পিস)(?:\\s|\\b|$)`, 'gi'),
  new RegExp(`\\bonly\\s+${NUMBER}\\b`, 'gi'),
  new RegExp(`${NUMBER}\\s+(?:left|remaining|in stock|available)\\b`, 'gi'),
];
const AVAILABILITY_CLAIM = /\b(?:in stock|out of stock|sold out)\b|স্টকে/i;

const matchNumbers = (pattern, text) => [...text.matchAll(pattern)].map((match) => toNumber(match[1]));

// Remembers what the tools returned during one turn.
export const createFactLog = () => ({ money: new Set(), stock: new Set(), names: new Set(), availabilityKnown: false });

// Numbers inside product names aren't claims: "iPhone 16 remaining" doesn't mean 16 are left.
const removeProductNames = (text, log) =>
  [...log.names].reduce((remaining, name) => remaining.replaceAll(name, ' '), text);

const recordValue = (log, key, value) => {
  if (value === null || value === undefined) return;
  if (key === 'name' && typeof value === 'string') log.names.add(toLatinDigits(value));
  if (MONEY_KEYS.has(key) || BUDGET_KEYS.has(key)) log.money.add(toNumber(value));
  if (STOCK_KEYS.has(key)) log.stock.add(toNumber(value));
  if (key === 'inStock') log.availabilityKnown = true;
};

const walk = (log, value) => {
  if (Array.isArray(value)) value.forEach((entry) => walk(log, entry));
  else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, entry]) => {
      recordValue(log, key, entry);
      walk(log, entry);
    });
  }
};

export const recordToolOutput = (log, { result, args }) => {
  walk(log, result);
  walk(log, args);
};

export const findUnverifiedClaims = (text, log) => {
  const normalized = removeProductNames(toLatinDigits(text), log);
  const claims = [];
  for (const amount of [...matchNumbers(CURRENCY_BEFORE, normalized), ...matchNumbers(CURRENCY_AFTER, normalized)]) {
    if (!log.money.has(amount)) claims.push(`price ${amount}`);
  }
  for (const pattern of STOCK_PATTERNS) {
    for (const count of matchNumbers(pattern, normalized)) {
      if (!log.stock.has(count)) claims.push(`stock ${count}`);
    }
  }
  if (AVAILABILITY_CLAIM.test(normalized) && !log.availabilityKnown) claims.push('availability');
  return claims;
};
