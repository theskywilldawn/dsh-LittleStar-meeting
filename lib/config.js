/**
 * 星辰会议室 —— 可调参数的读写。
 *
 * 两个来源，**文件优先**：
 *   1. DSH 的插件配置（`cordis.patch.yml` 里 `- id: xiaoxingchen-meeting` 的 config）—— 当默认值；
 *   2. `$dir/config.json` —— 设置卡片里改的就是它。**热读**（按 mtime 判缓存），
 *      所以改完下一步生效，不用重启，也不会让谁缓存住旧值。
 *
 * 白名单：只有 `EDITABLE_KEYS` 里的键允许从面板改。**`dir` 和 `archiveFile` 不在其中** ——
 * 那两条是"插件数据放哪"，写错会把房间/纪要写到别处去。
 *
 * `minutesDir` 是个例外，但它是**受控的例外**：哥哥 2026-10-14 明确要"纪要路径选择框"，
 * 所以放它进来，但只收**绝对路径**（相对路径、空串一律拒），并且只往那里写 `.md` 纪要，
 * 不会去动那个目录里别的任何东西。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { atomicWriteJson } from './util.js';

/** 允许在设置卡片里改的键。 */
export const EDITABLE_KEYS = [
  'consoleLog',        // 打到标准输出
  'consoleWindow',     // 开房时弹出会场实况
  'defaultRounds',     // meeting_open 不传 rounds 时用几轮
  'speechLimitChars',  // 单次发言的软长度上限（写进会议要求，不硬截断）
  'contextRecentCount',// 投递给成员时带最近几条发言（0 = 只给议题，不给历史）
  'liveMode',          // 会场实况用什么看：web / cmd / none
  'minutesEnabled',    // 收会时是否生成纪要
  'minutesDir',        // 纪要写到哪个目录（空 = 插件自己的 minutes/）
];

/** 没有配置时的默认值 —— 默认开"看得见"的那一档。 */
export const DEFAULTS = {
  consoleLog: true,
  consoleWindow: true,
  defaultRounds: 2,
  speechLimitChars: 800,
  contextRecentCount: 3,
  liveMode: 'web',
  minutesEnabled: true,
  minutesDir: '',
};

export const MAX_ROUNDS_LIMIT = 20;
export const SPEECH_LIMIT_MIN = 100;
export const SPEECH_LIMIT_MAX = 5000;
export const RECENT_COUNT_MAX = 20;
export const LIVE_MODES = ['web', 'cmd', 'none'];

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeValue(key, value) {
  if (key === 'consoleLog' || key === 'consoleWindow' || key === 'minutesEnabled') {
    return typeof value === 'boolean' ? value : undefined;
  }
  if (key === 'defaultRounds') return clampInt(value, 1, MAX_ROUNDS_LIMIT);
  if (key === 'speechLimitChars') return clampInt(value, SPEECH_LIMIT_MIN, SPEECH_LIMIT_MAX);
  if (key === 'contextRecentCount') return clampInt(value, 0, RECENT_COUNT_MAX);
  if (key === 'liveMode') {
    const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return LIVE_MODES.includes(mode) ? mode : undefined;
  }
  if (key === 'minutesDir') {
    if (typeof value !== 'string') return undefined;
    const dir = value.trim();
    if (dir === '') return '';              // 显式清空 = 回到插件自己的目录
    return isAbsolute(dir) ? dir : undefined;
  }
  return undefined;
}

/**
 * @param {string} file 配置文件路径（$dir/config.json）
 * @param {{base?: object, now?: () => number}} [options] base = DSH 插件配置，作为默认值层
 */
export function createConfigStore(file, { base = {}, now = Date.now } = {}) {
  let cache = { at: 0, mtime: -1, values: {} };

  function readFileValues() {
    let mtime = -1;
    try { mtime = existsSync(file) ? statSync(file).mtimeMs : -1; } catch { mtime = -1; }
    if (cache.at !== 0 && cache.mtime === mtime) return cache.values;

    let values = {};
    if (mtime >= 0) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        for (const key of EDITABLE_KEYS) {
          const v = normalizeValue(key, raw?.[key]);
          if (v !== undefined) values[key] = v;
        }
      } catch {
        // 文件坏了就落回默认值 —— 绝不因为一份配置把会议功能拖垮
        values = {};
      }
    }
    cache = { at: now(), mtime, values };
    return values;
  }

  /** 当前**有效**配置：默认值 → DSH 插件配置 → config.json。 */
  function get() {
    const fromBase = {};
    for (const key of EDITABLE_KEYS) {
      const v = normalizeValue(key, base?.[key]);
      if (v !== undefined) fromBase[key] = v;
    }
    return { ...DEFAULTS, ...fromBase, ...readFileValues() };
  }

  /** 只写白名单里的键，返回真正落盘的与被拒的。 */
  function set(patch) {
    const current = { ...readFileValues() };
    const applied = {};
    const rejected = [];
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!EDITABLE_KEYS.includes(key)) { rejected.push(key); continue; }
      const v = normalizeValue(key, value);
      if (v === undefined) { rejected.push(key); continue; }
      current[key] = v;
      applied[key] = v;
    }
    if (Object.keys(applied).length > 0) atomicWriteJson(file, current);
    cache = { at: 0, mtime: -1, values: {} };   // 下次读必定重取
    return { applied, rejected, values: get() };
  }

  return Object.freeze({ file, get, set, editableKeys: EDITABLE_KEYS });
}
