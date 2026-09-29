const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, luhn, cardNetwork } = require('../src/shared/autofill-fields');

const cases = [
  [{ type: 'password', name: 'password' }, 'password'],
  [{ type: 'password', name: 'confirm_password' }, 'new-password'],
  [{ type: 'text', autocomplete: 'username', name: 'x' }, 'username'],
  [{ type: 'text', name: 'login' }, 'username'],
  [{ type: 'email', name: 'x' }, 'email'],
  [{ name: 'firstName' }, 'given-name'],
  [{ name: 'last_name' }, 'family-name'],
  [{ name: 'fullname' }, 'name'],
  [{ name: 'mobile' }, 'tel'],
  [{ name: 'address1' }, 'address-line1'],
  [{ name: 'address2' }, 'address-line2'],
  [{ label: 'Landmark' }, 'address-line2'],
  [{ name: 'city' }, 'address-level2'],
  [{ name: 'state' }, 'address-level1'],
  [{ placeholder: 'PIN code' }, 'postal-code'],
  [{ name: 'pincode' }, 'postal-code'],
  [{ name: 'zip' }, 'postal-code'],
  [{ name: 'country' }, 'country'],
  [{ label: 'Company name' }, 'organization'],
  [{ label: 'GSTIN' }, 'gstin'],
  [{ label: 'Card number' }, 'cc-number'],
  [{ label: 'Name on card' }, 'cc-name'],
  [{ name: 'expMonth' }, 'cc-exp-month'],
  [{ name: 'expYear' }, 'cc-exp-year'],
  [{ placeholder: 'MM / YY' }, 'cc-exp'],
  [{ name: 'cvv' }, 'cc-csc'],
  [{ label: 'UPI ID' }, 'upi'],
  [{ label: 'Vehicle number' }, 'vehicle-registration'],
  [{ label: 'Passport number' }, 'passport'],
  [{ label: 'Driving licence number' }, 'driving-licence'],
  [{ label: 'PAN number' }, 'national-id'],
  [{ autocomplete: 'shipping address-line1', name: 'q' }, 'address-line1'],
  [{ name: 'otp' }, null],
  [{ type: 'hidden', name: 'email' }, null],
  [{ type: 'search', name: 'q' }, null],
  [{ name: 'q', placeholder: 'Search' }, null],
];

test('fields are recognised by what sites really call them', () => {
  for (const [field, expected] of cases) assert.equal(classify(field), expected, JSON.stringify(field));
});

test('card numbers are checked and named', () => {
  assert.equal(luhn('4242 4242 4242 4242'), true);
  assert.equal(luhn('4242 4242 4242 4241'), false);
  assert.equal(cardNetwork('4242424242424242'), 'Visa');
  assert.equal(cardNetwork('6521 0000 0000 0000'), 'RuPay');
});

test('a single expiry box is the whole date, not the month', () => {
  assert.equal(classify({ name: 'cc-exp', placeholder: 'MM / YY' }), 'cc-exp');
  assert.equal(classify({ name: 'expiryDate' }), 'cc-exp');
  assert.equal(classify({ name: 'exp_month' }), 'cc-exp-month');
});
