#!/usr/bin/env node
import {
  loadConfig,
  resolveApiKey,
  saveConfig,
  readRawConfig,
  configPath,
  keyHint,
  webhookInfo,
} from './lib/config.mjs';
import { Gateway } from './lib/gateway.mjs';
import {
  normalizeModelWindow,
  normalizeDailyModelRows,
  aggregateByDate,
  coverageCheck,
  sevenDayStats,
  percentOf,
  dailyTotalsMap,
} from './lib/credit.mjs';
import {
  beijingDateKey,
  addDays,
  startOfWeek,
  startOfMonth,
  resetInfo,
  formatDuration,
} from './lib/time.mjs';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const color = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (text) => color('1', text);
const dim = (text) => color('2', text);
const green = (text) => color('32', text);
const yellow = (text) => color('33', text);
const red = (text) => color('31', text);

function fmtInt(value) {
  return new Intl.NumberFormat('zh-CN').format(Math.round(Number(value) || 0));
}

function fmtTokens(value) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return fmtInt(n);
}

function fmtCredit(value) {
  return (Number(value) || 0).toFixed(2);
}

function fmtPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
}

function bar(percent, width = 28) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((pct / 100) * width);
  const text = '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
  if (pct >= 100) return red(text);
  if (pct >= 80) return yellow(text);
  return green(text);
}

function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(
      ch,
    )
      ? 2
      : 1;
  }
  return width;
}

function pad(text, width, align = 'left') {
  const value = String(text);
  const gap = width - displayWidth(value);
  if (gap <= 0) return value;
  return align === 'right' ? ' '.repeat(gap) + value : value + ' '.repeat(gap);
}

function printTable(headers, rows, aligns = []) {
  const all = [headers, ...rows];
  const widths = headers.map((_, index) =>
    Math.max(...all.map((row) => displayWidth(row[index] ?? ''))),
  );

  const render = (row, header = false) =>
    row
      .map((cell, index) => {
        const align = aligns[index] ?? 'left';
        const text = pad(cell ?? '', widths[index], align);
        return header ? bold(text) : text;
      })
      .join('  ');

  console.log(render(headers, true));
  console.log(dim(widths.map((width) => '─'.repeat(width)).join('  ')));
  for (const row of rows) console.log(render(row));
}

function setupMessage() {
  const port = loadConfig().port;
  console.log(yellow('尚未配置网关地址或 API Key。任选一种方式：'));
  console.log(`  1. 打开网页设置：http://127.0.0.1:${port}`);
  console.log('  2. export VOLC_GATEWAY_BASE_URL=<url> VOLC_GATEWAY_API_KEY=<key>');
  console.log(`  3. 写入 ${configPath()}：{"baseUrl":"<url>","apiKey":"<key>"}`);
  console.log('  4. 确认 ~/.config/opencode/opencode.jsonc 的 火山AI网关 provider 带 baseURL 和 apiKey');
}

function ageLabel(freshness) {
  if (!freshness || freshness.staleSeconds === null || freshness.staleSeconds === undefined) {
    return '未知';
  }
  const text = `${freshness.staleSeconds}s 前`;
  return freshness.stale ? red(text) : text;
}

