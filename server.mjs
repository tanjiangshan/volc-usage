import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, dbPath, dataDir, keyHint } from './lib/config.mjs';
import { Runtime, ValidationError } from './lib/runtime.mjs';
import { AuthError, HttpError } from './lib/gateway.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.0';
const BODY_LIMIT = 32 * 1024;
const pidFile = path.join(dataDir(), 'volc-usage.pid');

function writePidFile() {
  try {
    fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(pidFile, String(process.pid));
  } catch (error) {
    console.warn(`无法写入 PID 文件：${error.message}`);
  }
}

function removePidFile() {
  try {
    if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(pidFile);
    }
  } catch {
    // 文件不存在或无可写权限时忽略
  }
}

function log(message) {
  const time = new Date().toISOString();
  console.log(`[${time}] ${message}`);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

function sendText(res, status, body, contentType = 'text/html; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "connect-src 'self'; base-uri 'none'; form-action 'self'",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON 必须是对象');
    }
    return parsed;
  } catch (error) {
    throw Object.assign(new Error(`请求体不是合法 JSON：${error.message}`), { status: 400 });
  }
}

function errorPayload(error) {
  if (error instanceof AuthError) {
    return { status: 400, payload: { error: 'API Key 无效或未授权', detail: error.message } };
  }
  if (error instanceof ValidationError) {
    return { status: 400, payload: { error: error.message } };
  }
  if (error instanceof HttpError) {
    return { status: 502, payload: { error: '网关请求失败', detail: error.message } };
  }
  if (error?.status === 413) {
    return { status: 413, payload: { error: '请求体过大' } };
  }
  if (error?.status === 400) {
    return { status: 400, payload: { error: error.message } };
  }
  return { status: 500, payload: { error: '服务器内部错误', detail: error.message } };
}

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`配置加载失败：${error.message}`);
    process.exit(1);
  }

  let indexHtml;
  try {
    indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  } catch {
    console.error('缺少 public/index.html，无法启动网页仪表盘');
    process.exit(1);
  }

  let runtime;
  try {
    runtime = new Runtime({ config, logger: console });
  } catch (error) {
    console.error(`数据库初始化失败：${error.message}`);
    console.error(`数据库路径：${dbPath()}`);
    console.error('如果文件损坏，可先备份后删除该文件，服务会重新建立历史快照。');
    process.exit(1);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${config.host}:${config.port}`);
    const pathname = url.pathname;

    try {
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        sendText(res, 200, indexHtml);
        return;
      }

      if (req.method === 'GET' && pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'GET' && pathname === '/api/state') {
        sendJson(res, 200, runtime.snapshot());
        return;
      }

      if (req.method === 'GET' && pathname === '/api/config') {
        sendJson(res, 200, runtime.safeConfig());
        return;
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          version: VERSION,
          hasKey: runtime.hasKey,
          uptimeSec: Math.floor((Date.now() - runtime.startedAt) / 1000),
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/config') {
        const body = await readJsonBody(req);
        const safe = await runtime.updateSettings({
          apiKey: body.apiKey,
          clearApiKey: body.clearApiKey === true,
          baseUrl: body.baseUrl,
          dailyCreditLimit: body.dailyCreditLimit,
          notify: body.notify,
          webhookUrl: body.webhookUrl,
          webhookFormat: body.webhookFormat,
          webhookSecret: body.webhookSecret,
          webhookChatId: body.webhookChatId,
          clearWebhook: body.clearWebhook === true,
        });
        sendJson(res, 200, { ok: true, config: safe });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/notify-test') {
        const result = await runtime.testNotify();
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/refresh') {
        const result = await runtime.refreshAll();
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      const { status, payload } = errorPayload(error);
      if (status >= 500) log(`请求失败 ${req.method} ${pathname}: ${error.message}`);
      sendJson(res, status, payload);
    }
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`端口 ${config.port} 已被占用，请修改 config.json 里的 port 或停止占用进程`);
    } else {
      console.error(`HTTP 服务错误：${error.message}`);
    }
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    writePidFile();
    log(`火山AI网关额度仪表盘：http://${config.host}:${config.port}`);
    log(
      `API Key 来源：${runtime.keyInfo.source ?? '未配置'}` +
        (runtime.keyInfo.apiKey ? `（****${keyHint(runtime.keyInfo.apiKey)}）` : ''),
    );
    log(`每日额度：${config.dailyCreditLimit} credit；数据库：${dbPath()}`);
    runtime.start();
  });

  const shutdown = (signal) => {
    log(`收到 ${signal}，正在关闭`);
    removePidFile();
    server.close(() => {
      runtime.stop();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', removePidFile);
}

main();
