import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  stripJsonc,
  parseJsonc,
  readOpencodeGatewayKey,
  readOpencodeGatewaySettings,
  resolveApiKey,
  loadConfig,
  saveConfig,
  readRawConfig,
  normalizeBaseUrl,
} from '../lib/config.mjs';

test('stripJsonc keeps URLs and removes comments/trailing commas', () => {
  const source = `{
    // 注释
    "baseURL": "https://example.com/v1", /* 块注释 */
    "list": [1, 2, 3,],
    "text": "a, } b",
  }`;
  const parsed = parseJsonc(source);
  assert.equal(parsed.baseURL, 'https://example.com/v1');
  assert.deepEqual(parsed.list, [1, 2, 3]);
  assert.equal(parsed.text, 'a, } b');
});

test('stripJsonc handles escaped quotes', () => {
  const parsed = parseJsonc('{"x":"a\\"//b","y":1}');
  assert.equal(parsed.x, 'a"//b');
  assert.equal(parsed.y, 1);
});

test('readOpencodeGatewayKey finds the 火山AI网关 provider', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volc-usage-config-'));
  const file = path.join(dir, 'opencode.jsonc');
  fs.writeFileSync(
    file,
    `{
      "providers": {
        "火山AI网关": {
          "name": "火山AI网关",
          "settings": {
            "baseURL": "https://demo-gateway.apigateway-cn-beijing.volceapi.com/v1",
            "apiKey": "key-from-opencode"
          }
        }
      }
    }`,
  );
  assert.equal(readOpencodeGatewayKey(file), 'key-from-opencode');
  assert.deepEqual(readOpencodeGatewaySettings(file), {
    apiKey: 'key-from-opencode',
    baseUrl: 'https://demo-gateway.apigateway-cn-beijing.volceapi.com/v1',
  });
});

test('normalizeBaseUrl trims and removes trailing slashes', () => {
  assert.equal(normalizeBaseUrl(' https://x.example.com/v1/ '), 'https://x.example.com/v1');
  assert.equal(normalizeBaseUrl(''), '');
  assert.equal(normalizeBaseUrl(null), '');
});

test('resolveApiKey follows env > config > opencode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volc-usage-config-'));
  const file = path.join(dir, 'opencode.jsonc');
  fs.writeFileSync(
    file,
    '{"providers":{"火山AI网关":{"settings":{"apiKey":"opencode-key"}}}}',
  );

  assert.deepEqual(
    resolveApiKey({
      env: { VOLC_GATEWAY_API_KEY: 'env-key' },
      rawConfig: { apiKey: 'config-key' },
      opencodeFile: file,
    }),
    { apiKey: 'env-key', source: 'env' },
  );

  assert.deepEqual(
    resolveApiKey({ env: {}, rawConfig: { apiKey: 'config-key' }, opencodeFile: file }),
    { apiKey: 'config-key', source: 'config' },
  );

  assert.deepEqual(
    resolveApiKey({ env: {}, rawConfig: {}, opencodeFile: file }),
    { apiKey: 'opencode-key', source: 'opencode' },
  );

  assert.deepEqual(resolveApiKey({ env: {}, rawConfig: {}, opencodeFile: '/nonexistent' }), {
    apiKey: null,
    source: null,
  });
});

test('saveConfig writes 0600 and can delete apiKey', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volc-usage-config-'));
  const old = process.env.VOLC_USAGE_CONFIG_DIR;
  process.env.VOLC_USAGE_CONFIG_DIR = dir;
  try {
    saveConfig({ apiKey: 'secret-key', dailyCreditLimit: 180 });
    const file = path.join(dir, 'config.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readRawConfig(file), {
      apiKey: 'secret-key',
      dailyCreditLimit: 180,
    });

    saveConfig({ apiKey: null });
    assert.deepEqual(readRawConfig(file), { dailyCreditLimit: 180 });
  } finally {
    if (old === undefined) delete process.env.VOLC_USAGE_CONFIG_DIR;
    else process.env.VOLC_USAGE_CONFIG_DIR = old;
  }
});

test('loadConfig merges defaults and validates values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volc-usage-config-'));
  const old = process.env.VOLC_USAGE_CONFIG_DIR;
  const oldPort = process.env.VOLC_USAGE_PORT;
  const oldBase = process.env.VOLC_GATEWAY_BASE_URL;
  const oldOpencode = process.env.OPENCODE_CONFIG;
  process.env.VOLC_USAGE_CONFIG_DIR = dir;
  process.env.OPENCODE_CONFIG = path.join(dir, 'missing-opencode.jsonc');
  delete process.env.VOLC_USAGE_PORT;
  delete process.env.VOLC_GATEWAY_BASE_URL;
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      baseUrl: 'https://gateway.example.com/v1/',
      dailyCreditLimit: 200,
      thresholds: [80, 20, 40, 40],
    }),
  );
  try {
    const config = loadConfig();
    assert.equal(config.baseUrl, 'https://gateway.example.com/v1');
    assert.equal(config.dailyCreditLimit, 200);
    assert.deepEqual(config.thresholds, [20, 40, 80]);
    assert.equal(config.port, 8788);
    assert.equal(config.notify, true);
  } finally {
    if (old === undefined) delete process.env.VOLC_USAGE_CONFIG_DIR;
    else process.env.VOLC_USAGE_CONFIG_DIR = old;
    if (oldPort === undefined) delete process.env.VOLC_USAGE_PORT;
    else process.env.VOLC_USAGE_PORT = oldPort;
    if (oldBase === undefined) delete process.env.VOLC_GATEWAY_BASE_URL;
    else process.env.VOLC_GATEWAY_BASE_URL = oldBase;
    if (oldOpencode === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = oldOpencode;
  }
});

test('baseUrl priority is env > config > opencode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volc-usage-config-'));
  const oldDir = process.env.VOLC_USAGE_CONFIG_DIR;
  const oldBase = process.env.VOLC_GATEWAY_BASE_URL;
  const oldOpencode = process.env.OPENCODE_CONFIG;
  const opencodeFile = path.join(dir, 'opencode.jsonc');
  process.env.VOLC_USAGE_CONFIG_DIR = dir;
  delete process.env.VOLC_GATEWAY_BASE_URL;
  process.env.OPENCODE_CONFIG = opencodeFile;
  fs.writeFileSync(
    opencodeFile,
    '{"providers":{"火山AI网关":{"settings":{"baseURL":"https://opencode.example.com/v1","apiKey":"k"}}}}',
  );
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
    assert.equal(loadConfig().baseUrl, 'https://opencode.example.com/v1');

    saveConfig({ baseUrl: 'https://config.example.com/v1' });
    assert.equal(loadConfig().baseUrl, 'https://config.example.com/v1');

    process.env.VOLC_GATEWAY_BASE_URL = 'https://env.example.com/v1';
    assert.equal(loadConfig().baseUrl, 'https://env.example.com/v1');
  } finally {
    if (oldDir === undefined) delete process.env.VOLC_USAGE_CONFIG_DIR;
    else process.env.VOLC_USAGE_CONFIG_DIR = oldDir;
    if (oldBase === undefined) delete process.env.VOLC_GATEWAY_BASE_URL;
    else process.env.VOLC_GATEWAY_BASE_URL = oldBase;
    if (oldOpencode === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = oldOpencode;
  }
});