function printToday(state) {
  const today = state.today;
  const limit = today.limit ?? state.settings.dailyCreditLimit;
  const percent = Number.isFinite(today.percent) ? today.percent : 0;

  console.log(`${bold('火山AI网关')} · ${today.date}（Asia/Shanghai）`);
  console.log(
    `今日  ${bold(fmtCredit(today.credit))} / ${limit} credit   ${bar(percent)} ${fmtPercent(percent)}`,
  );
  console.log(
    `剩余  ${fmtCredit(Math.max(0, limit - today.credit))}` +
      (today.over > 0 ? `   ${red(`超出 ${fmtCredit(today.over)}`)}` : '') +
      `   重置 ${formatDuration(state.reset.secondsLeft)} 后`,
  );
  console.log(
    `请求  ${fmtInt(today.requestCount)}   缓存命中 ${fmtPercent(
      Number.isFinite(today.cacheHitRate) ? today.cacheHitRate * 100 : NaN,
    )}   数据 ${ageLabel(state.freshness)}`,
  );

  if (state.yesterday) {
    console.log(
      `昨日  ${fmtCredit(state.yesterday.credit)} credit · ${fmtInt(
        state.yesterday.requestCount,
      )} 次请求`,
    );
  }

  if (state.stats?.days) {
    console.log(
      `近7天  日均 ${fmtCredit(state.stats.avg)} · 最高 ${fmtCredit(
        state.stats.max,
      )}（${state.stats.maxDate}）· 覆盖 ${state.stats.days} 天`,
    );
  }

  if (state.models?.length) {
    console.log('');
    const rows = state.models.map((model) => [
      model.model,
      fmtInt(model.requestCount),
      fmtTokens(model.nonCachedInput),
      fmtTokens(model.cachedTokens),
      fmtTokens(model.rspTokens),
      fmtCredit(model.credit),
      Number.isFinite(model.creditShare) ? fmtPercent(model.creditShare * 100) : '—',
    ]);
    rows.push([
      '合计',
      fmtInt(today.requestCount),
      fmtTokens(today.nonCachedInput),
      fmtTokens(today.cachedTokens),
      fmtTokens(today.rspTokens),
      fmtCredit(today.credit),
      '100.0%',
    ]);
    printTable(
      ['模型', '请求', '非缓存输入', '缓存输入', '输出', 'credit', '占比'],
      rows,
      ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
    );
  }

  if (state.coverage?.ok === false) {
    console.log(yellow('提示：summary 与 by-model 的 token/请求数不一致，credits 以 by-model 为准'));
  }

  for (const warning of state.warnings ?? []) {
    console.log(yellow(`警告：${warning}`));
  }
}

function printWindow(state, windowName) {
  const today = state.today.date;
  const start = windowName === 'week' ? startOfWeek(today) : startOfMonth(today);
  const rows = (state.history ?? []).filter(
    (item) => item.date >= start && item.date <= today,
  );

  console.log(
    `${bold(windowName === 'week' ? '本周' : '本月')} ${start} ~ ${today}（Asia/Shanghai）`,
  );

  if (!rows.length) {
    console.log(dim('暂无数据'));
    return;
  }

  const total = rows.reduce((sum, item) => sum + (item.creditKnown ? item.credit : 0), 0);
  const knownDays = rows.filter((item) => item.creditKnown && item.complete !== false);
  const avg = knownDays.length ? total / knownDays.length : null;
  const max = rows.reduce((best, item) => (item.credit > best.credit ? item : best), rows[0]);

  console.log(
    `合计 ${bold(fmtCredit(total))} credit · ${fmtInt(
      rows.reduce((sum, item) => sum + item.requestCount, 0),
    )} 次请求 · 日均 ${avg === null ? '—' : fmtCredit(avg)} · 最高 ${fmtCredit(
      max.credit,
    )}（${max.date}）`,
  );
  console.log('');

  const table = rows.map((item) => [
    item.date,
    fmtInt(item.requestCount),
    fmtTokens(Math.max(0, item.reqTokens - item.cachedTokens)),
    fmtTokens(item.cachedTokens),
    fmtTokens(item.rspTokens),
    item.creditKnown ? fmtCredit(item.credit) : '未知',
    item.complete === false ? '进行中' : item.complete === null ? '—' : '完成',
  ]);

  printTable(
    ['日期', '请求', '非缓存输入', '缓存输入', '输出', 'credit', '状态'],
    table,
    ['left', 'right', 'right', 'right', 'right', 'right', 'left'],
  );
}

async function fetchServerState(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function postServerConfig(port, payload) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
    return json.config;
  } catch (error) {
    if (error.name === 'TimeoutError' || error.code === 'ECONNREFUSED') return null;
    // 本地服务未启动时返回 null；服务返回的业务错误继续抛出。
    if (String(error.message).startsWith('HTTP') || error.message.includes('API Key')) {
      throw error;
    }
    return null;
  }
}

