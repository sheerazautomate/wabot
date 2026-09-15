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
module.exports = { useMongoDBAuthState, createHealthServer, connectToWhatsApp };
