import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeModelCatalog } from '../lib/catalog.mjs';

test('normalizeModelCatalog sorts by credit and keeps provider variants', () => {
  const response = {
    object: 'list',
    data: [
      {
        id: 'dashscope/kimi-k3.1-pro',
        name: 'Kimi K3.1 Pro (DashScope)',
        owned_by: 'APIG_Volcengine',
        credit: '2.88',
        credit_history: [
          { from: '2026-11-19', credit: 2.88 },
          { from: '2026-11-03', credit: 3.2 },
        ],
      },
      {
        id: 'volcengine/deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        credit: 0.15,
        credit_history: [
          { from: '2026-10-19', credit: 0.2 },
          { from: '2026-11-03', credit: 0.15 },
        ],
      },
      {
        id: 'moonshot/kimi-k3.1-pro',
        name: 'Kimi K3.1 Pro (Moonshot)',
        credit: 3.6,
      },
    ],
  };

  const { models, warnings } = normalizeModelCatalog(response, { fetchedAt: 123 });
  assert.equal(warnings.length, 0);
  assert.deepEqual(
    models.map((model) => model.id),
    ['volcengine/deepseek-v4.1-flash', 'dashscope/kimi-k3.1-pro', 'moonshot/kimi-k3.1-pro'],
  );

  const flash = models[0];
  assert.equal(flash.provider, 'volcengine');
  assert.equal(flash.credit, 0.15);
  assert.equal(flash.changedAt, '2026-11-03');
  assert.deepEqual(flash.previous, { from: '2026-10-19', credit: 0.2 });

  const firstRelease = models[2];
  assert.equal(firstRelease.changedAt, null);
  assert.equal(firstRelease.previous, null);
});

test('normalizeModelCatalog tolerates malformed entries and unknown credit', () => {
  const response = {
    data: [
      null,
      { name: '没有 id' },
      { id: '  ', credit: 1 },
      { id: 'mystery-model', credit: null, credit_history: 'bad' },
      { id: 'mystery-model', credit: 0.5 },
    ],
  };

  const { models, warnings } = normalizeModelCatalog(response);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'mystery-model');
  assert.equal(models[0].provider, '官方');
  assert.equal(models[0].credit, 0.5);
  assert.ok(warnings.some((message) => message.includes('缺少 id')));
});

test('normalizeModelCatalog handles a top-level array and dedupes by id', () => {
  const { models } = normalizeModelCatalog([
    { id: 'a/model', credit: 1 },
    { id: 'a/model', credit: 2 },
  ]);
  assert.equal(models.length, 1);
  assert.equal(models[0].credit, 2);
});
