import test from 'node:test';
import assert from 'node:assert/strict';

import { Notifier } from '../lib/notify.mjs';

class FakeStore {
  constructor() {
    this.tiers = new Map();
  }
  getNotifiedTiers(date) {
    return new Set(this.tiers.get(date) ?? []);
  }
  markNotified(date, tiers) {
    const current = this.tiers.get(date) ?? new Set();
    for (const tier of tiers) current.add(tier);
    this.tiers.set(date, current);
  }
  all(date) {
    return [...(this.tiers.get(date) ?? [])].sort((a, b) => a - b);
  }
}

function create(options = {}) {
  const store = new FakeStore();
  const sent = [];
  const notifier = new Notifier({
    store,
    thresholds: [20, 40, 60, 80, 100, 120],
    limit: 150,
    enabled: options.enabled ?? true,
    sender: async ({ title, body, urgency }) => {
      sent.push({ title, body, urgency });
      return 'test';
    },
    logger: { log() {}, warn() {} },
  });
  return { store, sent, notifier };
}

test('notifier sends the highest newly crossed tier once', async () => {
  const { store, sent, notifier } = create();

  assert.equal(await notifier.evaluate({ date: '2026-11-25', credit: 29.9, creditKnown: true }), null);
  assert.equal(sent.length, 0);

  const first = await notifier.evaluate({ date: '2026-11-25', credit: 37.5, creditKnown: true });
  assert.equal(first.tier, 20);
  assert.equal(sent.length, 1);

  // 同档不重发
  assert.equal(await notifier.evaluate({ date: '2026-11-25', credit: 40, creditKnown: true }), null);
  assert.equal(sent.length, 1);

  // 一次跳过多档：只发最高档，但低档全部标记为已处理
  const jump = await notifier.evaluate({ date: '2026-11-25', credit: 135, creditKnown: true });
  assert.equal(jump.tier, 80);
  assert.equal(sent.length, 2);
  assert.deepEqual(store.all('2026-11-25'), [20, 40, 60, 80]);
});

test('notifier supports 120% and critical urgency', async () => {
  const { sent, notifier } = create();
  const result = await notifier.evaluate({ date: '2026-11-25', credit: 187.5, creditKnown: true });
  assert.equal(result.tier, 120);
  assert.equal(sent[0].urgency, 'critical');
});

test('notifier skips stale, unknown, disabled and invalid limits', async () => {
  const { sent, notifier } = create();

  assert.equal(
    await notifier.evaluate({ date: '2026-11-25', credit: 100, creditKnown: true, stale: true }),
    null,
  );
  assert.equal(
    await notifier.evaluate({ date: '2026-11-25', credit: 100, creditKnown: false }),
    null,
  );
  assert.equal(
    await notifier.evaluate({ date: '2026-11-25', credit: 100, creditKnown: true, limit: 0 }),
    null,
  );

  const disabled = create({ enabled: false });
  assert.equal(
    await disabled.notifier.evaluate({ date: '2026-11-25', credit: 100, creditKnown: true }),
    null,
  );
  assert.equal(sent.length, 0);
  assert.equal(disabled.sent.length, 0);
});

test('notifier does not resend after a restart (persisted tiers)', async () => {
  const store = new FakeStore();
  const sent = [];
  const make = () =>
    new Notifier({
      store,
      thresholds: [20, 40, 60, 80, 100, 120],
      limit: 150,
      sender: async () => {
        sent.push(1);
        return 'test';
      },
      logger: { log() {}, warn() {} },
    });

  await make().evaluate({ date: '2026-11-25', credit: 40, creditKnown: true });
  assert.equal(sent.length, 1);

  const restarted = make();
  assert.equal(
    await restarted.evaluate({ date: '2026-11-25', credit: 45, creditKnown: true }),
    null,
  );
  assert.equal(sent.length, 1);
});
