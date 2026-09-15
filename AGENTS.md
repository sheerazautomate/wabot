# AGENTS.md — Full Project Instructions

## 1. PROJECT OVERVIEW

Build a WhatsApp bot using the **Baileys** library (unofficial WhatsApp Web API) deployed on **Render's free tier** with session persistence via **MongoDB Atlas (free M0 tier)**.

The bot must:
- Connect to WhatsApp using a **pairing code** (NOT QR code, because there is no terminal to scan).
- Store all authentication/session data in **MongoDB** so the session survives Render's ephemeral disk wipes and cold restarts.
- Run a minimal **Express** HTTP server to satisfy Render's health checks and prevent sleep (paired with an external uptime pinger).
- Auto-reconnect on disconnect (unless explicitly logged out).
- Reply "pong" when it receives the message "ping" (as a basic proof-of-life demo).

---

## 2. TECH STACK & DEPENDENCIES

**Runtime:** Node.js 18+ (Render default)

**npm packages to install:**
```
@whiskeysockets/baileys
express
pino
mongodb
```

**package.json scripts:**
```json
{
  "scripts": {
    "start": "node index.js"
  }
}
```

---

## 3. REQUIRED FILE STRUCTURE

Create exactly these files in the repository root:

```
/
├── AGENTS.md          (this file — keep it)
├── package.json
├── index.js           (main entry point — all logic in one file for simplicity)
├── .gitignore
└── README.md          (brief setup guide for the human operator)
```

---

## 4. FILE-BY-FILE SPECIFICATIONS

### 4.1 `.gitignore`

```
node_modules/
.env
auth_info_baileys/
```

### 4.2 `package.json`

- Name: `baileys-render-bot`
- Version: `1.0.0`
- Main: `index.js`
- Start script: `node index.js`
- Dependencies: `@whiskeysockets/baileys`, `express`, `pino`, `mongodb`

### 4.3 `index.js` — COMPLETE SPECIFICATION

This is the only source file. It must contain ALL of the following in a single file:

#### A. Express Health-Check Server
- Create an Express app.
- Listen on `process.env.PORT || 3000`.
- `GET /` returns `"WhatsApp Bot is running!"` with status 200.
- Log `"Server running on port <PORT>"` on startup.

#### B. MongoDB Auth State Handler (`useMongoDBAuthState`)
Implement a custom auth state handler that replaces Baileys' default `useMultiFileAuthState`. This function:

1. Accepts a MongoDB `Collection` object as its argument.
2. Implements three internal helpers:
   - `writeData(data, id)`: Uses `collection.replaceOne` with `{ upsert: true }`. Serializes data using `JSON.stringify(data, BufferJSON.replacer)`. The document shape is `{ _id: id, value: <serialized string> }`.
   - `readData(id)`: Uses `collection.findOne({ _id: id })`. Deserializes using `JSON.parse(data.value, BufferJSON.reviver)`. Returns `null` if not found or on error.
   - `removeData(id)`: Uses `collection.deleteOne({ _id: id })`. Silently catches errors.
3. Reads `creds` from the DB via `readData('creds')`. Falls back to `initAuthCreds()` if nothing exists.
4. Returns `{ state, saveCreds }` where:
   - `state.creds` is the loaded/initialized creds object.
   - `state.keys.get(type, ids)` reads each key as `${type}-${id}` from the DB. For `app-state-sync-key` type, convert the result using `proto.Message.AppStateSyncKeyData.fromObject(value)`.
   - `state.keys.set(data)` iterates all categories and IDs, calling `writeData` or `removeData` as appropriate. Uses `Promise.all` for parallelism.
   - `saveCreds` is a function that calls `writeData(creds, 'creds')`.

**Required Baileys imports for this:**
```javascript
const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
```

#### C. Main Connection Function (`connectToWhatsApp`)
An `async` function that:

1. Reads `process.env.MONGODB_URI`. If missing, log an error and return.
2. Connects to MongoDB using `MongoClient`. Gets database `"whatsapp_bot"` and collection `"auth_state"`.
3. Calls `useMongoDBAuthState(collection)` to get `{ state, saveCreds }`.
4. Creates the Baileys socket via `makeWASocket()` with:
   - `logger: pino({ level: 'silent' })`
   - `printQRInTerminal: false` (CRITICAL — no QR in cloud)
   - `auth: state`
   - `browser: ['Ubuntu', 'Chrome', '20.0.04']`