async function computeLiveState(config, keyInfo) {
  const gateway = new Gateway({
    baseUrl: config.baseUrl,
    getApiKey: () => keyInfo.apiKey,
    logger: { log() {}, warn() {} },
  });

  const todayKey = beijingDateKey();
  const [todayResult, summaryResult, monthResult, dailyResult] = await Promise.allSettled([
    gateway.byModel('today'),
    gateway.summary(),
    gateway.byModel('month'),
    gateway.daily(),
  ]);

  if (todayResult.status !== 'fulfilled') throw todayResult.reason;

  const window = normalizeModelWindow(todayResult.value.json);
  const summaryJson =
    summaryResult.status === 'fulfilled' ? summaryResult.value.json : null;
  const summaryData = summaryJson?.date === todayKey ? summaryJson.data : null;
  const monthJson = monthResult.status === 'fulfilled' ? monthResult.value.json : null;
  const dailyJson = dailyResult.status === 'fulfilled' ? dailyResult.value.json : null;
  const dailyMap = dailyTotalsMap(dailyJson);

  const historyMap = new Map();
  if (monthJson) {
    for (const item of aggregateByDate(normalizeDailyModelRows(monthJson).rows)) {
      historyMap.set(item.date, {
        ...item,
        complete: dailyMap.get(item.date)?.complete ?? null,
      });
    }
  }

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
      historyMap.set(date, { date, credit: 0, creditKnown: false, ...daily });
    }
  }

  historyMap.set(todayKey, {
    date: todayKey,
    credit: window.totalCredit,
    creditKnown: window.creditKnown,
    reqTokens: window.totals.reqTokens,
    rspTokens: window.totals.rspTokens,
    cachedTokens: window.totals.cachedTokens,
    totalTokens: window.totals.reqTokens + window.totals.rspTokens,
    requestCount: window.totals.requestCount,
    modelCount: window.models.length,
    complete: dailyMap.get(todayKey)?.complete ?? false,
  });

  const history = [...historyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const yesterdayItem = history.find((item) => item.date === addDays(todayKey, -1));
  const percent = percentOf(window.totalCredit, config.dailyCreditLimit);
  const cacheHitRate =
    summaryData && Number.isFinite(summaryData.cache_hit_rate)
      ? summaryData.cache_hit_rate
      : window.totals.reqTokens > 0
        ? window.totals.cachedTokens / window.totals.reqTokens
        : null;

  const coverage = coverageCheck(summaryData, window.totals);
  const warnings = [...window.warnings];
  if (summaryResult.status === 'rejected') {
    warnings.push(`summary 获取失败：${summaryResult.reason.message}`);
  }
  if (monthResult.status === 'rejected') {
    warnings.push(`month 获取失败：${monthResult.reason.message}`);
  }
  if (dailyResult.status === 'rejected') {
    warnings.push(`daily 获取失败：${dailyResult.reason.message}（历史请求数可能缺失）`);
  }
  if (coverage.ok === false) {
    warnings.push('summary 与 by-model 的 token/请求数不一致');
  }

  return {
    generatedAt: Date.now(),
    status: 'ok',
    needsSetup: false,
    today: {
      date: todayKey,
      credit: window.totalCredit,
      creditKnown: window.creditKnown,
      limit: config.dailyCreditLimit,
      remaining: config.dailyCreditLimit - window.totalCredit,
      over: Math.max(0, window.totalCredit - config.dailyCreditLimit),
      percent,
      requestCount: window.totals.requestCount,
      reqTokens: window.totals.reqTokens,
      rspTokens: window.totals.rspTokens,
      cachedTokens: window.totals.cachedTokens,
      nonCachedInput: window.totals.nonCachedInput,
      cacheHitRate,
      complete: dailyMap.get(todayKey)?.complete ?? false,
      fetchedAt: Date.now(),
      source: 'live',
    },
    yesterday: yesterdayItem
      ? {
          date: yesterdayItem.date,
          credit: yesterdayItem.credit,
          creditKnown: yesterdayItem.creditKnown,
          requestCount: yesterdayItem.requestCount,
          reqTokens: yesterdayItem.reqTokens,
          rspTokens: yesterdayItem.rspTokens,
        }
      : null,
    stats: sevenDayStats(history, todayKey),
    models: window.models,
    modelTotals: window.totals,
    history,
    hourly: { data: [], hours: 0, fetchedAt: null },
    coverage,
    freshness: {
      lastSuccessAt: Date.now(),
      lastAttemptAt: Date.now(),
      staleSeconds: 0,
      stale: false,
      sourceFreshnessSec: Number(summaryJson?.data_freshness_sec ?? 60),
      error: null,
      tasks: {},
    },
    reset: resetInfo(),
    notify: {
      enabled: config.notify,
      thresholds: config.thresholds,
      currentTier: null,
      nextTier: config.thresholds[0] ?? null,
      webhook: webhookInfo(config.webhook),
    },
    key: {
      hasKey: true,
      source: keyInfo.source,
      hint: keyHint(keyInfo.apiKey),
      error: null,
    },
    settings: {
      baseUrl: config.baseUrl,
      dailyCreditLimit: config.dailyCreditLimit,
      notify: config.notify,
      thresholds: config.thresholds,
      port: config.port,
      host: config.host,
      poll: config.poll,
      consumer: summaryJson?.consumer ?? null,
    },
    warnings,
  };
}

