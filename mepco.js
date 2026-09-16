'use strict';

/**
 * MEPCO bill lookup module — drop this file into any Node.js project.
 *
 * Zero dependencies (uses Node's built-in fetch — requires Node 18+).
 * NOTE: bill.pitc.com.pk only accepts connections from Pakistani IPs,
 * so this must run on a machine located in Pakistan.
 *
 * Usage:
 *   const { fetchMepcoBill, formatBillMessage } = require('./mepco');
 *   const bill = await fetchMepcoBill('16157350713611');
 *   if (bill) console.log(formatBillMessage(bill));
 */

const MEPCO_BASE = 'https://bill.pitc.com.pk';
const MEPCO_UA =
  'Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0';

/** Extract a named hidden-input value from an ASP.NET form page. */
function extractHiddenField(html, name) {
  const re = new RegExp(
    `name="${name}"[^>]*?value="([^"]*)"|value="([^"]*)"[^>]*?name="${name}"`,
    'i'
  );
  const m = html.match(re);
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

/** Collect Set-Cookie values into a single Cookie header string. */
function collectCookies(response) {
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
  return raw.map((c) => c.split(';')[0]).join('; ');
}

/**
 * Parse the MEPCO bill HTML page into a structured object.
 * Returns null when the page does not look like a valid bill.
 */
function parseMepcoBill(html) {
  const pick = (re) => {
    const m = html.match(re);
    return m ? m[1].replace(/\s+/g, ' ').trim() : null;
  };

  const bill = {
    refNo: pick(/REFERENCE NO<[\s\S]{0,300}?class="val-space">\s*([^<]+?)\s*</),
    consumerId: pick(/CONSUMER ID<[\s\S]{0,300}?class="val-space">\s*([^<]+?)\s*</),
    name: pick(/class="val-space val-space--address">\s*<span>([^<]+)</),
    tariff: pick(/>TARIFF<\/span>[\s\S]{0,300}?class="val-space">\s*([^<]+?)\s*</),
    connectionType: pick(/TARIFF CATEGORY<[\s\S]{0,300}?class="val-space">\s*([^<]+?)\s*</),
    billMonth: pick(/BILL MONTH<[\s\S]{0,400}?class="right-main-val">\s*([^<]+?)\s*</),
    issueDate: pick(/ISSUE DATE<[\s\S]{0,400}?class="right-panel-date-val">\s*([^<]+?)\s*</),
    dueDate: pick(/class="right-main-val right-main-val--due">\s*([^<]+?)\s*</),
    units: pick(/>UNITS<[\s\S]{0,300}?class="val-space">\s*([\d,]+)/),
    currentBill: pick(/charges-bd-row--current[\s\S]{0,600}?charges-bd-val">\s*([\d,]+)/),
    grandTotal: pick(/charges-bd-row--grand[\s\S]{0,600}?charges-bd-val">\s*([\d,]+)/),
    payableWithinDueDate: pick(/payable-card-amount">\s*([\d,]+)/),
    payableAfterDueDate: pick(/After [^<]*?<br \/>\s*([\d,]+)/),
    amountPaid: pick(/Amount Paid<\/span>\s*<span class="payable-card-paid-val">\s*([\d,]+)/),
    paymentDate: pick(/Payment Date<\/span>\s*<span class="payable-card-paid-val">\s*([^<]+?)\s*</),
  };

  // A page without a reference number and a payable amount is not a bill.
  if (!bill.refNo || !bill.payableWithinDueDate) return null;
  return bill;
}

/** Render the parsed bill as a WhatsApp-friendly text message. */
function formatBillMessage(bill) {
  const lines = [
    '⚡ *MEPCO Bill*',
    '',
    `📋 Ref No: ${bill.refNo}`,
    bill.name ? `👤 Name: ${bill.name}` : null,
    bill.tariff ? `🔌 Tariff: ${bill.tariff}${bill.connectionType ? ` (${bill.connectionType})` : ''}` : null,
    '',
    bill.billMonth ? `🗓️ Bill Month: ${bill.billMonth}` : null,
    bill.units ? `💡 Units Consumed: ${bill.units}` : null,
    bill.currentBill ? `🧾 Current Bill: Rs. ${bill.currentBill}` : null,
    bill.grandTotal ? `💰 Total Payable: Rs. ${bill.grandTotal}` : null,
    bill.dueDate ? `⏰ Due Date: ${bill.dueDate}` : null,
    bill.payableAfterDueDate ? `⚠️ After Due Date: Rs. ${bill.payableAfterDueDate}` : null,
  ];

  if (bill.amountPaid) {
    lines.push('');
    lines.push(`✅ *PAID* — Rs. ${bill.amountPaid}${bill.paymentDate ? ` on ${bill.paymentDate}` : ''}`);
  } else {
    lines.push('');
    lines.push('❌ *UNPAID*');
  }

  return lines.filter((l) => l !== null).join('\n');
}

/**
 * Fetch a MEPCO bill by reference number, replicating the browser flow:
 * 1. GET the form page (session cookies + ASP.NET hidden fields)
 * 2. POST the search form
 * 3. Follow the redirect to /mepcobill/general?refno=...
 * Returns a parsed bill object, or null if no bill was found.
 */
async function fetchMepcoBill(refNo) {
  const timeout = AbortSignal.timeout(30000);

  // Step 1: load the form page
  const formRes = await fetch(`${MEPCO_BASE}/mepcobill`, {
    headers: { 'User-Agent': MEPCO_UA, Accept: 'text/html' },
    signal: timeout,
  });
  if (!formRes.ok) throw new Error(`Form page returned HTTP ${formRes.status}`);
  const cookies = collectCookies(formRes);
  const formHtml = await formRes.text();

  const viewState = extractHiddenField(formHtml, '__VIEWSTATE');
  const viewStateGen = extractHiddenField(formHtml, '__VIEWSTATEGENERATOR');
  const eventValidation = extractHiddenField(formHtml, '__EVENTVALIDATION');
  const requestToken = extractHiddenField(formHtml, '__RequestVerificationToken');
  if (!viewState || !eventValidation) {
    throw new Error('Could not extract ASP.NET form tokens');
  }

  // Step 2: submit the search form
  const body = new URLSearchParams({
    __EVENTTARGET: '',
    __EVENTARGUMENT: '',
    __LASTFOCUS: '',
    __VIEWSTATE: viewState,
    __VIEWSTATEGENERATOR: viewStateGen || '',
    __EVENTVALIDATION: eventValidation,
    rbSearchByList: 'refno',
    searchTextBox: refNo,
    ruCodeTextBox: '',
    __RequestVerificationToken: requestToken || '',
    btnSearch: 'Search',
  });

  const postRes = await fetch(`${MEPCO_BASE}/mepcobill`, {
    method: 'POST',
    headers: {
      'User-Agent': MEPCO_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: MEPCO_BASE,
      Referer: `${MEPCO_BASE}/mepcobill`,
      Cookie: cookies,
    },
    body: body.toString(),
    redirect: 'manual',
    signal: timeout,
  });

  // Step 3: follow the redirect to the bill page
  let billHtml;
  if (postRes.status >= 300 && postRes.status < 400) {
    const location = postRes.headers.get('location');
    if (!location) throw new Error('Redirect without Location header');
    const billRes = await fetch(new URL(location, MEPCO_BASE).href, {
      headers: {
        'User-Agent': MEPCO_UA,
        Accept: 'text/html',
        Referer: `${MEPCO_BASE}/mepcobill`,
        Cookie: cookies,
      },
      signal: timeout,
    });
    if (!billRes.ok) throw new Error(`Bill page returned HTTP ${billRes.status}`);
    billHtml = await billRes.text();
  } else if (postRes.ok) {
    // Some responses render the result inline instead of redirecting
    billHtml = await postRes.text();
  } else {
    throw new Error(`Search POST returned HTTP ${postRes.status}`);
  }

  return parseMepcoBill(billHtml);
}

module.exports = {
  fetchMepcoBill,
  parseMepcoBill,
  formatBillMessage,
  extractHiddenField,
};

// Quick CLI test: `node mepco.js 16157350713611`
if (require.main === module) {
  const refNo = process.argv[2];
  if (!refNo || !/^\d{14}$/.test(refNo)) {
    console.error('Usage: node mepco.js <14-digit reference number>');
    process.exit(1);
  }
  fetchMepcoBill(refNo)
    .then((bill) => {
      if (!bill) {
        console.log('Bill not found.');
      } else {
        console.log(JSON.stringify(bill, null, 2));
        console.log('\n--- WhatsApp message preview ---\n');
        console.log(formatBillMessage(bill));
      }
    })
    .catch((err) => {
      console.error('Lookup failed:', err.message);
      process.exit(1);
    });
}
