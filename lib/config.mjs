import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BASE_URL = '';
export const DEFAULT_DAILY_LIMIT = 150;
export const DEFAULT_THRESHOLDS = [20, 40, 60, 80, 100, 120];
export const DEFAULT_POLL = {
  today: 60 * 1000,
  month: 5 * 60 * 1000,
  summary: 10 * 60 * 1000,
  hourly: 5 * 60 * 1000,
  daily: 30 * 60 * 1000,
};
export const WEBHOOK_FORMATS = [
  'auto',
  'feishu',
  'dingtalk',
  'wecom',
  'slack',
  'telegram',
  'generic',
];

// 从 URL 推断机器人类型；用户显式指定 format 时以显式值为准。
export function detectWebhookFormat(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'generic';
  }
  if (host.endsWith('feishu.cn') || host.endsWith('larksuite.com')) return 'feishu';
  if (host.endsWith('dingtalk.com')) return 'dingtalk';
  if (host === 'qyapi.weixin.qq.com') return 'wecom';
  if (host === 'hooks.slack.com') return 'slack';
  if (host === 'api.telegram.org') return 'telegram';
  return 'generic';
}

export function normalizeWebhook(input) {
  if (!input || typeof input !== 'object') return null;
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!url) return null;

  const requested = String(input.format ?? 'auto').toLowerCase();
  const format =
    WEBHOOK_FORMATS.includes(requested) && requested !== 'auto'
      ? requested
      : detectWebhookFormat(url);

  return {
    url,
    format,
    secret: typeof input.secret === 'string' ? input.secret.trim() : '',
    chatId: typeof input.chatId === 'string' ? input.chatId.trim() : '',
  };
}

// 只用于接口/日志：host + 尾部 4 位，绝不回显完整 URL（其中通常含机器人 token）。
export function webhookInfo(webhook) {
  if (!webhook?.url) return { enabled: false, format: null, hint: null };
  let host = '';
  let tail = '';
  try {
    const parsed = new URL(webhook.url);
    host = parsed.host;
    tail = webhook.url.slice(-4);
  } catch {
    tail = webhook.url.slice(-4);
  }
  return {
    enabled: true,
    format: webhook.format,
    hint: `${host || '自定义地址'}…${tail}`,
    hasSecret: Boolean(webhook.secret),
  };
}

export function configDir() {
  return (
    process.env.VOLC_USAGE_CONFIG_DIR ||
    path.join(os.homedir(), '.config', 'volc-usage')
  );
}

export function configPath() {
  return path.join(configDir(), 'config.json');
}

export function dataDir() {
  return (
    process.env.VOLC_USAGE_DATA_DIR ||
    path.join(os.homedir(), '.local', 'share', 'volc-usage')
  );
}

export function dbPath() {
  return path.join(dataDir(), 'usage.db');
}

export function opencodeConfigPath() {
  return (
    process.env.OPENCODE_CONFIG ||
    path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc')
  );
}

// JSONC -> JSON。必须按字符串状态扫描，否则配置里的 URL（含 //）会被误删。
export function stripJsonc(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  let out = '';
  let inString = false;
  let escaped = false;
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      i += 1;
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }

    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }

    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    out += c;
    i += 1;
  }

  return removeTrailingCommas(out);
}

function removeTrailingCommas(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];

    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }

    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === '}' || text[j] === ']') continue;
    }

    out += c;
  }

  return out;
}

export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}

export function readRawConfig(file = configPath()) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  const parsed = parseJsonc(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`配置文件必须是 JSON 对象: ${file}`);
  }
  return parsed;
}

function isGatewayProvider(provider, id) {
  if (!provider || typeof provider !== 'object') return false;
  const name = String(provider.name ?? '');
  const baseURL = String(provider.settings?.baseURL ?? provider.baseURL ?? '');
  return (
    id === '火山AI网关' ||
    name === '火山AI网关' ||
    baseURL.includes('apigateway-cn-beijing.volceapi.com')
  );
}