async function getState(config) {
  const serverState = await fetchServerState(config.port);
  if (serverState) return { state: serverState, source: 'server' };

  const keyInfo = resolveApiKey({ rawConfig: config.raw });
  if (!keyInfo.apiKey || !config.baseUrl) return { state: null, source: 'none', keyInfo };
  return { state: await computeLiveState(config, keyInfo), source: 'live', keyInfo };
}

function printConfig(config) {
  const keyInfo = resolveApiKey({ rawConfig: config.raw });
  const webhook = webhookInfo(config.webhook);
  console.log(`${bold('配置文件')}  ${configPath()}`);
  console.log(`${bold('网关')}      ${config.baseUrl || '未配置'}`);
  console.log(`${bold('每日额度')}  ${config.dailyCreditLimit} credit`);
  console.log(`${bold('通知')}      ${config.notify ? '开启' : '关闭'}（${config.thresholds.join(' / ')}%）`);
  console.log(
    `${bold('Webhook')}   ${
      webhook.enabled ? `${webhook.format} · ${webhook.hint}` : '未配置'
    }`,
  );
  console.log(`${bold('网页')}      http://${config.host}:${config.port}`);
  console.log(
    `${bold('API Key')}   ${keyInfo.apiKey ? `****${keyHint(keyInfo.apiKey)}（来源：${keyInfo.source}）` : '未配置'}`,
  );
}

