import { Gateway, AuthError } from './gateway.mjs';
import { Store } from './store.mjs';
import { Notifier } from './notify.mjs';
import {
  normalizeDailyModelRows,
  normalizeModelWindow,
  aggregateByDate,
  finalizeModelWindow,
  coverageCheck,
  sevenDayStats,
  percentOf,
  crossedTiers,
  dailyCompleteMap,
  dailyTotalsMap,
} from './credit.mjs';
import { normalizeModelCatalog } from './catalog.mjs';
import {
  beijingDateKey,
  beijingHourLabel,
  resetInfo,
  addDays,
} from './time.mjs';
import {
  resolveApiKey,
  keyHint,
  dbPath,
  saveConfig,
  readRawConfig,
  normalizeWebhook,
  webhookInfo,
  normalizeBaseUrl,
  WEBHOOK_FORMATS,
} from './config.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

function buildWindowFromRows(rows, warnings = []) {
  const models = rows.map((row) => ({
    model: row.model,
    reqTokens: row.reqTokens,
    rspTokens: row.rspTokens,
    cachedTokens: row.cachedTokens,
    nonCachedInput: Math.max(0, row.reqTokens - row.cachedTokens),
    totalTokens: row.totalTokens ?? row.reqTokens + row.rspTokens,
    requestCount: row.requestCount,
    credit: row.creditKnown ? row.credit : null,
    creditKnown: row.creditKnown,
    creditShare: null,
  }));
  return finalizeModelWindow(models, warnings);
}

export class Runtime {
  constructor({ config, logger = console, store = null, notifier = null, sender = undefined }) {
    this.config = config;
    this.logger = logger;
    this.startedAt = Date.now();
    this.store = store ?? new Store(dbPath());

    this.keyInfo = resolveApiKey({ rawConfig: config.raw });
    this.gateway = new Gateway({
      baseUrl: config.baseUrl,
      getApiKey: () => this.keyInfo.apiKey,
      logger,
    });

    this.notifier =
      notifier ??
      new Notifier({
        store: this.store,
        thresholds: config.thresholds,
        limit: config.dailyCreditLimit,
        enabled: config.notify,
        webhook: config.webhook ?? null,
        sender,
        logger,
      });

    this.cache = {
      today: null,
      month: null,
      summary: null,
      hourly: null,
      daily: null,
      models: this.loadStoredCatalog(),
    };
    this.health = {};
    this.inflight = new Map();
    this.timers = new Map();
    this.running = false;
    this.shutdown = false;
    this.keyError = null;
    this.refreshPromise = null;
  }

