/**
 * Tests for the MongoDB auth state handler — the core of session persistence.
 * If any of these fail, a deploy could silently corrupt or lose the WhatsApp
 * session and force a re-pair. Uses Node's built-in test runner (node --test).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { useMongoDBAuthState } = require('../index.js');

/** In-memory stand-in for a MongoDB collection (same subset of the API). */
function createMockCollection() {
  const store = new Map();
  return {
    store,
    async replaceOne(filter, doc, opts) {
      if (!opts || opts.upsert !== true) {
        throw new Error('replaceOne must be called with { upsert: true }');
      }
      store.set(filter._id, doc);
    },
    async findOne(filter) {
      return store.get(filter._id) || null;
    },
    async deleteOne(filter) {
      store.delete(filter._id);
    },
  };
}

describe('useMongoDBAuthState', () => {
  test('initializes fresh creds when the collection is empty', async () => {
    const collection = createMockCollection();
    const { state } = await useMongoDBAuthState(collection);

    assert.ok(state.creds, 'creds should exist');
    assert.ok(state.creds.noiseKey, 'creds should include a noiseKey');
    assert.ok(Buffer.isBuffer(state.creds.noiseKey.private), 'key material should be Buffers');
    assert.equal(state.creds.registered, false, 'fresh creds should be unregistered');
  });

  test('saveCreds persists creds and they round-trip with Buffers intact', async () => {
    const collection = createMockCollection();
    const { state, saveCreds } = await useMongoDBAuthState(collection);

    await saveCreds();
    assert.ok(collection.store.has('creds'), 'creds document should be written');

    // Simulate a restart: brand-new handler over the same collection
    const { state: reloaded } = await useMongoDBAuthState(collection);
    assert.ok(
      Buffer.isBuffer(reloaded.creds.noiseKey.private),
      'Buffers must survive JSON serialization (BufferJSON)'
    );
    assert.equal(
      Buffer.compare(state.creds.noiseKey.private, reloaded.creds.noiseKey.private),
      0,
      'reloaded creds must be byte-identical to saved creds'
    );
  });

  test('keys.set writes and keys.get reads back values', async () => {
    const collection = createMockCollection();
    const { state } = await useMongoDBAuthState(collection);

    const keyValue = { pubKey: Buffer.from([1, 2, 3]), privKey: Buffer.from([4, 5, 6]) };
    await state.keys.set({ 'pre-key': { 7: keyValue } });

    const result = await state.keys.get('pre-key', ['7', 'does-not-exist']);
    assert.equal(Buffer.compare(result['7'].pubKey, keyValue.pubKey), 0);
    assert.equal(Buffer.compare(result['7'].privKey, keyValue.privKey), 0);
    assert.equal(result['does-not-exist'], null, 'missing keys must be null, not undefined/throw');
  });

  test('keys are namespaced by type so different types do not collide', async () => {
    const collection = createMockCollection();
    const { state } = await useMongoDBAuthState(collection);

    await state.keys.set({
      'pre-key': { 1: { v: Buffer.from('pre') } },
      session: { 1: { v: Buffer.from('sess') } },
    });

    const pre = await state.keys.get('pre-key', ['1']);
    const sess = await state.keys.get('session', ['1']);
    assert.equal(pre['1'].v.toString(), 'pre');
    assert.equal(sess['1'].v.toString(), 'sess');
  });

  test('setting a key to null/falsy deletes it', async () => {
    const collection = createMockCollection();
    const { state } = await useMongoDBAuthState(collection);

    await state.keys.set({ 'pre-key': { 1: { v: Buffer.from('x') } } });
    await state.keys.set({ 'pre-key': { 1: null } });

    const result = await state.keys.get('pre-key', ['1']);
    assert.equal(result['1'], null, 'deleted key must read back as null');
    assert.ok(!collection.store.has('pre-key-1'), 'document must be removed from the collection');
  });

  test('app-state-sync-key values are converted to AppStateSyncKeyData proto', async () => {
    const collection = createMockCollection();
    const { state } = await useMongoDBAuthState(collection);

    await state.keys.set({
      'app-state-sync-key': {
        k1: {
          keyData: Buffer.from('secret'),
          fingerprint: { rawId: 1, currentIndex: 0, deviceIndexes: [0] },
          timestamp: 1234,
        },
      },
    });

    const result = await state.keys.get('app-state-sync-key', ['k1']);
    assert.equal(
      result.k1.constructor.name,
      'AppStateSyncKeyData',
      'must be converted via proto.Message.AppStateSyncKeyData.fromObject()'
    );
    assert.equal(Buffer.from(result.k1.keyData).toString(), 'secret');
  });

  test('readData returns null (does not throw) on corrupted documents', async () => {
    const collection = createMockCollection();
    // Poison the store with an unparseable value
    collection.store.set('creds', { _id: 'creds', value: '{not valid json!!' });

    // Must fall back to fresh creds instead of crashing the bot on boot
    const { state } = await useMongoDBAuthState(collection);
    assert.ok(state.creds.noiseKey, 'should fall back to initAuthCreds() on corrupt data');
  });
});
