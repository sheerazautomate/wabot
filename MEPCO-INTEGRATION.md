# Add MEPCO Bill Checking to Your WhatsApp Bot

Give your bot a new command: users send a 14-digit MEPCO reference number and get
back the bill summary — name, month, units, amount, due date, paid/unpaid status.

> **⚠️ Requirement:** `bill.pitc.com.pk` only accepts connections from **Pakistani IP
> addresses**. Your bot must run on a machine in Pakistan (your Linux PC qualifies).
> Foreign-hosted servers (Wispbyte EU, Render, etc.) will time out.
>
> **Node.js 18+** is required (the module uses built-in `fetch`). Check with `node -v`.

---

## Step 1 — Download `mepco.js` into your bot's folder

```bash
cd /path/to/your/bot
curl -o mepco.js https://raw.githubusercontent.com/sheerazautomate/wabot/arena/01a0a50a-wabot/mepco.js
```

It's a single file with **zero npm dependencies** — nothing to install.

---

## Step 2 — Test it standalone (before touching your bot)

```bash
node mepco.js 16157350713611
```

**Expected output:** bill data as JSON, followed by a WhatsApp-formatted preview:

```
⚡ *MEPCO Bill*

📋 Ref No: 16157350713611
👤 Name: KHALID SALEEM ...
🗓️ Bill Month: AUG 26
💡 Units Consumed: 192
💰 Total Payable: Rs. 3,137
⏰ Due Date: 09 SEP 26

✅ *PAID* — Rs. 3,137 on 04-Sep-26
```

| If you see... | It means... |
| --- | --- |
| Bill JSON + preview | ✅ Working — go to Step 3 |
| `Lookup failed: fetch failed` | ❌ MEPCO can't be reached — are you on a Pakistani IP? VPN off? |
| `Bill not found.` | Reference number is wrong (or bill not issued yet) |

---

## Step 3 — Wire it into your bot

### 3a. Import at the top of your bot file

```js
const { fetchMepcoBill, formatBillMessage } = require('./mepco');
```

### 3b. Add the command to your message handler

Find the place in your code where the bot reads incoming message **text** and replies
(where your existing commands live), and add:

```js
// MEPCO bill: "bill 16157350713611" or a bare 14-digit number
const billMatch = text.match(/^bill\s+(\d{14})$/i) || text.match(/^(\d{14})$/);
if (billMatch) {
  const refNo = billMatch[1];
  await reply(`🔎 Checking MEPCO bill for ${refNo}...`);
  try {
    const bill = await fetchMepcoBill(refNo);
    await reply(bill
      ? formatBillMessage(bill)
      : `❌ No bill found for ${refNo}. Double-check the 14-digit reference number.`);
  } catch (err) {
    console.error('MEPCO lookup failed:', err.message);
    await reply('⚠️ Could not fetch the bill right now. Try again in a few minutes.');
  }
}
```

### 3c. Define `reply` for your library

The snippet above uses a generic `reply(text)`. Replace it with whatever your bot
library uses:

**Baileys** (`@whiskeysockets/baileys`):

```js
const reply = (t) => sock.sendMessage(msg.key.remoteJid, { text: t });
```

**whatsapp-web.js**:

```js
const reply = (t) => message.reply(t);
```

**venom-bot**:

```js
const reply = (t) => client.sendText(message.from, t);
```

---

## Step 4 — Restart and test in WhatsApp

Restart your bot, then from another WhatsApp account send it:

```
bill 16157350713611
```

or just the bare number:

```
16157350713611
```

You should get the "🔎 Checking..." message followed by the bill summary.

---

## What's in the parsed bill object

`fetchMepcoBill(refNo)` returns `null` (not found) or an object — use the fields
directly if you want a custom message format instead of `formatBillMessage`:

| Field | Example |
| --- | --- |
| `refNo` | `"16157350713611"` |
| `consumerId` | `"1155984263"` |
| `name` | `"KHALID SALEEM S/O ..."` |
| `tariff` / `connectionType` | `"A-1a(01)"` |
| `billMonth` | `"AUG 26"` |
| `issueDate` / `dueDate` | `"28 AUG 26"` / `"09 SEP 26"` |
| `units` | `"192"` |
| `currentBill` | `"3,044"` |
| `grandTotal` | `"3,137"` |
| `payableWithinDueDate` | `"3,137"` |
| `payableAfterDueDate` | `"3,392"` |
| `amountPaid` | `"3,137"` (`null` if unpaid) |
| `paymentDate` | `"04-Sep-26"` (`null` if unpaid) |

---

## Troubleshooting

- **`fetch failed` / timeouts** — the machine isn't reaching MEPCO. Confirm you're on
  a Pakistani IP (no VPN), and try opening
  `https://bill.pitc.com.pk/mepcobill` in a browser on the same machine.
- **`Could not extract ASP.NET form tokens`** — MEPCO changed their page markup;
  the module's form-token extraction needs updating.
- **Bill returned but some fields are `null`** — MEPCO tweaked their HTML for those
  fields; the regexes in `parseMepcoBill()` (inside `mepco.js`) need a small update.
- **How it works internally** — the module replicates the browser flow: GET the form
  page (session cookies + `__VIEWSTATE`/`__EVENTVALIDATION`), POST the search form,
  follow the 302 redirect to `/mepcobill/general?refno=...`, then parse the bill HTML
  with regexes. No headless browser, no dependencies.
