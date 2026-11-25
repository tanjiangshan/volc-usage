export class AuthError extends Error {
  constructor(message = 'API Key 无效或未配置') {
    super(message);
    this.name = 'AuthError';
    this.status = 401;
  }
}

export class HttpError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt, response) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(30_000, retryAfter * 1000);
  }
  return Math.min(8_000, 400 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export class Gateway {
  constructor({ baseUrl, getApiKey, timeoutMs = 15_000, retries = 2, logger = console }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.getApiKey = getApiKey;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.logger = logger;
  }

  headers() {
    const key = this.getApiKey();
    if (!key) throw new AuthError('未配置 API Key');
    return {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
    };
  }

  buildUrl(path, fresh, attempt) {
    const base = this.baseUrl.replace(/\/+$/, '');
    let cleanPath = path.startsWith('/') ? path : `/${path}`;
    // baseUrl 通常已经包含 /v1，避免拼成 /v1/v1/...
    if (base.endsWith('/v1') && cleanPath.startsWith('/v1/')) {
      cleanPath = cleanPath.slice(3);
    }
    let url = `${base}${cleanPath}`;
    if (fresh) {
      const separator = url.includes('?') ? '&' : '?';
      url += `${separator}_=${Date.now()}${attempt ? `-${attempt}` : ''}`;
    }
    return url;
  }

  async request(path, { fresh = true, retries = this.retries, timeoutMs = this.timeoutMs } = {}) {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const started = Date.now();
      let response = null;

      try {
        response = await fetch(this.buildUrl(path, fresh, attempt), {
          headers: this.headers(),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (response.status === 401 || response.status === 403) {
          throw new AuthError(`鉴权失败（HTTP ${response.status}）`);
        }

        if (!response.ok) {
          const error = new HttpError(`HTTP ${response.status} ${path}`, response.status);
          if (attempt < retries && isRetryableStatus(response.status)) {
            lastError = error;
            await sleep(retryDelay(attempt, response));
            continue;
          }
          throw error;
        }

        const text = await response.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new HttpError('网关响应不是合法 JSON', response.status);
        }

        return {
          json,
          status: response.status,
          latencyMs: Date.now() - started,
          cache: response.headers.get('x-cache'),
          requestId: response.headers.get('x-faas-request-id'),
        };
      } catch (error) {
        if (error instanceof AuthError) throw error;

        lastError = error;
        const retryable =
          error instanceof HttpError ? isRetryableStatus(error.status) : true;

        if (attempt >= retries || !retryable) throw error;
        await sleep(retryDelay(attempt, response));
      }
    }

    throw lastError ?? new Error('请求失败');
  }

  summary() {
    return this.request('/v1/usage/summary', { fresh: true });
  }

  daily() {
    return this.request('/v1/usage/daily?days=31', { fresh: true });
  }

  byModel(window) {
    const allowed = new Set(['today', 'week', 'month']);
    if (!allowed.has(window)) throw new Error(`不支持的 window: ${window}`);
    return this.request(`/v1/usage/by-model?window=${encodeURIComponent(window)}`, {
      fresh: true,
    });
  }

  hourly() {
    return this.request('/v1/usage/hourly', { fresh: true });
  }

  models() {
    return this.request('/v1/models', { fresh: false });
  }
}
