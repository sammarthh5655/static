(function () {
/**
 * What kind of thing a form field wants.
 *
 * The page's own `autocomplete` attribute wins when it is present and means
 * something; otherwise the field's type, name, id, placeholder and label are
 * read for the words sites actually use. Order matters: "card number" must
 * be recognised as a card before "number" is taken for a phone.
 *
 * The types are the HTML autocomplete tokens where one exists, plus a few
 * Static adds for things common in India and elsewhere (UPI, GSTIN, vehicle
 * registration, national ID).
 */

const KINDS = {
  login: ['username', 'password', 'new-password'],
  address: ['name', 'given-name', 'family-name', 'email', 'tel', 'organization', 'gstin',
    'address-line1', 'address-line2', 'address-level2', 'address-level1', 'postal-code', 'country'],
  card: ['cc-name', 'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc'],
  upi: ['upi'],
  document: ['passport', 'driving-licence', 'vehicle-registration', 'national-id'],
};

const AUTOCOMPLETE = new Set([...Object.values(KINDS).flat(), 'current-password', 'street-address', 'cc-given-name', 'cc-family-name']);

const RULES = [
  // Cards first: "card number" and "name on card" would otherwise be taken.
  [/\b(cvv|cvc|csc|card[\s_-]?verification|security[\s_-]?code)\b/, 'cc-csc'],
  [/(card|cc).{0,12}(number|no\b|num)|cardnumber|\bcc-?num|card[\s_-]?no\b/, 'cc-number'],
  [/(card|cc).{0,12}(holder|name)|name[\s_-]?on[\s_-]?card|cc-?name/, 'cc-name'],
  // One box for the whole date ("MM / YY") before the month-only rule, which
  // would otherwise claim it for its "mm".
  [/\bmm\s*\/\s*yy|expir(y|ation)[\s_-]?date|exp[\s_-]?date|valid[\s_-]?(thru|till|until)|\bcc-?exp\b(?![\s_-]*(month|year|mm\b|yy\b))/, 'cc-exp'],
  [/exp.{0,12}(month|\bmm\b)/, 'cc-exp-month'],
  [/exp.{0,12}(year|\byy(yy)?\b)/, 'cc-exp-year'],
  [/expir/, 'cc-exp'],
  [/\b(upi|vpa)\b|upi[\s_-]?id/, 'upi'],
  [/\bgst(in)?\b|gst[\s_-]?(no|number)/, 'gstin'],
  [/passport/, 'passport'],
  [/(driv(ing|er'?s?)[\s_-]?)?licen[cs]e[\s_-]?(no|number)?|\bdl[\s_-]?no/, 'driving-licence'],
  [/vehicle|number[\s_-]?plate|licen[cs]e[\s_-]?plate|registration[\s_-]?(no|number)|\breg[\s_-]?no\b/, 'vehicle-registration'],
  [/aadhaa?r|\bpan[\s_-]?(no|number|card)?\b|national[\s_-]?id|\bssn\b|social[\s_-]?security/, 'national-id'],
  [/e-?mail/, 'email'],
  [/(first|given|fore)[\s_-]?name|\bfname\b/, 'given-name'],
  [/(last|family|sur)[\s_-]?name|\blname\b|surname/, 'family-name'],
  [/phone|mobile|\btel\b|telephone|\bcell\b|whatsapp/, 'tel'],
  [/company|organi[sz]ation|business[\s_-]?name|\bfirm\b/, 'organization'],
  [/(addr(ess)?|street).{0,6}(2|two|line[\s_-]?2)|apartment|\bapt\b|suite|\bflat\b|landmark|locality|area/, 'address-line2'],
  [/addr(ess)?|street|line[\s_-]?1|house[\s_-]?(no|number)|building/, 'address-line1'],
  [/\bcity\b|\btown\b|district|village/, 'address-level2'],
  [/\bstate\b|province|\bregion\b|county/, 'address-level1'],
  [/\bzip\b|postal|post[\s_-]?code|pin[\s_-]?code|pincode|\bpin\b(?![\s_-]*(number|no))/, 'postal-code'],
  [/country/, 'country'],
  [/user[\s_-]?(name|id)?|login|account[\s_-]?(name|id)?|\buid\b/, 'username'],
  [/full[\s_-]?name|your[\s_-]?name|^name$|\bname\b/, 'name'],
];

/**
 * @param {{type?: string, name?: string, id?: string, autocomplete?: string,
 *          placeholder?: string, label?: string, ariaLabel?: string}} field
 * @returns {string|null} the field type, or null for fields we leave alone
 */
function classify(field = {}) {
  const type = String(field.type || 'text').toLowerCase();
  if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset', 'range', 'color', 'search'].includes(type)) return null;

  const tokens = String(field.autocomplete || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.includes('off') && tokens.length === 1 && type !== 'password') {
    // Sites set autocomplete=off on fields they would rather we did not fill,
    // but browsers ignore it for logins because people need their passwords.
  } else {
    const token = tokens.find((t) => AUTOCOMPLETE.has(t));
    if (token === 'current-password') return 'password';
    if (token === 'street-address') return 'address-line1';
    if (token === 'cc-given-name' || token === 'cc-family-name') return 'cc-name';
    if (token) return token;
  }

  const text = [field.name, field.id, field.placeholder, field.label, field.ariaLabel]
    .filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

  if (type === 'password') {
    return /new|confirm|repeat|create|choose|register|sign[\s_-]?up|again|retype|verify/.test(text) ? 'new-password' : 'password';
  }
  if (type === 'email') return 'email';
  if (type === 'tel' && !/card|pin|otp|code/.test(text)) return 'tel';
  // One-time codes are never filled.
  if (/\botp\b|one[\s_-]?time|verification[\s_-]?code|captcha|coupon|promo|search/.test(text)) return null;

  for (const [pattern, result] of RULES) if (pattern.test(text)) return result;
  return null;
}

/** Which group a field type belongs to. */
function kindOf(fieldType) {
  for (const [kind, list] of Object.entries(KINDS)) if (list.includes(fieldType)) return kind;
  return null;
}

/** Card network from the leading digits, for labels only. */
function cardNetwork(number) {
  const digits = String(number || '').replace(/\D/g, '');
  if (/^4/.test(digits)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(digits)) return 'Mastercard';
  if (/^3[47]/.test(digits)) return 'American Express';
  if (/^(60|65|81|82|508)/.test(digits)) return 'RuPay';
  if (/^6(011|5)/.test(digits)) return 'Discover';
  if (/^35/.test(digits)) return 'JCB';
  return 'Card';
}

/** Luhn check: a typo'd card number is not worth offering to save. */
function luhn(number) {
  const digits = String(number || '').replace(/\D/g, '');
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

const shared = { KINDS, classify, kindOf, cardNetwork, luhn };
if (typeof module !== 'undefined' && module.exports) module.exports = shared;
if (typeof window !== 'undefined') window.autofillFields = shared;
})();
