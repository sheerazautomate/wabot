/**
 * WhatsApp Bot — Baileys + MongoDB auth state + Express health check
 * Designed for Render free tier (ephemeral disk) with MongoDB Atlas (free M0).
 *
 * - Pairs via PAIRING CODE (no QR — no interactive terminal in the cloud).
 * - Session/auth data is persisted in MongoDB so restarts don't require re-login.
 * - Replies "pong!" to "ping" as a proof-of-life demo.
 */

const {
  default: makeWASocket,
  DisconnectReason,
  initAuthCreds,
  BufferJSON,
  proto,
} = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const { MongoClient } = require('mongodb');

// ---------------------------------------------------------------------------
// A. Express health-check server (keeps Render happy + enables uptime pings)
// ---------------------------------------------------------------------------
function createHealthServer() {
  const app = express();

  app.get('/', (req, res) => {
    res.status(200).send('WhatsApp Bot is running!');
  });

  return app;
}

function startHealthServer() {
  const PORT = process.env.PORT || 3000;
  return createHealthServer().listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// ---------------------------------------------------------------------------
// B. MongoDB auth state handler (replaces Baileys' default file-based auth state)
// ---------------------------------------------------------------------------
async function useMongoDBAuthState(collection) {
  // Write (upsert) a document: { _id: id, value: <JSON string with Buffers preserved> }
  const writeData = async (data, id) => {
    const value = JSON.stringify(data, BufferJSON.replacer);
    await collection.replaceOne({ _id: id }, { _id: id, value }, { upsert: true });
  };

  // Read + deserialize a document, or null if missing / on error
  const readData = async (id) => {
    try {
      const data = await collection.findOne({ _id: id });
      if (!data || !data.value) return null;
      return JSON.parse(data.value, BufferJSON.reviver);
    } catch (error) {
      return null;
    }
  };

  // Delete a document, silently ignoring errors
  const removeData = async (id) => {
    try {
      await collection.deleteOne({ _id: id });
    } catch (error) {
      // ignore
    }
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeData(creds, 'creds');
    },
  };
}

// ---------------------------------------------------------------------------
// B2. MEPCO bill lookup (bill.pitc.com.pk)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// C. Main connection function
// ---------------------------------------------------------------------------
async function connectToWhatsApp() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI environment variable is not set. Cannot start bot.');
    return;
  }

  // Connect to MongoDB
  const mongoClient = new MongoClient(mongoUri);
  await mongoClient.connect();
  console.log('Connected to MongoDB');

  const db = mongoClient.db('whatsapp_bot');
  const collection = db.collection('auth_state');

  const { state, saveCreds } = await useMongoDBAuthState(collection);

  // Create the Baileys socket
  const sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false, // CRITICAL: no QR in cloud environments
    auth: state,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
  });

  // Pairing code logic (only when not yet registered)
  const phoneNumber = process.env.BOT_PHONE_NUMBER;
  if (!sock.authState.creds.registered && phoneNumber) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log('====================================');
        console.log(`PAIRING CODE: ${code}`);
        console.log('====================================');
      } catch (error) {
        console.error('Failed to request pairing code:', error);
      }
    }, 3000);
  } else if (!sock.authState.creds.registered && !phoneNumber) {
    console.error('ERROR: Not registered and BOT_PHONE_NUMBER is not set. Cannot pair.');
  }

  // Persist credentials whenever they update
  sock.ev.on('creds.update', saveCreds);

  // Connection lifecycle
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(
        `Connection closed. Reason: ${statusCode || 'unknown'}. Reconnecting: ${shouldReconnect}`
      );
      if (shouldReconnect) {
        connectToWhatsApp();
      } else {
        console.log('Logged out. Delete the auth_state collection in MongoDB and redeploy to re-pair.');
      }
    } else if (connection === 'open') {
      console.log('WhatsApp connection opened successfully!');
    }
  });

  // Incoming messages
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg || msg.key.fromMe || m.type !== 'notify') return;

    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      '';

    console.log(`Received message: ${text}`);

    if (text === 'ping') {
      await sock.sendMessage(msg.key.remoteJid, { text: 'pong!' });
      return;
    }

    // MEPCO bill lookup: "bill <14-digit ref no>" or a bare 14-digit number
    const billMatch =
      text.match(/^bill\s+(\d{14})$/i) || text.match(/^(\d{14})$/);
    if (billMatch) {
      const refNo = billMatch[1];
      const jid = msg.key.remoteJid;
      try {
        await sock.sendMessage(jid, {
          text: `🔎 Checking MEPCO bill for ${refNo}...`,
        });
        const bill = await fetchMepcoBill(refNo);
        if (bill) {
          await sock.sendMessage(jid, { text: formatBillMessage(bill) });
        } else {
          await sock.sendMessage(jid, {
            text: `❌ No bill found for reference number ${refNo}. Please double-check the 14-digit reference number on your bill.`,
          });
        }
      } catch (err) {
        console.error('MEPCO bill lookup failed:', err.message);
        await sock.sendMessage(jid, {
          text: '⚠️ Could not fetch the bill right now (MEPCO site may be down or slow). Please try again in a few minutes.',
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// D. Entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  startHealthServer();
  connectToWhatsApp();
}

// Exported for tests only — running this file directly starts the bot.
module.exports = {
  useMongoDBAuthState,
  createHealthServer,
  connectToWhatsApp,
  extractHiddenField,
  parseMepcoBill,
  formatBillMessage,
  fetchMepcoBill,
};
