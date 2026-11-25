import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

function logFallback(logger, title, body, reason) {
  logger.log(`[notify:${reason}] ${title} — ${body}`);
}

function hmacBase64(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('base64');
}

// 各家机器人 payload 不同；这里统一生成请求，方便测试与排查。
export function buildWebhookRequest(webhook, { title, text, now = Date.now() }) {
  const format = webhook.format ?? 'generic';
  const url = new URL(webhook.url);
  let body;

  if (format === 'feishu') {
    body = { msg_type: 'text', content: { text } };
    if (webhook.secret) {
      const timestamp = Math.floor(now / 1000).toString();
      body.timestamp = timestamp;
      body.sign = hmacBase64(`${timestamp}\n${webhook.secret}`, '');
    }
  } else if (format === 'dingtalk') {
    body = { msgtype: 'text', text: { content: text } };
    if (webhook.secret) {
      const timestamp = String(now);
      url.searchParams.set('timestamp', timestamp);
      url.searchParams.set('sign', hmacBase64(webhook.secret, `${timestamp}\n${webhook.secret}`));
    }
  } else if (format === 'wecom') {
    body = { msgtype: 'text', text: { content: text } };
  } else if (format === 'slack') {
    body = { text };
  } else if (format === 'telegram') {
    body = { text };
    if (webhook.chatId) body.chat_id = webhook.chatId;
  } else {
    body = { source: 'volc-usage', title, text, timestamp: new Date(now).toISOString() };
  }

  return {
    url: url.toString(),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function webhookBusinessError(format, json) {
  if (!json || typeof json !== 'object') return null;
  if (format === 'feishu' && json.code !== undefined && Number(json.code) !== 0) {
    return `飞书返回 code=${json.code}${json.msg ? ` ${json.msg}` : ''}`;
  }
  if (
    (format === 'dingtalk' || format === 'wecom') &&
    json.errcode !== undefined &&
    Number(json.errcode) !== 0
  ) {
    return `机器人返回 errcode=${json.errcode}${json.errmsg ? ` ${json.errmsg}` : ''}`;
  }
  if (format === 'telegram' && json.ok === false) {
    return `Telegram 返回 ${json.description ?? 'unknown error'}`;
  }
  return null;
}

export async function sendWebhook({
  webhook,
  title,
  text,
  logger = console,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
}) {
  const request = buildWebhookRequest(webhook, { title, text });

  let response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // 不输出 URL：里面的机器人 token 等同于密码。
    throw new Error(`webhook 请求失败：${error.message}`);
  }

  const raw = await response.text().catch(() => '');
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    // 非 JSON 响应只用于 HTTP 状态判断
  }

  if (!response.ok) {
    const detail = raw ? ` ${raw.slice(0, 160)}` : '';
    throw new Error(`webhook HTTP ${response.status}${detail}`);
  }

  const businessError = webhookBusinessError(webhook.format, json);
  if (businessError) throw new Error(businessError);

  return `webhook:${webhook.format}`;
}

function escapeAppleScript(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function spawnDesktopNotify(command, args, { logger, title, body, channel }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: 'ignore' });
    } catch {
      logFallback(logger, title, body, 'spawn-error');
      resolve('log');
      return;
    }

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.on('error', () => {
      logFallback(logger, title, body, 'unavailable');
      finish('log');
    });

    child.on('exit', (code) => {
      if (code === 0) finish(channel);
      else {
        logFallback(logger, title, body, `exit-${code}`);
        finish('log');
      }
    });

    const timer = setTimeout(() => finish(channel), 1500);
    timer.unref?.();
  });
}

export function notifySend({ title, body, urgency = 'normal', logger = console }) {
  if (process.env.VOLC_USAGE_DISABLE_NOTIFY === '1') {
    logFallback(logger, title, body, 'disabled');
    return Promise.resolve('log');
  }

  if (process.platform === 'darwin') {
    const script = `display notification ${escapeAppleScript(body)} with title ${escapeAppleScript(title)}`;
    return spawnDesktopNotify('/usr/bin/osascript', ['-e', script], {
      logger,
      title,
      body,
      channel: 'osascript',
    });
  }

  if (process.platform !== 'linux') {
    // Windows 没有自带可脚本化的通知中心接口，配置 Webhook 或看日志。
    logFallback(logger, title, body, 'unsupported-platform');
    return Promise.resolve('log');
  }

  return spawnDesktopNotify(
    'notify-send',
    ['-a', 'volc-usage', '-u', urgency, '-t', '10000', title, body],
    { logger, title, body, channel: 'notify-send' },
  );
}

export class Notifier {
  constructor({
    store,
    thresholds,
    limit,
    enabled = true,
    sender = notifySend,
    webhook = null,
    fetchImpl = globalThis.fetch,
    logger = console,
  }) {
    this.store = store;
    this.thresholds = [...thresholds].sort((a, b) => a - b);
    this.limit = limit;
    this.enabled = enabled;
    this.sender = sender;
    this.webhook = webhook;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
  }

  async deliver({ title, body, urgency = 'normal' }) {
    if (this.webhook?.url) {
      try {
        return await sendWebhook({
          webhook: this.webhook,
          title,
          text: `${title}\n${body}`,
          logger: this.logger,
          fetchImpl: this.fetchImpl,
        });
      } catch (error) {
        this.logger.warn(`[notify] webhook 发送失败：${error.message}，改为写入日志`);
      }
    }
    return this.sender({ title, body, urgency, logger: this.logger });
  }

  async sendTest() {
    const title = '火山AI网关额度 · 测试通知';
    const body = this.webhook?.url
      ? `Webhook 配置成功，每日额度 ${this.limit} credit。`
      : `当前未配置 Webhook，提醒会写入 journal 日志。每日额度 ${this.limit} credit。`;
    const channel = await this.deliver({ title, body, urgency: 'low' });
    this.logger.log(`[notify:test] channel=${channel}`);
    return { channel };
  }

  async evaluate({ date, credit, creditKnown, limit = this.limit, stale = false, now = Date.now() }) {
    if (!this.enabled) return null;
    if (stale) return null;
    if (!date || !creditKnown || !Number.isFinite(credit)) return null;
    if (!Number.isFinite(limit) || limit <= 0) return null;

    const percent = (credit / limit) * 100;
    const crossed = this.thresholds.filter((tier) => percent >= tier);
    if (!crossed.length) return null;

    const already = this.store.getNotifiedTiers(date);
    const newly = crossed.filter((tier) => !already.has(tier));
    if (!newly.length) return null;

    const top = Math.max(...newly);
    // 先落库再发送：宁可极端情况下漏一条，也不要在重启/崩溃后重复刷屏。
    this.store.markNotified(date, newly, now);

    const over = credit - limit;
    const body =
      `今日已用 ${credit.toFixed(2)} / ${limit} credit（${percent.toFixed(1)}%），` +
      `剩余 ${Math.max(0, limit - credit).toFixed(2)}` +
      (over > 0
        ? `；已超出 ${over.toFixed(2)}，是否拒绝以网关实际响应为准`
        : '');

    const title = `火山AI网关额度 · ${top}%`;
    const urgency = percent >= 100 ? 'critical' : percent >= 80 ? 'normal' : 'low';
    const channel = await this.deliver({ title, body, urgency });

    this.logger.log(
      `[notify] date=${date} tier=${top} percent=${percent.toFixed(1)} channel=${channel}`,
    );
    return { tier: top, percent, channel };
  }
}
