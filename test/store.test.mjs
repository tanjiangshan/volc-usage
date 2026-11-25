import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../lib/store.mjs';

function row(overrides = {}) {
  return {
    date: '2026-11-24',
    model: 'kimi-k3.1-pro',
    reqTokens: 1000,
    rspTokens: 100,
    cachedTokens: 800,
    totalTokens: 1100,
    requestCount: 5,
    credit: 4.5,
    creditKnown: true,
    ...overrides,
  };
}

test('store upserts, aggregates and preserves newer snapshots', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volc-usage-store-'));
  const store = new Store(path.join(dir, 'usage.db'));

  store.upsertRows(
    [
      row(),
      row({ model: 'glm-5.3', credit: 0.5, reqTokens: 200, cachedTokens: 0 }),
    ],
    1_000,
  );
  store.upsertDayMeta('2026-11-24', true, 1_000);

  let history = store.getHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].credit, 5);
  assert.equal(history[0].requestCount, 10);
  assert.equal(history[0].complete, true);
  assert.equal(history[0].creditKnown, true);

  // 较旧的响应不能覆盖较新的数据。
  store.upsertRows([row({ credit: 999 })], 500);
  history = store.getHistory();
  assert.equal(history[0].credit, 5);

  // 较新的响应可以修正历史。
  store.upsertRows([row({ credit: 6 })], 2_000);
  history = store.getHistory();
  assert.equal(history[0].credit, 6.5);

  const models = store.getModelsForDate('2026-11-24');
  assert.equal(models.length, 2);
  assert.equal(models[0].model, 'kimi-k3.1-pro');
  assert.equal(models[0].nonCachedInput, 200);

  assert.deepEqual(store.getCoverage(), {
    from: '2026-11-24',
    to: '2026-11-24',
    days: 1,
  });

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store distinguishes unknown credit and marks notifications', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volc-usage-store-'));
  const store = new Store(path.join(dir, 'usage.db'));

  store.upsertRows([row({ credit: null, creditKnown: false })], 1_000);
  const history = store.getHistory();
  assert.equal(history[0].creditKnown, false);

  assert.deepEqual([...store.getNotifiedTiers('2026-11-24')], []);
  store.markNotified('2026-11-24', [20, 40], 1_000);
  store.markNotified('2026-11-24', [40, 60], 1_001);
  assert.deepEqual([...store.getNotifiedTiers('2026-11-24')].sort((a, b) => a - b), [20, 40, 60]);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