function extractProviderKey(provider) {
  const candidates = [
    provider.settings?.apiKey,
    provider.apiKey,
    provider.options?.apiKey,
    provider.config?.apiKey,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

function extractProviderBaseUrl(provider) {
  const candidate = provider.settings?.baseURL ?? provider.baseURL ?? '';
  return typeof candidate === 'string' ? candidate.trim() : '';
}

export function normalizeBaseUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return text.replace(/\/+$/, '');
}

// 从 OpenCode 的 provider 配置里同时读取 Key 和网关地址。
export function readOpencodeGatewaySettings(file = opencodeConfigPath()) {
  try {
    if (!fs.existsSync(file)) return { apiKey: null, baseUrl: '' };
    const parsed = parseJsonc(fs.readFileSync(file, 'utf8'));
    const providers = parsed?.providers ?? parsed?.provider ?? {};
    for (const [id, provider] of Object.entries(providers)) {
      if (!isGatewayProvider(provider, id)) continue;
      return {
        apiKey: extractProviderKey(provider),
        baseUrl: extractProviderBaseUrl(provider),
      };
    }
  } catch {
    // 配置损坏或格式变化时静默降级，交给网页设置。
  }
  return { apiKey: null, baseUrl: '' };
}

export function readOpencodeGatewayKey(file = opencodeConfigPath()) {
  return readOpencodeGatewaySettings(file).apiKey;
}

export function readOpencodeGatewayBaseUrl(file = opencodeConfigPath()) {
  return readOpencodeGatewaySettings(file).baseUrl;
}

export function resolveApiKey({ env = process.env, rawConfig, opencodeFile } = {}) {
  if (typeof env.VOLC_GATEWAY_API_KEY === 'string' && env.VOLC_GATEWAY_API_KEY.trim()) {
    return { apiKey: env.VOLC_GATEWAY_API_KEY.trim(), source: 'env' };
  }

  const config = rawConfig ?? readRawConfig();
  if (typeof config.apiKey === 'string' && config.apiKey.trim()) {
    return { apiKey: config.apiKey.trim(), source: 'config' };
  }

  const key = readOpencodeGatewayKey(opencodeFile);
  if (key) return { apiKey: key, source: 'opencode' };

  return { apiKey: null, source: null };
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeThresholds(value) {
  const list = Array.isArray(value) ? value : DEFAULT_THRESHOLDS;
  const out = [...new Set(list.map(Number).filter((n) => Number.isFinite(n) && n > 0))].sort(
    (a, b) => a - b,
  );
  return out.length ? out : [...DEFAULT_THRESHOLDS];
}

export function loadConfig() {
  const raw = readRawConfig();
  const poll = { ...DEFAULT_POLL, ...(raw.poll && typeof raw.poll === 'object' ? raw.poll : {}) };
  const opencode = readOpencodeGatewaySettings();

  const config = {
    baseUrl: normalizeBaseUrl(
      process.env.VOLC_GATEWAY_BASE_URL ||
        (typeof raw.baseUrl === 'string' && raw.baseUrl.trim()) ||
        opencode.baseUrl ||
        DEFAULT_BASE_URL,
    ),
    dailyCreditLimit: positiveNumber(raw.dailyCreditLimit, DEFAULT_DAILY_LIMIT),
    notify: raw.notify !== false,
    thresholds: normalizeThresholds(raw.thresholds),
    webhook: normalizeWebhook(raw.webhook),
    host: '127.0.0.1',
    port: positiveNumber(process.env.VOLC_USAGE_PORT ?? raw.port, 8788),
    poll: {
      today: positiveNumber(poll.today, DEFAULT_POLL.today),
      month: positiveNumber(poll.month, DEFAULT_POLL.month),
      summary: positiveNumber(poll.summary, DEFAULT_POLL.summary),
      hourly: positiveNumber(poll.hourly, DEFAULT_POLL.hourly),
      daily: positiveNumber(poll.daily, DEFAULT_POLL.daily),
    },
    raw,
  };

  config.port = Math.min(65535, Math.max(1, Math.floor(config.port)));
  return config;
}

export function saveConfig(patch) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const current = readRawConfig();
  const next = { ...current, ...patch };

  for (const key of Object.keys(next)) {
    if (
      next[key] === undefined ||
      (key === 'apiKey' && next[key] === null) ||
      (key === 'webhook' && next[key] === null)
    ) {
      delete next[key];
    }
  }

  const file = configPath();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return next;
}

export function setApiKey(apiKey) {
  return saveConfig({ apiKey: String(apiKey).trim() });
}

export function clearApiKey() {
  return saveConfig({ apiKey: null });
}

export function keyHint(apiKey) {
  if (!apiKey) return null;
  const text = String(apiKey);
  if (text.length <= 4) return '****';
  return text.slice(-4);
}

export function maskKey(apiKey) {
  if (!apiKey) return null;
  return `****${keyHint(apiKey)}`;
}

export function ensureDataDir() {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  return dataDir();
}
