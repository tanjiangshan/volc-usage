import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  detectWebhookFormat,
  normalizeWebhook,
  webhookInfo,
} from '../lib/config.mjs';
import { buildWebhookRequest, sendWebhook, Notifier } from '../lib/notify.mjs';

function fakeResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

test('detectWebhookFormat recognizes common bot hosts', () => {
  assert.equal(detectWebhookFormat('https://open.feishu.cn/open-apis/bot/v2/hook/x'), 'feishu');
  assert.equal(detectWebhookFormat('https://oapi.dingtalk.com/robot/send?access_token=x'), 'dingtalk');
  assert.equal(detectWebhookFormat('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x'), 'wecom');
  assert.equal(detectWebhookFormat('https://hooks.slack.com/services/x'), 'slack');
  assert.equal(detectWebhookFormat('https://api.telegram.org/bot123/sendMessage'), 'telegram');
  assert.equal(detectWebhookFormat('https://example.com/hook'), 'generic');
});

test('normalizeWebhook keeps explicit format and trims values', () => {
  assert.deepEqual(
    normalizeWebhook({ url: ' https://example.com/hook ', format: 'feishu', secret: ' s ' }),
    { url: 'https://example.com/hook', format: 'feishu', secret: 's', chatId: '' },
  );
  assert.equal(normalizeWebhook({ url: '' }), null);
  assert.equal(normalizeWebhook(null), null);
});

test('webhookInfo never exposes the full URL', () => {
  const info = webhookInfo({
    url: 'https://open.feishu.cn/open-apis/bot/v2/hook/secret-token-abcd',
    format: 'feishu',
    secret: 'sign',
  });
  assert.equal(info.enabled, true);
  assert.equal(info.format, 'feishu');
  assert.equal(info.hint, 'open.feishu.cn…abcd');
  assert.equal(info.hasSecret, true);
  assert.ok(!JSON.stringify(info).includes('secret-token'));
});

test('feishu payload includes signature when secret is set', () => {
  const request = buildWebhookRequest(
    { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', format: 'feishu', secret: 's3cret' },
    { title: '标题', text: '标题\n正文', now: 1_700_000_000_000 },
  );
  const body = JSON.parse(request.body);
  assert.equal(body.msg_type, 'text');
  assert.equal(body.content.text, '标题\n正文');
  assert.equal(body.timestamp, '1700000000');
  assert.equal(
    body.sign,
    crypto
      .createHmac('sha256', '1700000000\ns3cret')
      .update('')
      .digest('base64'),
  );
});

test('dingtalk signature is appended to the URL', () => {
  const request = buildWebhookRequest(
    {
      url: 'https://oapi.dingtalk.com/robot/send?access_token=x',
      format: 'dingtalk',
      secret: 's3cret',
    },
    { title: 't', text: 'hello', now: 1_700_000_000_000 },
  );
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('timestamp'), '1700000000000');
  assert.equal(
    url.searchParams.get('sign'),
    crypto
      .createHmac('sha256', 's3cret')
      .update('1700000000000\ns3cret')
      .digest('base64'),
  );
  assert.equal(JSON.parse(request.body).text.content, 'hello');
});

test('sendWebhook reports business errors without leaking the URL', async () => {
  await assert.rejects(
    sendWebhook({
      webhook: { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/token', format: 'feishu' },
      title: 't',
      text: 'x',
      fetchImpl: async () => fakeResponse({ code: 19021, msg: 'sign match fail' }),
    }),
    (error) => {
      assert.match(error.message, /code=19021/);
      assert.ok(!error.message.includes('token'));
      return true;
    },
  );
});

test('notifier delivers through webhook and falls back on failure', async () => {
  const calls = [];
  const sent = [];
  const store = {
    getNotifiedTiers: () => new Set(),
    markNotified: () => {},
  };
  const notifier = new Notifier({
    store,
    thresholds: [20],
    limit: 150,
    webhook: { url: 'https://example.com/hook', format: 'generic' },
    sender: async (payload) => {
      sent.push(payload);
      return 'log';
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return fakeResponse({ ok: true });
    },
    logger: { log() {}, warn() {} },
  });

  const result = await notifier.evaluate({
    date: '2026-11-25',
    credit: 40,
    creditKnown: true,
  });
  assert.equal(result.tier, 20);
  assert.equal(result.channel, 'webhook:generic');
  assert.equal(calls.length, 1);
  assert.equal(sent.length, 0);

  const fallback = new Notifier({
    store: {
      getNotifiedTiers: () => new Set(),
      markNotified: () => {},
    },
    thresholds: [20],
    limit: 150,
    webhook: { url: 'https://example.com/hook', format: 'generic' },
    sender: async () => 'log',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    logger: { log() {}, warn() {} },
  });
  const fallbackResult = await fallback.evaluate({
    date: '2026-11-25',
    credit: 40,
    creditKnown: true,
  });
  assert.equal(fallbackResult.channel, 'log');
});

test('sendTest works even when threshold notifications are disabled', async () => {
  const notifier = new Notifier({
    store: { getNotifiedTiers: () => new Set(), markNotified: () => {} },
    thresholds: [20],
    limit: 150,
    enabled: false,
    webhook: { url: 'https://example.com/hook', format: 'generic' },
    fetchImpl: async () => fakeResponse('ok'),
    logger: { log() {}, warn() {} },
  });
  const result = await notifier.sendTest();
  assert.equal(result.channel, 'webhook:generic');
});
