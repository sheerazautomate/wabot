'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  extractHiddenField,
  parseMepcoBill,
  formatBillMessage,
} = require('../index.js');

// ---------------------------------------------------------------------------
// Fixture approximating the MEPCO bill page markup (from HAR capture)
// ---------------------------------------------------------------------------
const BILL_HTML = `
<html><head><title>MEPCO ONLINE BILL</title></head><body>
<div class="label-row en-lbl"><span>REFERENCE NO</span></div>
<div class="val-space"> 16157350713611 </div>
<div class="label-row en-lbl"><span>CONSUMER ID</span></div>
<div class="val-space"> 1155984263 </div>
<div class="label-row en-lbl"><span>NAME &amp; ADDRESS</span></div>
<div class="val-space val-space--address"> <span>KHALID SALEEM S/O ...</span> </div>
<div class="label-row en-lbl"><span>TARIFF</span></div>
<div class="val-space"> A-1a(01) </div>
<div class="label-row en-lbl"><span>UNITS</span></div>
<div class="val-space"> 192 </div>
<div class="right-panel-label"><span>BILL MONTH</span></div>
<div class="right-main-val"> AUG 26 </div>
<div class="right-panel-label"><span>ISSUE DATE</span></div>
<div class="right-panel-date-val"> 28 AUG 26 </div>
<div class="right-panel-label"><span>DUE DATE</span></div>
<div class="right-main-val right-main-val--due"> 09 SEP 26 </div>
<div class="charges-bd-row charges-bd-row--current"><span>CURRENT BILL</span>
  <span class="charges-bd-val"> 3,044 </span></div>
<div class="charges-bd-row charges-bd-row--grand"><span>GRAND TOTAL</span>
  <span class="charges-bd-val"> 3,137 </span></div>
<div class="payable-card-amount"> 3,137 </div>
<div>After Due Date<br /> 3,392 </div>
<span>Amount Paid</span> <span class="payable-card-paid-val"> 3,137 </span>
<span>Payment Date</span> <span class="payable-card-paid-val"> 04-Sep-26 </span>
</body></html>
`;

const FORM_HTML = `
<form method="post" action="./mepcobill">
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="dDwtNTI4OTc0=" />
<input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="2CDA38AB" />
<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="/wEWAgL=" />
<input name="__RequestVerificationToken" type="hidden" value="tok123" />
</form>
`;

test('extractHiddenField reads ASP.NET hidden inputs (name before value)', () => {
  assert.strictEqual(extractHiddenField(FORM_HTML, '__VIEWSTATE'), 'dDwtNTI4OTc0=');
  assert.strictEqual(extractHiddenField(FORM_HTML, '__VIEWSTATEGENERATOR'), '2CDA38AB');
  assert.strictEqual(extractHiddenField(FORM_HTML, '__EVENTVALIDATION'), '/wEWAgL=');
});

test('extractHiddenField reads inputs with value before name', () => {
  const html = '<input value="abc" type="hidden" name="token" />';
  assert.strictEqual(extractHiddenField(html, 'token'), 'abc');
});

test('extractHiddenField returns null when the field is absent', () => {
  assert.strictEqual(extractHiddenField(FORM_HTML, '__NOPE'), null);
});

test('parseMepcoBill extracts the key bill fields', () => {
  const bill = parseMepcoBill(BILL_HTML);
  assert.ok(bill, 'expected a parsed bill');
  assert.strictEqual(bill.refNo, '16157350713611');
  assert.strictEqual(bill.consumerId, '1155984263');
  assert.strictEqual(bill.billMonth, 'AUG 26');
  assert.strictEqual(bill.dueDate, '09 SEP 26');
  assert.strictEqual(bill.units, '192');
  assert.strictEqual(bill.currentBill, '3,044');
  assert.strictEqual(bill.grandTotal, '3,137');
  assert.strictEqual(bill.payableWithinDueDate, '3,137');
  assert.strictEqual(bill.amountPaid, '3,137');
  assert.strictEqual(bill.paymentDate, '04-Sep-26');
});

test('parseMepcoBill returns null for a non-bill page', () => {
  assert.strictEqual(parseMepcoBill('<html><body>Record not found</body></html>'), null);
});

test('formatBillMessage renders a PAID bill summary', () => {
  const msg = formatBillMessage(parseMepcoBill(BILL_HTML));
  assert.match(msg, /MEPCO Bill/);
  assert.match(msg, /16157350713611/);
  assert.match(msg, /Due Date: 09 SEP 26/);
  assert.match(msg, /PAID/);
  assert.match(msg, /3,137 on 04-Sep-26/);
});

test('formatBillMessage marks unpaid bills as UNPAID', () => {
  const unpaidHtml = BILL_HTML.replace(/Amount Paid[\s\S]*?04-Sep-26 <\/span>/, '');
  const msg = formatBillMessage(parseMepcoBill(unpaidHtml));
  assert.match(msg, /UNPAID/);
  assert.doesNotMatch(msg, /✅/);
});
