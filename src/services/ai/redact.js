// Gemini's free tier terms say not to submit personal information, and that human reviewers may
// read conversations. So contact details and long numbers never leave the server.

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
// Ten or more digits, allowing separators: phone, card and national ID numbers.
// Digits attached to letters belong to an order number or model name, so they stay.
const LONG_NUMBER = /(?<![\p{L}\p{N}-])\+?(?:[\d০-৯][\s().-]*){10,}(?!\p{L})/gu;
const REMOVED = '[removed]';

export const redactPersonalInfo = (text) => text.replace(EMAIL, REMOVED).replace(LONG_NUMBER, `${REMOVED} `).trim();
