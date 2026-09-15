/**
 * Tests for the Express health-check server and startup guards.
 * The health endpoint is what keeps Render (and UptimeRobot) happy —
 * if it breaks, the free-tier service gets marked unhealthy / spun down.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createHealthServer, connectToWhatsApp } = require('../index.js');

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

describe('health-check server', () => {
  test('GET / returns 200 "WhatsApp Bot is running!"', async () => {
    const server = createHealthServer().listen(0); // ephemeral port
    const { port } = server.address();
    try {
      const res = await get(`http://127.0.0.1:${port}/`);
      assert.equal(res.status, 200);
      assert.equal(res.body, 'WhatsApp Bot is running!');
    } finally {
      server.close();
    }
  });
});

describe('startup guards', () => {
  test('connectToWhatsApp returns early (no throw) when MONGODB_URI is missing', async () => {
    const saved = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;
    try {
      // Must log an error and return — NOT throw or hang trying to connect.
      await connectToWhatsApp();
    } finally {
      if (saved !== undefined) process.env.MONGODB_URI = saved;
    }
  });

  test('requiring index.js does not start the bot (require.main guard)', () => {
    // If this file got this far, requiring index.js at the top didn't try to
    // open sockets or connect to MongoDB. Sanity-check the exports exist.
    const exported = require('../index.js');
    assert.equal(typeof exported.useMongoDBAuthState, 'function');
    assert.equal(typeof exported.createHealthServer, 'function');
    assert.equal(typeof exported.connectToWhatsApp, 'function');
  });
});