async function handleConfigCommand(args, config) {
  const sub = args[1] ?? 'show';
  const port = config.port;

  if (sub === 'show') {
    const serverConfig = await (async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
          signal: AbortSignal.timeout(1000),
        });
        return response.ok ? await response.json() : null;
      } catch {
        return null;
      }
    })();

    if (serverConfig) {
      console.log(`${bold('配置文件')}  ${configPath()}`);
      console.log(`${bold('网关')}      ${serverConfig.baseUrl}`);
      console.log(`${bold('每日额度')}  ${serverConfig.dailyCreditLimit} credit`);
      console.log(
        `${bold('通知')}      ${serverConfig.notify ? '开启' : '关闭'}（${serverConfig.thresholds.join(' / ')}%）`,
      );
      console.log(`${bold('网页')}      http://${serverConfig.host}:${serverConfig.port}`);
      console.log(
        `${bold('Webhook')}   ${
          serverConfig.webhook?.enabled
            ? `${serverConfig.webhook.format} · ${serverConfig.webhook.hint}`
            : '未配置'
        }`,
      );
      console.log(
        `${bold('API Key')}   ${
          serverConfig.key?.hasKey
            ? `****${serverConfig.key.hint}（来源：${serverConfig.key.source}）`
            : '未配置'
        }`,
      );
    } else {
      printConfig(config);
    }
    return;
  }

  if (sub === 'set-base-url') {
    const url = args[2];
    if (!url) throw new Error('用法：volc-usage config set-base-url <url>');
    const viaServer = await postServerConfig(port, { baseUrl: url });
    if (!viaServer) saveConfig({ baseUrl: url });
    console.log(`网关地址已设置为 ${url.replace(/\/+$/, '')}`);
    return;
  }

  if (sub === 'set-key') {
    const key = args[2];
    if (!key) throw new Error('用法：volc-usage config set-key <key>');
    const viaServer = await postServerConfig(port, { apiKey: key });
    if (!viaServer) saveConfig({ apiKey: key });
    console.log(`API Key 已保存（****${keyHint(key)}）`);
    return;
  }

  if (sub === 'clear-key') {
    const viaServer = await postServerConfig(port, { clearApiKey: true });
    if (!viaServer) saveConfig({ apiKey: null });
    console.log('已清除网页配置的 API Key，将回退到环境变量或 OpenCode 配置');
    return;
  }

  if (sub === 'set-limit') {
    const value = Number(args[2]);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error('用法：volc-usage config set-limit <正数>');
    }
    const viaServer = await postServerConfig(port, { dailyCreditLimit: value });
    if (!viaServer) saveConfig({ dailyCreditLimit: value });
    console.log(`每日额度已设置为 ${value} credit`);
    return;
  }

  if (sub === 'set-notify') {
    const value = args[2];
    if (!['on', 'off'].includes(value)) {
      throw new Error('用法：volc-usage config set-notify on|off');
    }
    const enabled = value === 'on';
    const viaServer = await postServerConfig(port, { notify: enabled });
    if (!viaServer) saveConfig({ notify: enabled });
    console.log(`通知已${enabled ? '开启' : '关闭'}`);
    return;
  }

  if (sub === 'set-webhook') {
    const url = args[2];
    if (!url) {
      throw new Error('用法：volc-usage config set-webhook <url> [format] [secret]');
    }
    const format = args[3] ?? 'auto';
    const secret = args[4] ?? '';
    const viaServer = await postServerConfig(port, {
      webhookUrl: url,
      webhookFormat: format,
      webhookSecret: secret,
    });
    if (!viaServer) {
      saveConfig({ webhook: { url, format, secret } });
    }
    const saved = viaServer ?? loadConfig();
    const info = webhookInfo(saved.webhook);
    console.log(`Webhook 已保存（${info.format} · ${info.hint}）`);
    return;
  }

  if (sub === 'clear-webhook') {
    const viaServer = await postServerConfig(port, { clearWebhook: true });
    if (!viaServer) saveConfig({ webhook: null });
    console.log('已清除 Webhook 配置');
    return;
  }

  if (sub === 'test-notify') {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/notify-test`, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
      console.log(`测试通知已发送（渠道：${json.channel}）`);
      return;
    } catch (error) {
      if (error.name === 'TimeoutError' || error.code === 'ECONNREFUSED') {
        console.log('本地服务未运行；请先启动服务，或在网页设置里发送测试通知');
        return;
      }
      throw error;
    }
  }

  throw new Error(
    '用法：volc-usage config [show|set-base-url <url>|set-key <key>|clear-key|set-limit <n>|' +
      'set-notify on|off|set-webhook <url> [format] [secret]|clear-webhook|test-notify]',
  );
}

async function handleDataCommand(command, config) {
  if (command === 'watch') {
    let running = true;
    process.on('SIGINT', () => {
      running = false;
      console.log('');
      process.exit(0);
    });

    while (running) {
      process.stdout.write('\x1b[2J\x1b[H');
      try {
        const { state, source } = await getState(config);
        if (!state || state.needsSetup) {
          setupMessage();
        } else {
          printToday(state);
          console.log(
            dim(
              `\n数据源：${source === 'server' ? '本地服务快照' : '网关直连'} · 每 30 秒刷新 · Ctrl+C 退出`,
            ),
          );
        }
      } catch (error) {
        console.log(red(`刷新失败：${error.message}`));
        console.log(dim('每 30 秒重试，Ctrl+C 退出'));
      }
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
    return;
  }

  const { state, source } = await getState(config);
  if (!state || state.needsSetup) {
    setupMessage();
    process.exitCode = 1;
    return;
  }

  if (command === 'today') printToday(state);
  else if (command === 'week') printWindow(state, 'week');
  else if (command === 'month') printWindow(state, 'month');

  if (source === 'live') {
    console.log(dim('\n数据源：网关直连（本地服务未运行，未写入历史库）'));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'today';

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`用法：
  volc-usage today              今日额度与模型明细
  volc-usage week               本周每日用量
  volc-usage month              本月每日用量
  volc-usage watch              终端实时刷新
  volc-usage config show        查看配置
  volc-usage config set-base-url <url>  设置网关地址
  volc-usage config set-key K   设置 API Key
  volc-usage config clear-key   清除网页配置的 Key
  volc-usage config set-limit N 设置每日额度
  volc-usage config set-notify on|off
  volc-usage config set-webhook <url> [format] [secret]
  volc-usage config clear-webhook
  volc-usage config test-notify`);
    return;
  }

  const config = loadConfig();

  if (command === 'config') {
    await handleConfigCommand(args, config);
    return;
  }

  if (!['today', 'week', 'month', 'watch'].includes(command)) {
    throw new Error(`未知命令：${command}（用 volc-usage --help 查看用法）`);
  }

  await handleDataCommand(command, config);
}

main().catch((error) => {
  console.error(red(`错误：${error.message}`));
  process.exit(1);
});
