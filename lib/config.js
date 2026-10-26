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
 * `minutesDir` 是个例外，但它是**受控的例外**：用户 2026-10-14 明确要"纪要路径选择框"，
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
  'speakReport',       // 工具返回值粒度：full 回显全文 / brief 只回一行（省法官上下文）
  'admit',             // 参会准入：allow / deny 两组正则（见 lib/admit.js）
  'humanWaitSeconds',  // 轮到真人说话/私聊他时最多等多久（秒）
  'fontScale',         // 页面字号缩放（1 = 出厂的大字号档）
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
  speakReport: 'full',
  admit: null,          // null = 用 lib/admit.js 里的出厂规则（禁微信端 / QQ 群）
  // 真人席位的等待上限。**默认 10 分钟**（2026-10-19 哥哥实测：小星辰几秒就能读完的发言，
  // 他要「阅读一秒一行 + 思考 + 打字」，300 秒只够刚好赶上）。他打字慢、还要边看边记，
  // 别按 AI 的节奏给他定时 —— 这是真人唯一会卡住全场的地方。
  humanWaitSeconds: 600,
  // 页面字号缩放。**出厂就已经调大过一轮**（2026-10-20 哥哥：「UI 字体和聊天字体不够大」），
  // 所以 1 不是"原始大小"，而是"已经放大过的默认档"；设置卡片里还能再往上调。
  fontScale: 1,
};

export const HUMAN_WAIT_MIN = 60;
export const HUMAN_WAIT_MAX = 3600;
export const FONT_SCALE_MIN = 0.85;
export const FONT_SCALE_MAX = 1.6;

export const MAX_ROUNDS_LIMIT = 20;
export const SPEECH_LIMIT_MIN = 100;
export const SPEECH_LIMIT_MAX = 5000;
export const RECENT_COUNT_MAX = 20;
export const LIVE_MODES = ['web', 'cmd', 'none'];
export const REPORT_MODES = ['full', 'brief'];

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
  if (key === 'humanWaitSeconds') return clampInt(value, HUMAN_WAIT_MIN, HUMAN_WAIT_MAX);
  if (key === 'fontScale') {
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    // 取两位小数：1.05 / 1.15 这种，避免浮点尾巴
    return Math.round(Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, n)) * 100) / 100;
  }
  if (key === 'liveMode') {
    const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return LIVE_MODES.includes(mode) ? mode : undefined;
  }
  if (key === 'speakReport') {
    const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return REPORT_MODES.includes(mode) ? mode : undefined;
  }
  if (key === 'minutesDir') {
    if (typeof value !== 'string') return undefined;
    const dir = value.trim();
    if (dir === '') return '';              // 显式清空 = 回到插件自己的目录
    return isAbsolute(dir) ? dir : undefined;
  }
  if (key === 'admit') {
    if (value === null) return null;        // 显式清空 = 回到出厂准入规则
    if (typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out = {};
    for (const side of ['allow', 'deny']) {
      if (value[side] === undefined) continue;
      if (!Array.isArray(value[side])) return undefined;
      out[side] = value[side].filter((s) => typeof s === 'string' && s.trim() !== '');
    }
    return Object.keys(out).length > 0 ? out : undefined;
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