  loadStoredCatalog() {
    try {
      const raw = this.store.getMeta?.('model_catalog');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.models)) return null;
      return { ...parsed, source: 'store' };
    } catch {
      return null;
    }
  }

  get hasKey() {
    return Boolean(this.keyInfo.apiKey);
  }

  markHealth(name, patch) {
    const current = this.health[name] ?? { failures: 0 };
    this.health[name] = { ...current, ...patch };
  }

  runTask(name, fn) {
    if (this.inflight.has(name)) return this.inflight.get(name);

    const promise = (async () => {
      const current = this.health[name] ?? { failures: 0 };
      this.health[name] = { ...current, lastAttemptAt: Date.now() };
      try {
        const result = await fn();
        this.health[name] = {
          ...this.health[name],
          ok: true,
          lastSuccessAt: Date.now(),
          error: null,
          failures: 0,
        };
        return result;
      } catch (error) {
        this.health[name] = {
          ...this.health[name],
          ok: false,
          lastErrorAt: Date.now(),
          error: error.message,
          failures: (this.health[name].failures ?? 0) + 1,
        };
        if (error instanceof AuthError) this.keyError = error.message;
        throw error;
      }
    })();

    this.inflight.set(name, promise);
    promise.then(
      () => this.inflight.delete(name),
      () => this.inflight.delete(name),
    );
    return promise;
  }

  async fetchToday() {
    const result = await this.runTask('today', async () => {
      const response = await this.gateway.byModel('today');
      const fetchedAt = Date.now();
      const normalized = normalizeDailyModelRows(response.json);
      this.cache.today = {
        json: response.json,
        fetchedAt,
        latencyMs: response.latencyMs,
        rows: normalized.rows,
        warnings: normalized.warnings,
      };
      this.store.upsertRows(normalized.rows, fetchedAt);
      this.keyError = null;
      return response;
    });
    await this.safeMaybeNotify();
    return result;
  }

  async fetchMonth() {
    const result = await this.runTask('month', async () => {
      const response = await this.gateway.byModel('month');
      const fetchedAt = Date.now();
      const normalized = normalizeDailyModelRows(response.json);
      this.cache.month = {
        json: response.json,
        fetchedAt,
        latencyMs: response.latencyMs,
        rows: normalized.rows,
        warnings: normalized.warnings,
      };
      this.store.upsertRows(normalized.rows, fetchedAt);
      this.keyError = null;
      return response;
    });
    await this.safeMaybeNotify();
    return result;
  }

  async fetchSummary() {
    return this.runTask('summary', async () => {
      const response = await this.gateway.summary();
      this.cache.summary = {
        json: response.json,
        fetchedAt: Date.now(),
        latencyMs: response.latencyMs,
      };
      this.keyError = null;
      return response;
    });
  }

  async fetchHourly() {
    return this.runTask('hourly', async () => {
      const response = await this.gateway.hourly();
      this.cache.hourly = {
        json: response.json,
        fetchedAt: Date.now(),
        latencyMs: response.latencyMs,
      };
      this.keyError = null;
      return response;
    });
  }

  async fetchDaily() {
    return this.runTask('daily', async () => {
      const response = await this.gateway.daily();
      const fetchedAt = Date.now();
      this.cache.daily = {
        json: response.json,
        fetchedAt,
        latencyMs: response.latencyMs,
      };
      const data = Array.isArray(response.json?.data) ? response.json.data : [];
      for (const item of data) {
        if (!item?.date) continue;
        const complete =
          item.complete === true ? true : item.complete === false ? false : null;
        this.store.upsertDayMeta(String(item.date), complete, fetchedAt);
      }
      this.keyError = null;
      return response;
    });
  }

  async fetchModels() {
    return this.runTask('models', async () => {
      // /v1/models 不接受任何 query 参数，带 _=nonce 会 404，因此不要传 fresh。
      const response = await this.gateway.models();
      const fetchedAt = Date.now();
      const normalized = normalizeModelCatalog(response.json, { fetchedAt });
      this.cache.models = {
        ...normalized,
        latencyMs: response.latencyMs,
        source: 'gateway',
      };
      try {
        this.store.setMeta(
          'model_catalog',
          JSON.stringify({
            models: normalized.models,
            warnings: normalized.warnings,
            fetchedAt,
          }),
        );
      } catch (error) {
        this.logger.warn(`[models] 写入本地缓存失败：${error.message}`);
      }
      this.keyError = null;
      return response;
    });
  }

  schedule(name, run, delay) {
    if (!this.running || this.shutdown) return;
    const timer = setTimeout(run, Math.max(0, delay));
    timer.unref?.();
    this.timers.set(name, timer);
  }

  startLoop(name, fn, baseMs, initialDelay) {
    const run = async () => {
      if (!this.running || this.shutdown) return;
      let delay = baseMs;

      try {
        await fn();
      } catch (error) {
        const failures = this.health[name]?.failures ?? 1;
        delay = Math.min(baseMs * 2 ** Math.min(failures, 5), 10 * 60 * 1000);
        const jitter = Math.floor(Math.random() * Math.min(2000, Math.max(250, delay * 0.1)));
        delay += jitter;
        this.logger.warn(
          `[poll:${name}] ${error.message}，${Math.ceil(delay / 1000)}s 后重试`,
        );
      }

      if (!this.running || this.shutdown) return;
      this.schedule(name, run, delay);
    };

    this.schedule(name, run, initialDelay);
  }

  start() {
    if (this.shutdown || this.running) return;
    if (!this.config.baseUrl) {
      this.logger.warn('未配置网关地址，等待网页端设置');
      return;
    }
    if (!this.hasKey) {
      this.logger.warn('未配置 API Key，等待网页端设置');
      return;
    }

    this.running = true;
    const poll = this.config.poll;
    this.startLoop('today', () => this.fetchToday(), poll.today, 0);
    this.startLoop('month', () => this.fetchMonth(), poll.month, 150);
    this.startLoop('summary', () => this.fetchSummary(), poll.summary, 300);
    this.startLoop('hourly', () => this.fetchHourly(), poll.hourly, 450);
    this.startLoop('daily', () => this.fetchDaily(), poll.daily, 600);
    this.startLoop('models', () => this.fetchModels(), poll.models, 750);
    this.logger.log(
      `轮询已启动：today ${poll.today / 1000}s / month ${poll.month / 1000}s / ` +
        `summary ${poll.summary / 1000}s / hourly ${poll.hourly / 1000}s / ` +
        `daily ${poll.daily / 1000}s / models ${poll.models / 1000}s`,
    );
  }

  stopLoops() {
    this.running = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  stop() {
    this.shutdown = true;
    this.stopLoops();
    this.store.close();
  }

  resetCaches() {
    this.cache = {
      today: null,
      month: null,
      summary: null,
      hourly: null,
      daily: null,
      models: this.loadStoredCatalog(),
    };
  }

  async refreshAll() {
    if (!this.hasKey) return { ok: false, reason: 'no-key', results: [] };
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      const tasks = [
        ['today', () => this.fetchToday()],
        ['month', () => this.fetchMonth()],
        ['summary', () => this.fetchSummary()],
        ['hourly', () => this.fetchHourly()],
        ['daily', () => this.fetchDaily()],
        ['models', () => this.fetchModels()],
      ];
      const results = [];

      for (const [name, fn] of tasks) {
        try {
          await fn();
          results.push({ name, ok: true });
        } catch (error) {
          results.push({ name, ok: false, error: error.message });
        }
        await sleep(120);
      }

      await this.safeMaybeNotify();
      return { ok: results.some((item) => item.ok), results };
    })();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  getTodayWindow(now = Date.now()) {
    const todayKey = beijingDateKey(now);

    if (this.cache.today?.rows?.some((row) => row.date === todayKey)) {
      return {
        window: normalizeModelWindow(this.cache.today.json),
        fetchedAt: this.cache.today.fetchedAt,
        source: 'today',
      };
    }

    if (this.cache.month) {
      const rows = this.cache.month.rows.filter((row) => row.date === todayKey);
      return {
        window: buildWindowFromRows(rows),
        fetchedAt: this.cache.month.fetchedAt,
        source: rows.length ? 'month' : 'month-empty',
      };
    }

    const rows = this.store.getModelsForDate(todayKey);
    return {
      window: buildWindowFromRows(rows),
      fetchedAt: null,
      source: rows.length ? 'store' : 'empty',
    };
  }

  getHistory(now = Date.now()) {
    const todayKey = beijingDateKey(now);
    const historyMap = new Map(this.store.getHistory(90).map((item) => [item.date, item]));
    const dailyMap = dailyTotalsMap(this.cache.daily?.json);

    if (this.cache.month) {
      for (const item of aggregateByDate(this.cache.month.rows)) {
        const previous = historyMap.get(item.date) ?? {};
        historyMap.set(item.date, {
          ...previous,
          ...item,
          complete: dailyMap.get(item.date)?.complete ?? previous.complete ?? null,
        });
      }
    }

    // daily 接口是每天请求数的唯一来源；credit 仍来自 by-model。
    for (const [date, daily] of dailyMap) {
      const previous = historyMap.get(date);
      if (previous) {
        historyMap.set(date, {
          ...previous,
          reqTokens: daily.reqTokens,
          rspTokens: daily.rspTokens,
          cachedTokens: daily.cachedTokens,
          totalTokens: daily.totalTokens,
          requestCount: daily.requestCount,
          complete: daily.complete,
        });
      } else if (date !== todayKey) {
        historyMap.set(date, {
          date,
          credit: 0,
          creditKnown: false,
          ...daily,
        });
      }
    }

    const today = this.getTodayWindow(now);
    const previousToday = historyMap.get(todayKey) ?? {};
    historyMap.set(todayKey, {
      ...previousToday,
      date: todayKey,
      credit: today.window.totalCredit,
      creditKnown: today.window.creditKnown,
      reqTokens: today.window.totals.reqTokens,
      rspTokens: today.window.totals.rspTokens,
      cachedTokens: today.window.totals.cachedTokens,
      totalTokens: today.window.totals.reqTokens + today.window.totals.rspTokens,
      requestCount: today.window.totals.requestCount,
      modelCount: today.window.models.length,
      complete: dailyMap.get(todayKey)?.complete ?? false,
    });

    const history = [...historyMap.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-90);

    return { history, todayWindow: today };
  }

  getHourly() {
    const data = Array.isArray(this.cache.hourly?.json?.data)
      ? this.cache.hourly.json.data
      : [];
    return {
      fetchedAt: this.cache.hourly?.fetchedAt ?? null,
      hours: Number(this.cache.hourly?.json?.hours ?? data.length),
      data: data.map((item) => ({
        ts: Number(item.ts),
        hour: beijingHourLabel(Number(item.ts)),
        reqTokens: Number(item.req_tokens ?? 0),
        rspTokens: Number(item.rsp_tokens ?? 0),
        cachedTokens: Number(item.cached_tokens ?? 0),
        totalTokens: Number(item.req_tokens ?? 0) + Number(item.rsp_tokens ?? 0),
        requestCount: Number(item.request_count ?? 0),
        complete: item.complete === true,
      })),
    };
  }

  getSummaryForToday(now = Date.now()) {
    const todayKey = beijingDateKey(now);
    if (this.cache.summary?.json?.date === todayKey) return this.cache.summary.json;
    return null;
  }

  async maybeNotify() {
    const now = Date.now();
    const todayKey = beijingDateKey(now);
    const today = this.getTodayWindow(now);

    if (!today.window || !today.window.creditKnown) return;
    const stale = !today.fetchedAt || now - today.fetchedAt > 5 * 60 * 1000;

    await this.notifier.evaluate({
      date: todayKey,
      credit: today.window.totalCredit,
      creditKnown: today.window.creditKnown,
      limit: this.config.dailyCreditLimit,
      stale,
      now,
    });
  }

  async safeMaybeNotify() {
    try {
      await this.maybeNotify();
    } catch (error) {
      this.logger.warn(`[notify] 评估失败：${error.message}`);
    }
  }

  async validateApiKey(apiKey, baseUrl = this.config.baseUrl) {
    if (!baseUrl) throw new ValidationError('请先填写网关地址');
    const gateway = new Gateway({
      baseUrl,
      getApiKey: () => apiKey,
      retries: 0,
      logger: this.logger,
    });
    await gateway.summary();
  }

  async updateSettings({
    apiKey,
    clearApiKey,
    baseUrl,
    dailyCreditLimit,
    notify,
    webhookUrl,
    webhookFormat,
    webhookSecret,
    webhookChatId,
    clearWebhook,
  }) {
    let nextBase;
    if (baseUrl !== undefined) {
      nextBase = normalizeBaseUrl(baseUrl);
      if (!nextBase) throw new ValidationError('请填写网关地址');
      let parsed;
      try {
        parsed = new URL(nextBase);
      } catch {
        throw new ValidationError('网关地址格式不正确');
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new ValidationError('网关地址只支持 http/https');
      }
    }

    const nextKey = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : null;
    const effectiveBase = nextBase ?? this.config.baseUrl;
    if (nextKey) {
      if (!effectiveBase) throw new ValidationError('请先填写网关地址');
      try {
        await this.validateApiKey(nextKey, effectiveBase);
      } catch (error) {
        if (error instanceof ValidationError) throw error;
        throw new ValidationError(`网关校验失败：${error.message}`);
      }
    } else if (nextBase && nextBase !== this.config.baseUrl && this.hasKey) {
      try {
        await this.validateApiKey(this.keyInfo.apiKey, nextBase);
      } catch (error) {
        throw new ValidationError(`该网关地址无法使用当前 API Key：${error.message}`);
      }
    }

    let nextLimit;
    if (dailyCreditLimit !== undefined) {
      nextLimit = Number(dailyCreditLimit);
      if (!Number.isFinite(nextLimit) || nextLimit <= 0) {
        throw new ValidationError('每日额度必须是大于 0 的数字');
      }
    }

    const patch = {};
    if (nextKey) patch.apiKey = nextKey;
    else if (clearApiKey) patch.apiKey = null;
    if (nextBase !== undefined) patch.baseUrl = nextBase;
    if (nextLimit !== undefined) patch.dailyCreditLimit = nextLimit;
    if (notify !== undefined) patch.notify = Boolean(notify);

    const webhookTouched =
      webhookUrl !== undefined ||
      webhookFormat !== undefined ||
      webhookSecret !== undefined ||
      webhookChatId !== undefined;

    if (clearWebhook) {
      patch.webhook = null;
    } else if (webhookTouched) {
      const current = this.config.webhook ?? null;
      const url =
        typeof webhookUrl === 'string' && webhookUrl.trim()
          ? webhookUrl.trim()
          : current?.url ?? '';

      if (!url) throw new ValidationError('请填写 Webhook URL');
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new ValidationError('Webhook URL 格式不正确');
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new ValidationError('Webhook URL 只支持 http/https');
      }

      const format = String(webhookFormat ?? current?.format ?? 'auto').toLowerCase();
      if (!WEBHOOK_FORMATS.includes(format)) {
        throw new ValidationError(`不支持的 Webhook 类型：${format}`);
      }

      patch.webhook = {
        url,
        format,
        secret: webhookSecret !== undefined ? String(webhookSecret).trim() : current?.secret ?? '',
        chatId:
          webhookChatId !== undefined ? String(webhookChatId).trim() : current?.chatId ?? '',
      };
    }

    if (Object.keys(patch).length) saveConfig(patch);

    const raw = readRawConfig();
    this.config.raw = raw;
    if (nextBase !== undefined) {
      this.config.baseUrl = nextBase;
      this.gateway.baseUrl = nextBase;
    }
    if (nextLimit !== undefined) this.config.dailyCreditLimit = nextLimit;
    if (notify !== undefined) this.config.notify = Boolean(notify);
    if (clearWebhook || webhookTouched) {
      this.config.webhook = normalizeWebhook(raw.webhook);
      this.notifier.webhook = this.config.webhook;
    }
    this.notifier.limit = this.config.dailyCreditLimit;
    this.notifier.enabled = this.config.notify;

    const rereadKey = nextKey || clearApiKey;
    if (rereadKey) this.keyInfo = resolveApiKey({ rawConfig: raw });

    if (rereadKey || nextBase !== undefined) {
      this.keyError = null;
      this.resetCaches();
      this.stopLoops();
      if (this.hasKey && this.config.baseUrl) {
        this.start();
        await this.refreshAll();
      }
    } else {
      await this.safeMaybeNotify();
    }

    return this.safeConfig();
  }

  async testNotify() {
    return this.notifier.sendTest();
  }

  safeConfig() {
    return {
      baseUrl: this.config.baseUrl,
      dailyCreditLimit: this.config.dailyCreditLimit,
      notify: this.config.notify,
      thresholds: this.config.thresholds,
      webhook: webhookInfo(this.config.webhook),
      host: this.config.host,
      port: this.config.port,
      poll: this.config.poll,
      key: {
        hasKey: this.hasKey,
        source: this.keyInfo.source,
        hint: keyHint(this.keyInfo.apiKey),
        error: this.keyError,
      },
    };
  }

  getCatalogView(usageModels = []) {
    const cached = this.cache.models;
    if (!cached) {
      return {
        models: [],
        warnings: [],
        fetchedAt: null,
        source: null,
        stale: true,
      };
    }

    const used = new Set();
    for (const item of usageModels) {
      if (!item?.model) continue;
      used.add(item.model);
      used.add(String(item.model).toLowerCase());
    }

    const models = cached.models.map((model) => {
      const shortId = model.id.includes('/')
        ? model.id.slice(model.id.indexOf('/') + 1)
        : model.id;
      return {
        ...model,
        shortId,
        used:
          used.has(shortId) ||
          used.has(shortId.toLowerCase()) ||
          used.has(model.id) ||
          used.has(model.id.toLowerCase()),
        lastChange: model.changedAt
          ? {
              at: model.changedAt,
              from: model.previous ? model.previous.credit : null,
              to: model.credit,
            }
          : null,
      };
    });

    return {
      models,
      warnings: cached.warnings ?? [],
      fetchedAt: cached.fetchedAt ?? null,
      source: cached.source ?? null,
      stale: cached.source === 'store',
    };
  }

  snapshot(now = Date.now()) {
    const todayKey = beijingDateKey(now);
    const { history, todayWindow } = this.getHistory(now);
    const window = todayWindow.window;
    const summary = this.getSummaryForToday(now);
    const completeMap = dailyCompleteMap(this.cache.daily?.json);
    const limit = this.config.dailyCreditLimit;
    const credit = window.totalCredit;
    const creditKnown = window.creditKnown;
    const percent = percentOf(credit, limit);
    const totals = window.totals;

    const cacheHitRate =
      summary?.data && Number.isFinite(summary.data.cache_hit_rate)
        ? summary.data.cache_hit_rate
        : totals.reqTokens > 0
          ? totals.cachedTokens / totals.reqTokens
          : null;

    // summary 的轮询间隔比 today 长（10 分钟 vs 60 秒）。两次抓取时间差太大时
    // 直接比较会误报覆盖不一致，因此只在两者接近时做校验。
    const summaryAligned =
      summary &&
      this.cache.summary?.fetchedAt &&
      this.cache.today?.fetchedAt &&
      Math.abs(this.cache.summary.fetchedAt - this.cache.today.fetchedAt) <= 3 * 60 * 1000;
    const coverage = summaryAligned
      ? coverageCheck(summary.data, totals)
      : { ok: null, reason: 'summary 与 today 抓取时间不同步，跳过覆盖校验' };

    const lastSuccessAt =
      Math.max(
        this.cache.today?.fetchedAt ?? 0,
        this.cache.month?.fetchedAt ?? 0,
      ) || null;
    const lastAttemptAt =
      Math.max(
        this.health.today?.lastAttemptAt ?? 0,
        this.health.month?.lastAttemptAt ?? 0,
      ) || null;
    const staleSeconds =
      lastSuccessAt === null ? null : Math.max(0, Math.floor((now - lastSuccessAt) / 1000));
    const stale = lastSuccessAt === null || now - lastSuccessAt > 3 * 60 * 1000;

    const warnings = [];
    const pushWarning = (message) => {
      if (message && !warnings.includes(message)) warnings.push(message);
    };
    for (const warning of this.cache.today?.warnings ?? []) pushWarning(warning);
    for (const warning of this.cache.month?.warnings ?? []) pushWarning(warning);
    if (this.keyError) pushWarning(this.keyError);
    if (stale && this.hasKey && this.config.baseUrl) {
      pushWarning('网关数据已过期，页面显示的是最近一次成功快照');
    }
    if (!creditKnown) pushWarning('今日有 credit 未知项，通知已暂停，等待网关返回完整数据');
    if (coverage.ok === false) {
      pushWarning(
        `summary 与 by-model 覆盖不一致：请求 ${coverage.diffs.requestCount}，` +
          `输入 ${coverage.diffs.reqTokens}，输出 ${coverage.diffs.rspTokens}，` +
          `缓存 ${coverage.diffs.cachedTokens}`,
      );
    }

    const yesterdayItem = history.find((item) => item.date === addDays(todayKey, -1));
    const yesterday = yesterdayItem
      ? {
          date: yesterdayItem.date,
          credit: yesterdayItem.credit,
          creditKnown: yesterdayItem.creditKnown,
          requestCount: yesterdayItem.requestCount,
          reqTokens: yesterdayItem.reqTokens,
          rspTokens: yesterdayItem.rspTokens,
        }
      : null;

    const stats = sevenDayStats(history, todayKey);
    const crossed = creditKnown ? crossedTiers(percent, this.config.thresholds) : [];
    const currentTier = crossed.length ? Math.max(...crossed) : null;
    const nextTier = this.config.thresholds.find((tier) => percent === null || percent < tier) ?? null;

    const configured = this.hasKey && Boolean(this.config.baseUrl);
    const status = !configured
      ? 'setup'
      : this.keyError
        ? 'auth-error'
        : stale
          ? 'stale'
          : 'ok';

    return {
      generatedAt: now,
      startedAt: this.startedAt,
      status,
      needsSetup: !configured,
      today: {
        date: todayKey,
        credit,
        creditKnown,
        limit,
        remaining: limit - credit,
        over: Math.max(0, credit - limit),
        percent,
        requestCount: totals.requestCount,
        reqTokens: totals.reqTokens,
        rspTokens: totals.rspTokens,
        cachedTokens: totals.cachedTokens,
        nonCachedInput: totals.nonCachedInput,
        cacheHitRate,
        complete: completeMap.get(todayKey) ?? false,
        fetchedAt: todayWindow.fetchedAt,
        source: todayWindow.source,
      },
      yesterday,
      stats,
      models: window.models,
      modelTotals: totals,
      catalog: this.getCatalogView(window.models),
      history,
      hourly: this.getHourly(),
      coverage,
      freshness: {
        lastSuccessAt,
        lastAttemptAt,
        staleSeconds,
        stale,
        sourceFreshnessSec: Number(summary?.data_freshness_sec ?? 60),
        error:
          this.keyError ||
          this.health.today?.error ||
          this.health.month?.error ||
          this.health.summary?.error ||
          null,
        tasks: Object.fromEntries(
          Object.entries(this.health).map(([name, value]) => [
            name,
            {
              ok: value.ok ?? null,
              lastAttemptAt: value.lastAttemptAt ?? null,
              lastSuccessAt: value.lastSuccessAt ?? null,
              latencyMs: value.latencyMs ?? null,
              error: value.error ?? null,
              failures: value.failures ?? 0,
            },
          ]),
        ),
      },
      reset: resetInfo(now),
      notify: {
        enabled: this.notifier.enabled,
        thresholds: this.config.thresholds,
        currentTier,
        nextTier,
        webhook: webhookInfo(this.config.webhook),
      },
      key: {
        hasKey: this.hasKey,
        source: this.keyInfo.source,
        hint: keyHint(this.keyInfo.apiKey),
        error: this.keyError,
      },
      settings: {
        baseUrl: this.config.baseUrl,
        dailyCreditLimit: this.config.dailyCreditLimit,
        notify: this.config.notify,
        thresholds: this.config.thresholds,
        host: this.config.host,
        port: this.config.port,
        poll: this.config.poll,
        consumer: summary?.consumer ?? null,
      },
      store: this.store.getCoverage(),
      warnings,
    };
  }
}
