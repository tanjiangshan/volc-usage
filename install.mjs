#!/usr/bin/env node
/**
 * 跨平台一键安装：注册开机自启、启动服务、打开仪表盘。
 *
 *   node install.mjs              安装并启动
 *   node install.mjs uninstall    停止并移除自启动（保留配置和历史）
 *   node install.mjs uninstall --purge  连配置和历史一起删除
 *   node install.mjs --no-browser 安装但不打开浏览器
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig, resolveApiKey, configPath, configDir, dataDir } from './lib/config.mjs';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const serverFile = path.join(projectDir, 'server.mjs');
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith('-')) ?? 'install';
const uninstall = command === 'uninstall';
const purge = args.includes('--purge');
const noStart = args.includes('--no-start');
const noBrowser = args.includes('--no-browser');
const pidFile = path.join(dataDir(), 'volc-usage.pid');
const logsDir = path.join(dataDir(), 'logs');
const logFile = path.join(logsDir, 'server.log');
const SERVICE_NAME = 'volc-usage';
const MAC_LABEL = 'com.volc-usage.dashboard';

const log = (message = '') => console.log(message);

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function run(commandName, commandArgs, options = {}) {
  const result = spawnSync(commandName, commandArgs, {
    stdio: options.quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    ...options,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopRunning() {
  const pid = readPid();
  if (!pid) return false;
  if (isWindows) {
    run('taskkill', ['/PID', String(pid), '/F'], { quiet: true });
  } else if (processAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // ignore
  }
  return true;
}

function startDetached() {
  fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [serverFile], {
    cwd: projectDir,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
    windowsHide: true,
  });
  child.unref();
  try {
    fs.closeSync(fd);
  } catch {
    // ignore
  }
}

async function waitForHealth(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return true;
    } catch {
      // 服务还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function openBrowser(url) {
  let commandName;
  let commandArgs;
  if (isWindows) {
    commandName = 'cmd';
    commandArgs = ['/c', 'start', '', url];
  } else if (isMac) {
    commandName = 'open';
    commandArgs = [url];
  } else {
    commandName = 'xdg-open';
    commandArgs = [url];
  }
  try {
    const child = spawn(commandName, commandArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // 无桌面环境时忽略
  }
}

// ---------------------------------------------------------------- Linux

function linuxUnitPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
}

function installLinux() {
  const unitPath = linuxUnitPath();
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });

  const unit = `[Unit]
Description=火山AI网关每日 credit 仪表盘
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${projectDir}
ExecStart="${process.execPath}" "${serverFile}"
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(unitPath, unit, 'utf8');
  log(`✓ 已写入 systemd 用户服务：${unitPath}`);

  const hasSystemd = run('systemctl', ['--user', 'show-environment'], { quiet: true });
  if (!hasSystemd.ok) {
    log('! 当前环境没有可用的 systemd 用户实例，改为直接后台启动（重启后需手动运行 setup）');
    if (!noStart) startDetached();
    return { autoStart: '无（直接后台运行）' };
  }

  run('systemctl', ['--user', 'daemon-reload'], { quiet: true });
  const enabled = run('systemctl', ['--user', 'enable', SERVICE_NAME], { quiet: true });
  if (!enabled.ok) fail(`systemctl enable 失败：${enabled.stderr || enabled.stdout}`);

  if (!noStart) {
    const restarted = run('systemctl', ['--user', 'restart', SERVICE_NAME], { quiet: true });
    if (!restarted.ok) {
      log(`! systemctl restart 失败，尝试直接启动：${restarted.stderr || restarted.stdout}`);
      startDetached();
    }
  }

  return { autoStart: 'systemd 用户服务（登录后自动启动）' };
}

function uninstallLinux() {
  const unitPath = linuxUnitPath();
  const hasSystemd = run('systemctl', ['--user', 'show-environment'], { quiet: true }).ok;
  if (hasSystemd) {
    run('systemctl', ['--user', 'disable', '--now', SERVICE_NAME], { quiet: true });
  }
  try {
    fs.unlinkSync(unitPath);
    log(`✓ 已移除 ${unitPath}`);
  } catch {
    // 不存在
  }
  if (hasSystemd) run('systemctl', ['--user', 'daemon-reload'], { quiet: true });
  stopRunning();
}

// ---------------------------------------------------------------- macOS

function macPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
}

function installMac() {
  fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  const plistPath = macPlistPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(serverFile)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(projectDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logFile)}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist, 'utf8');
  log(`✓ 已写入 launchd 配置：${plistPath}`);

  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  run('launchctl', ['bootout', `gui/${uid}`, plistPath], { quiet: true });

  if (!noStart) {
    const bootstrapped = run('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { quiet: true });
    if (!bootstrapped.ok) {
      const loaded = run('launchctl', ['load', '-w', plistPath], { quiet: true });
      if (!loaded.ok) {
        log(`! launchd 启动失败，改为直接后台启动：${bootstrapped.stderr || loaded.stderr}`);
        startDetached();
      }
    }
  }

  return { autoStart: 'launchd 登录项（登录后自动启动）' };
}

function uninstallMac() {
  const plistPath = macPlistPath();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  run('launchctl', ['bootout', `gui/${uid}`, plistPath], { quiet: true });
  run('launchctl', ['unload', '-w', plistPath], { quiet: true });
  try {
    fs.unlinkSync(plistPath);
    log(`✓ 已移除 ${plistPath}`);
  } catch {
    // 不存在
  }
  stopRunning();
}

// ---------------------------------------------------------------- Windows

function windowsStartupDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function writeWindowsScripts() {
  fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  const startCmd = path.join(projectDir, 'start.cmd');
  const stopCmd = path.join(projectDir, 'stop.cmd');
  const vbsPath = path.join(windowsStartupDir(), `${SERVICE_NAME}.vbs`);

  const startContent = [
    '@echo off',
    'chcp 65001 >nul',
    `cd /d "${projectDir}"`,
    `"${process.execPath}" "${serverFile}" >> "${logFile}" 2>&1`,
    '',
  ].join('\r\n');

  const stopContent = [
    '@echo off',
    'chcp 65001 >nul',
    `set "PIDFILE=${pidFile}"`,
    'if not exist "%PIDFILE%" goto notrunning',
    'set /p PID=<"%PIDFILE%"',
    'if "%PID%"=="" goto notrunning',
    'taskkill /PID %PID% /F >nul 2>&1',
    'echo 已停止 volc-usage',
    'del "%PIDFILE%" >nul 2>&1',
    'goto end',
    ':notrunning',
    'echo volc-usage 未运行',
    ':end',
    'pause',
    '',
  ].join('\r\n');

  // 启动项用 wscript 隐藏窗口运行 start.cmd。
  const vbsContent = [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${startCmd.replace(/"/g, '""')}""", 0, False`,
    '',
  ].join('\r\n');

  fs.writeFileSync(startCmd, startContent, 'utf8');
  fs.writeFileSync(stopCmd, stopContent, 'utf8');
  fs.mkdirSync(path.dirname(vbsPath), { recursive: true });
  fs.writeFileSync(vbsPath, vbsContent, 'utf8');

  return { startCmd, stopCmd, vbsPath };
}

function installWindows() {
  const { startCmd, stopCmd, vbsPath } = writeWindowsScripts();
  log(`✓ 已写入启动脚本：${startCmd}`);
  log(`✓ 已写入停止脚本：${stopCmd}`);
  log(`✓ 已加入开机启动：${vbsPath}`);

  if (!noStart) {
    stopRunning();
    const wscript = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe');
    const launcher = fs.existsSync(wscript) ? wscript : 'wscript.exe';
    spawn(launcher, [vbsPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  }

  return { autoStart: 'Windows 启动文件夹（登录后自动启动）' };
}

function uninstallWindows() {
  const vbsPath = path.join(windowsStartupDir(), `${SERVICE_NAME}.vbs`);
  try {
    fs.unlinkSync(vbsPath);
    log(`✓ 已移除 ${vbsPath}`);
  } catch {
    // 不存在
  }
  stopRunning();
  for (const name of ['start.cmd', 'stop.cmd']) {
    try {
      fs.unlinkSync(path.join(projectDir, name));
    } catch {
      // 不存在
    }
  }
}

// ---------------------------------------------------------------- 入口

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) {
    fail(
      `需要 Node.js 24 或更高版本，当前是 ${process.version}。\n` +
        '请运行 setup.sh / setup.command / setup.cmd，它会自动下载便携版 Node。',
    );
  }
}

function purgeAll() {
  const dirs = [configDir(), dataDir()];
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      log(`✓ 已删除 ${dir}`);
    } catch (error) {
      log(`! 删除 ${dir} 失败：${error.message}`);
    }
  }
}

async function main() {
  checkNode();

  if (uninstall) {
    log(`正在卸载 volc-usage${purge ? '（含配置和历史）' : ''}…`);
    if (isLinux) uninstallLinux();
    else if (isMac) uninstallMac();
    else if (isWindows) uninstallWindows();
    else fail('暂不支持当前操作系统');

    if (purge) purgeAll();
    log('');
    log('✔ 已停止并移除开机自启。');
    if (!purge) {
      log(`  配置和历史仍保留在：${configDir()} 、 ${dataDir()}`);
      log('  如需彻底删除，重新运行：node install.mjs uninstall --purge');
    }
    return;
  }

  if (!isLinux && !isMac && !isWindows) {
    fail('暂不支持当前操作系统，可手动运行：node server.mjs');
  }

  const config = loadConfig();
  const url = `http://${config.host}:${config.port}`;

  let result;
  if (isLinux) result = installLinux();
  else if (isMac) result = installMac();
  else result = installWindows();

  const healthy = await waitForHealth(url);
  const keyInfo = resolveApiKey({ rawConfig: config.raw });

  log('');
  log('✔ 安装完成');
  log(`  仪表盘：${url}`);
  log(`  Node：${process.execPath}`);
  log(`  自启动：${result.autoStart}`);
  log(`  配置文件：${configPath()}`);
  log(`  日志：${isLinux ? 'journalctl --user -u volc-usage -f' : logFile}`);
  if (isLinux) {
    const linger = run('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger'], {
      quiet: true,
    });
    if (!/Linger=yes/.test(linger.stdout)) {
      log('');
      log('  提示：注销登录后仍要常驻，请执行一次（需要 sudo 密码）：');
      log(`    sudo loginctl enable-linger ${os.userInfo().username}`);
    }
  }

  if (!healthy) {
    log('');
    log('! 服务还没有响应，可能仍在启动。请稍后打开上面的地址，或查看日志。');
  } else if (!keyInfo.apiKey) {
    log('');
    log('  首次使用：浏览器打开后粘贴火山AI网关 API Key 即可。');
  }

  if (!noBrowser && healthy) openBrowser(url);
  else if (!noBrowser) log(`  请手动打开：${url}`);
}

main().catch((error) => fail(error.message));
