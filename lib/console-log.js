/**
 * 星辰会议室 —— 会议实况输出。
 *
 * 用户要的是「看到会议的对话内容」，所以这里做四层：
 *   1. `console.log` —— 如果 DSH 是从终端起的，直接就能看到；
 *   2. 追加写一份实时日志（`live/<房间号>.log`）—— 可以 tail、可以事后翻；
 *   3. 弹一个**可见的控制台窗口**跟随那份日志（旧版做法，排版差，留作备用）；
 *   4. 用系统默认浏览器打开**会场实况网页**（`liveMode: 'web'`，现在的默认）——
 *      同一份数据渲染成 QQ 群样式的只读页面，见 `lib/live.js`。
 *
 * 第 3 步为什么不用直接 spawn：DSH 是 Electron 进程，自己没有控制台，子进程没有
 * 终端可继承。只有 `cmd /c start "" cmd /k ...` 会显式要求一个新控制台。
 *
 * 窗口标题通过环境变量传（`MTG_TITLE`），不写进任何脚本文件 —— 脚本一律纯 ASCII，
 * 免得中文在 cmd / Windows PowerShell 的默认代码页下变成乱码。
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fmtClock } from './util.js';

/** 跟随日志的 PowerShell（纯 ASCII；标题与中文都从外部进来）。 */
const WATCH_PS1 = [
  'param([Parameter(Mandatory=$true)][string]$LogPath)',
  "$ErrorActionPreference = 'SilentlyContinue'",
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
  'if ($env:MTG_TITLE) { try { $Host.UI.RawUI.WindowTitle = $env:MTG_TITLE } catch {} }',
  'if (-not (Test-Path -LiteralPath $LogPath)) { New-Item -ItemType File -Path $LogPath -Force | Out-Null }',
  'Get-Content -LiteralPath $LogPath -Wait -Encoding UTF8',
  '',
].join('\n');

/** 启动器（纯 ASCII）：切到 UTF-8 代码页，再把跟随脚本拉起来。 */
const WATCH_CMD = [
  '@echo off',
  'chcp 65001 >nul',
  'powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0watch.ps1" "%~1"',
  '',
].join('\r\n');

/** 允许传布尔值，也允许传返回布尔值的函数 —— 后者每次求值，配置改完立刻算数。 */
const flag = (v) => (typeof v === 'function' ? v() !== false : v !== false);

export function createMeetingConsole({
  dir,
  enabled = true,
  windowEnabled = true,
  logger = console,
} = {}) {
  const liveDir = join(dir, 'live');
  const scriptDir = join(dir, 'watch');

  const logFile = (roomId) => join(liveDir, `${roomId}.log`);

  let scriptsReady = false;
  function ensureScripts() {
    const ps1 = join(scriptDir, 'watch.ps1');
    const cmd = join(scriptDir, 'watch.cmd');
    if (scriptsReady && existsSync(ps1) && existsSync(cmd)) return;
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(ps1, WATCH_PS1, 'utf8');
    writeFileSync(cmd, WATCH_CMD, 'utf8');
    scriptsReady = true;
  }

  function ensureLiveDir() {
    mkdirSync(liveDir, { recursive: true });
  }

  /** 原样写一行（不带时间戳）：正文、发言、纪要都用它。 */
  function emit(roomId, text) {
    const body = String(text ?? '');
    if (!body) return;
    if (typeof logger?.log === 'function') {
      logger.log(`[星辰会议室 ${roomId}] ${body}`);
    }
    if (!flag(enabled)) return;
    try {
      ensureLiveDir();
      appendFileSync(logFile(roomId), `${body}\n`, 'utf8');
    } catch {
      /* 写不进日志不该影响会议本身 */
    }
  }

  /** 带时间戳的一行：过程事件用。 */
  function note(roomId, text) {
    emit(roomId, `[${fmtClock(Date.now())}] ${text}`);
  }

  /** 空行分隔。 */
  function gap(roomId) {
    emit(roomId, '');
  }

  /**
   * 弹一个跟随这场会议日志的可见控制台窗口。
   * @returns {{opened: boolean, logPath?: string, pid?: number|null, reason?: string}}
   */
  function openWindow(roomId, title) {
    if (!flag(windowEnabled)) return { opened: false, reason: '窗口输出已在配置里关掉' };
    try {
      ensureScripts();
      ensureLiveDir();
      const log = logFile(roomId);
      if (!existsSync(log)) writeFileSync(log, '', 'utf8');
      const child = spawn('cmd.exe', [
        '/c', 'start', '',
        'cmd.exe', '/k', join(scriptDir, 'watch.cmd'), log,
      ], {
        env: { ...process.env, MTG_TITLE: String(title ?? '星辰会议室').slice(0, 80) },
        windowsHide: false,
        stdio: 'ignore',
        detached: false,
      });
      child.unref?.();
      return { opened: true, logPath: log, pid: child.pid ?? null };
    } catch (error) {
      return { opened: false, reason: error?.message ?? String(error) };
    }
  }

  /**
   * 用系统默认浏览器打开一个网址。
   *
   * `cmd /c start "" <url>` 走的是 Windows 的协议关联，等于双击一个 http 链接。
   * Electron 主进程没有把 `shell.openExternal` 暴露给我们，这是等价且不依赖任何
   * DSH 内部服务的一条路。
   *
   * **只放行回环 http**：这个地址是拼出来的（端口可能是探测来的），多一道形状校验，
   * 就不会有"万一拼错把什么奇怪东西交给 start"的机会。
   */
  function openUrl(url) {
    const target = String(url ?? '').trim();
    if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#\[\]]*$/.test(target)) {
      return { opened: false, reason: `地址形状不合法，拒绝打开: ${target}` };
    }
    try {
      const child = spawn('cmd.exe', ['/c', 'start', '', target], {
        windowsHide: true,
        stdio: 'ignore',
        detached: false,
      });
      child.unref?.();
      return { opened: true, url: target, pid: child.pid ?? null };
    } catch (error) {
      return { opened: false, reason: error?.message ?? String(error) };
    }
  }

  return Object.freeze({
    enabled: flag(enabled),
    windowEnabled: flag(windowEnabled),
    emit,
    note,
    gap,
    openWindow,
    openUrl,
    logFile,
    liveDir,
  });
}