5. **Pairing Code Logic:**
   - Read `process.env.BOT_PHONE_NUMBER`.
   - If `!sock.authState.creds.registered && phoneNumber`:
     - Use `setTimeout` (3 seconds delay) then call `sock.requestPairingCode(phoneNumber)`.
     - Log the code prominently:
       ```
       ====================================
       PAIRING CODE: XXXX-XXXX
       ====================================
       ```
     - Wrap in try/catch and log errors.
6. **Event: `creds.update`** → call `saveCreds()`.
7. **Event: `connection.update`**:
   - On `connection === 'close'`: Check if `lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut`. If reconnectable, recursively call `connectToWhatsApp()`. Log the reason.
   - On `connection === 'open'`: Log success.
8. **Event: `messages.upsert`**:
   - Extract `m.messages[0]`.
   - Ignore messages from self (`msg.key.fromMe`) and non-notify types.
   - If the message text is exactly `"ping"`, reply with `"pong"` using `sock.sendMessage(msg.key.remoteJid, { text: 'pong!' })`.
   - Log received message text to console.

#### D. Entry Point
- Call `connectToWhatsApp()` at the bottom of the file.

---

## 5. ENVIRONMENT VARIABLES (for Render)

The human operator will set these in Render's dashboard. The code must read them via `process.env`:

| Variable | Description | Example |
|---|---|---|
| `MONGODB_URI` | MongoDB Atlas connection string | `mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority` |
| `BOT_PHONE_NUMBER` | WhatsApp number with country code, no `+` or spaces | `15551234567` |
| `PORT` | Set automatically by Render | `10000` |

---

## 6. README.md CONTENT

Write a brief README with these sections:
1. **What this is** (one paragraph)
2. **Prerequisites** (Render account, MongoDB Atlas free account)
3. **Setup Steps**:
   - Fork/clone this repo
   - Create a Render Web Service (free) connected to this repo
   - Build command: `npm install`, Start command: `node index.js`
   - Set environment variables `MONGODB_URI` and `BOT_PHONE_NUMBER`
   - After deploy, check Render Logs for the pairing code
   - Open WhatsApp → Linked Devices → Link with phone number → enter code
4. **Keep-Alive**: Recommend UptimeRobot (free, every 5 min) pinging the Render URL
5. **How auth works**: Explain that sessions are stored in MongoDB so restarts don't require re-login

---

## 7. CRITICAL CONSTRAINTS & RULES

- **DO NOT** use `useMultiFileAuthState` — it writes to disk which is ephemeral on Render free tier.
- **DO NOT** set `printQRInTerminal: true` — there is no interactive terminal on Render.
- **DO NOT** use any `.env` file loading library (like `dotenv`). Render injects env vars natively.
- **DO NOT** split into multiple source files. Keep everything in `index.js` for simplicity.
- **DO NOT** add any TypeScript, build steps, or bundlers. Plain CommonJS Node.js only.
- **DO** handle the `app-state-sync-key` type specially with `proto.Message.AppStateSyncKeyData.fromObject()` in the keys getter.
- **DO** use `BufferJSON.replacer` and `BufferJSON.reviver` for serialization — Baileys auth data contains Buffers that don't survive plain `JSON.stringify`.
- **DO** use `upsert: true` in MongoDB writes to handle both inserts and updates.

---

## 8. TESTING CHECKLIST (for the AI to self-verify)

Before considering the task complete, verify:
- [ ] `package.json` has all 4 dependencies and a `start` script
- [ ] `.gitignore` excludes `node_modules`, `.env`, and `auth_info_baileys`
- [ ] `index.js` imports `MongoClient` from `mongodb`
- [ ] `index.js` does NOT import or use `useMultiFileAuthState`
- [ ] `index.js` sets `printQRInTerminal: false`
- [ ] `index.js` uses `requestPairingCode()` not QR
- [ ] `index.js` Express server listens on `process.env.PORT`
- [ ] `index.js` handles `DisconnectReason.loggedOut` to avoid infinite reconnect loops
- [ ] `README.md` exists with setup instructions
