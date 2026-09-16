# WhatsApp Bot (Baileys + Render + MongoDB)

## What this is

A WhatsApp bot built with the [Baileys](https://github.com/WhiskeySockets/Baileys) library (unofficial WhatsApp Web API), designed to run 24/7 on Render's free tier. It logs in via a **pairing code** (no QR scanning needed) and stores its entire session in **MongoDB Atlas**, so it survives Render's disk wipes and restarts without needing to re-link. As a demo, it replies `pong!` to any message that says `ping`.

## Prerequisites

- A [Render](https://render.com) account (free tier is fine)
- A [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) account with a free M0 cluster
- A WhatsApp account (phone number) for the bot

## Setup Steps

1. **Fork or clone this repo** to your own GitHub account.
2. **Create a MongoDB Atlas M0 cluster**, create a database user, and allow network access from anywhere (`0.0.0.0/0`). Copy the connection string.
3. **Create a Render Web Service** (free plan) connected to this repo:
   - **Build command:** `npm ci` (installs exact versions from the lockfile — reproducible deploys)
   - **Start command:** `node index.js`
4. **Set environment variables** in the Render dashboard:
   | Variable | Value |
   |---|---|
   | `MONGODB_URI` | Your Atlas connection string |
   | `BOT_PHONE_NUMBER` | The bot's WhatsApp number with country code, no `+` or spaces (e.g. `15551234567`) |
5. **Deploy**, then open the Render **Logs** tab and wait for:
   ```
   ====================================
   PAIRING CODE: XXXX-XXXX
   ====================================
   ```
6. On the phone with the bot's WhatsApp account: **WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number instead**, then enter the pairing code.
7. Send `ping` to the bot's number from another account — it should reply `pong!`.

## Deploying on Wispbyte (free panel host)

This bot currently runs on [Wispbyte](https://wispbyte.com)'s free tier (512 MB RAM, NodeJS runtime). Notes specific to that setup:

- **Docker image:** select `nodejs_22` in Configuration → Startup (Baileys needs Node >= 20; the default `nodejs_19` will crash).
- **npm git-deps are blocked** on Wispbyte free nodes (`EALLOWGIT`), and Baileys depends on `libsignal` fetched from GitHub — so `npm install` cannot run there. Instead, build `node_modules` on a Linux x64 machine with Node 22 and upload it:
  ```
  npm ci --omit=dev
  tar -czf deps-node22-linux.tar.gz node_modules
  ```
  Upload the archive via the Files tab, delete any existing `node_modules` folder, then use **Unarchive**. Redo this whenever dependencies change.
- **Startup command:** remove the `if [ -f /home/container/package.json ]; then npm install; fi;` snippet, and pass the env vars inline at the end (quotes required):
  ```
  MONGODB_URI="..." BOT_PHONE_NUMBER="..." /usr/local/bin/node /home/container/index.js
  ```
- **Activity rule:** log into the Wispbyte panel at least once every 2 weeks or the free server is suspended. Set a recurring reminder.

## Keep-Alive

Render's free tier spins down after ~15 minutes of inactivity. Set up a free [UptimeRobot](https://uptimerobot.com) monitor that pings your Render URL (e.g. `https://your-app.onrender.com/`) every 5 minutes to keep the bot awake.

## Development & Tests

Tests protect the two things a bad deploy could silently break: the MongoDB session-persistence layer (a regression there would force a re-pair) and the health-check endpoint (a regression there gets the service spun down). They use Node's built-in test runner — no extra dependencies:

```
npm ci
npm test
```

CI (GitHub Actions) runs the same tests on every push and PR, on Node 20 and 22 (Baileys 6.7.24+ requires Node >= 20). Don't merge to `main` with a red build.

## How auth works

Baileys normally stores session credentials in local files (`useMultiFileAuthState`), but Render's free-tier disk is ephemeral — files are wiped on every restart or deploy. This bot instead serializes all auth credentials and signal keys into a MongoDB collection (`whatsapp_bot.auth_state`), using Baileys' `BufferJSON` helpers so binary key material survives JSON serialization. On startup, the bot loads its credentials from MongoDB and reconnects to the existing session automatically — no re-pairing required. If you ever log the bot out from your phone, delete the `auth_state` collection and redeploy to get a fresh pairing code.
