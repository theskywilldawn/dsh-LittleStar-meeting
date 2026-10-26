/**
 * 星辰会议室 —— host 半身。
 *
 * 一句话：让小星辰们跨会话开会。
 *
 * 一场会议长这样：
 *   主持人 meeting_open 开房（定议题、目标、轮次、按顺序邀请成员）
 *     → 按邀请顺序 meeting_speak 一位一位发言（每次阻塞到对方说完）
 *     → 最后一位成员发完 = 一轮结束；够轮次或达成目标就 meeting_close
 *     → 收会时生成纪要，主持人把成果提交给用户
 *
 * 它做什么：注册 meeting_* 工具、把消息投给别的会话、把别人的发言收回来、
 *   把房间与纪要落盘、提供一个只读网页。
 *
 * 它不做什么：不改任何官方包、不碰别的插件的文件、不往别人的会话日志里写东西
 *   （唯一的写入就是那次 prompt）、不接管压缩、不管记忆。
 *
 * 准入：工具全部校验"你是这间房的主持人"，而投递只发生在 room.members 名单内 ——
 *   没被邀请的会话既拿不到会议消息，也没有任何入口挤进来。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { randomUUID, randomInt } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createRoomStore, isValidRoomId, redactRoom } from './lib/store.js';
import { createRelay, SOURCE_KIND } from './lib/relay.js';
import { createInventory } from './lib/inventory.js';
import { createSealedList } from './lib/sealed.js';
import { createArchiveReader } from './lib/archive.js';
import { createMeetingConsole } from './lib/console-log.js';
import { createConfigStore, SPEECH_LIMIT_MIN, SPEECH_LIMIT_MAX } from './lib/config.js';
import { renderLiveHtml } from './lib/live.js';
import { resolveLiveUrl } from './lib/webport.js';
import { existsSync, readFileSync } from 'node:fs';
import {
  createRoom, record, logEvent, nextSpeaker, isRoundsExhausted, isHost, isMember,
  memberLabel, renderStatus, renderFullTranscript, formatSpeakingPrompt, formatWhisperPrompt,
  kickMember, activeMembers, outMembers, setRole, useSkill, renderRoleBrief,
  abortRound, setBoard, passTurn,
  ROOM_LIVE, ROOM_CLOSED, MAX_MEMBERS, MAX_ROUNDS,
} from './lib/meeting.js';
import { renderMinutes } from './lib/minutes.js';
import { normalizeAdmitPolicy, splitRoster, judgeAdmit } from './lib/admit.js';
import { renderSetupHtml, WOLF_RULES, WOLF_BOARDS } from './lib/setup/index.js';
import {
  renderSpeakOutcome, renderRoundReport, renderWhisperOutcome, renderPanelOutcome,
} from './lib/report.js';
import { atomicWriteText, fmtTime, newToken, shortId } from './lib/util.js';

export const name = 'xiaoxingchen-meeting';
// 这四个服务都要显式注入：未注入时 ctx.get(name) 拿不到（与 persona 同款结论）。
// tools 注册工具；sessions 列活跃会话；sessionController 是跨会话投递的唯一入口；
// webServer 提供只读页面。
//
// `commands` **故意不写在这里**：命令注册表在 headless / ACP 组合里可能不存在，
// 写进来会让整个插件激活失败（连工具都用不了）。它改用 `ctx.inject(['commands'])`
// 做**响应式**注入 —— 有就注册 /meeting，没有就少一个斜杠命令，别的照常。
export const inject = ['tools', 'sessions', 'sessionController', 'webServer'];

const ROUTE = '/xiaoxingchen-meeting';
/** `/meeting open` 提交给模型的那条消息用的 source kind —— 与会议投递区分开，便于事后辨认。 */
const SOURCE_KIND_COMMAND = `${SOURCE_KIND}-command`;

/** 插件版本：从自己的 package.json 读，读不到就报 0.0.0（面板上照实显示）。 */
function pluginVersion() {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const ZONE = 'Asia/Shanghai';
const ROSTER_TTL_MS = 15_000;
const DEFAULT_WAIT_S = 300;
/**
 * 真人席位单次等待上限（毫秒）。
 *
 * 2026-10-19 两次教训叠出来的数：
 *   · 第一次 300 秒，法官给了 200 → 哥哥正在打字，被跳过；
 *   · 第二次收到 120 秒，结果**更糟** —— 他的原话：「11 个小星辰白天发言完，我才刚看完
 *     第一个说了什么，这时候就已经开始计时了，等我把剩下十个人的发言看完，时间已经
 *     所剩无几。」
 *
 * 所以卡点不是打字，是**阅读**。AI 几秒发一段，人一段要读十几秒，11 段就是一整轮。
 * 300 秒是"读完 + 想清楚 + 打完字"的总量，这是他自己给的数。
 *
 * 2026-10-19 第三次反馈：**300 秒还是只够刚好**。他的原话是「我阅读一秒一行左右，阅读完
 * 还要思考、还要打字」，而且他常常一边看一边把发现的 bug 先记进输入框里防忘。
 * 结论：**别替他估**，改成配置项（`humanWaitSeconds`，默认 600 秒，上限 1 小时）。
 */
const DEFAULTS_HUMAN_WAIT_SEC = 600;

// ⚠️ 别把 `humanWaitLimitMs` 写在模块顶层 —— 它要读 `cfg`，而 `cfg` 是在 `apply()`
// 里创建的。放外面就是 `ReferenceError: cfg is not defined`，而且 `node --check`
// 抓不到（语法合法，运行时才炸）。2026-10-19 就这么把 DSH 干崩过一次。
// 它现在在 `apply()` 内部、`cfg` 下面。

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');

function hostIsLoopback(req) {
  const raw = String(req?.headers?.host || '').trim();
  if (!raw) return true;
  const host = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function denyNonLoopback(req, res) {
  if (hostIsLoopback(req)) return false;
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok: false, error: '拒绝: 只接受本机(回环地址)请求' }));
  return true;
}

export function apply(ctx, config) {
  const rootDir = typeof config?.dir === 'string' && config.dir
    ? config.dir
    : join(dshHome(), 'xiaoxingchen-meeting');
  const store = createRoomStore(rootDir);
  // 可调参数：DSH 插件配置当默认值，$dir/config.json 覆盖它 —— 设置卡片里改的就是后者。
  // createConfigStore 按 mtime 热读，所以面板上拨完开关下一步就生效，不用重启。
  const cfg = createConfigStore(join(rootDir, 'config.json'), { base: config });

  /** 真人席位单次等待上限（毫秒）。读设置项 `humanWaitSeconds`，默认 600 秒、上限 1 小时。 */
  function humanWaitLimitMs() {
    const sec = Number(cfg.get().humanWaitSeconds);
    const ms = (Number.isFinite(sec) && sec > 0 ? sec : DEFAULTS_HUMAN_WAIT_SEC) * 1000;
    return Math.max(60_000, Math.min(ms, 3_600_000));
  }

  const relay = createRelay(ctx);
  // 会话体量盘点：日志大小只影响「把历史读回来要多久」（实测 9.55 MB 也只要 298 毫秒），
  // 它**不**决定成员开不开得了口 —— 那件事由下面的归档状态决定。
  const inventory = createInventory({ sessionsRoot: join(dshHome(), 'sessions') });
  // 归档状态：DSH 自己的权威名单（$DSH_HOME/storages/workspace.json 的 archivedSessionIds）。
  // 会话一旦归档，archived-session-gate 会拒绝它的一切模型步骤：投递进去只会
  // turn/start → 几毫秒后 turn/end(reason.kind === 'blocked')，连模型请求都不发。
  // 所以归档的会话永远不可能在会议上开口，跟日志多大、硬盘多快都没关系。只读，绝不写。
  const archive = createArchiveReader(
    typeof config?.archiveFile === 'string' && config.archiveFile
      ? config.archiveFile
      : join(dshHome(), 'storages', 'workspace.json'),
  );
  // 封存名单：归档状态归 DSH 管，这里存的是「用户为什么封存它」——理由、时间、备注。
  const sealed = createSealedList(join(rootDir, 'sealed.json'), { archive });
  /** 封存名单（保证是数组，面板拿去做列表）。 */
  const sealedAll = () => {
    try { const list = sealed.all(); return Array.isArray(list) ? list : []; } catch { return []; }
  };
  // 会议实况：控制台标准输出 + 实时日志文件 + 网页/控制台窗口
  const meetingConsole = createMeetingConsole({
    dir: rootDir,
    // 传函数：真的要用时才求值，所以设置卡片里改完立刻算数
    enabled: () => cfg.get().consoleLog,
    windowEnabled: () => cfg.get().consoleWindow,
  });

  // 最近一次到达本插件路由的请求 Host —— lib/webport.js 靠它反推 DSH 的 web 端口。
  // 有人访问过会场页面，这个值就一定是对的。
  let recentHost = null;

  /**
   * 纪要文件名：`议题-日期-主持人.md`（2026-10-25 哥哥定）。
   *
   * 以前是 `<房间号>.md`，翻纪要时满屏 `mtg-20261024-0274ce.md`，谁也认不出哪场是哪场。
   * 房间号仍然是主键，只是**不再当文件名**；文件名里的三个字段都能一眼读懂。
   *
   * 三条边界：
   *   · 议题里的 `/ \ : * ? " < > |` 不能进文件名 —— 换成下划线；太长截到 40 字。
   *   · 议题为空（`meeting_open` 没给 topic）时用「未命名会议」。
   *   · **重名**（同一天、同议题、同主持人开两场）加 `-2`、`-3` —— 这个结果会存进
   *     `room.minutesFile`，之后同一间房收几次会都写同一个文件，不会每次换名。
   */
  function minutesNameOf(room) {
    if (room.minutesFile) return room.minutesFile;

    const scrub = (s, max) => {
      const t = String(s ?? '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/[\u0000-\u001f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return (t.slice(0, max) || '').trim();
    };

    const hostLabel = () => {
      const title = String(room.host?.title ?? '').trim();
      if (title) return title;
      const id = String(room.host?.sessionId ?? '');
      if (/^onebot-private/.test(id)) return 'QQ私聊·1代';
      if (/^onebot-group/.test(id)) return 'QQ群';
      if (/^wx_/.test(id)) return '微信端';
      const m = id.match(/^session-([0-9a-f]{8})/);
      return m ? `session-${m[1]}` : (id.slice(0, 12) || '未知主持人');
    };

    const d = new Date(Number(room.createdAt) || Date.now());
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
      + `${String(d.getDate()).padStart(2, '0')}`;

    const topic = scrub(room.topic, 40) || '未命名会议';
    const base = `${topic}-${stamp}-${scrub(hostLabel(), 20) || '未知主持人'}`;
    const dir = minutesDirNow();

    let name = `${base}.md`;
    let n = 2;
    while (existsSync(join(dir, name))) {
      name = `${base}-${n}.md`;
      n += 1;
    }
    room.minutesFile = name;
    return name;
  }

  /** 纪要目录：`minutesDir` 配了就用它，空着就用插件自己的 minutes/。 */
  function minutesDirNow() {
    try {
      const dir = cfg.get().minutesDir;
      return dir && String(dir).trim() ? String(dir).trim() : store.minutesDir;
    } catch {
      return store.minutesDir;
    }
  }
  /** 写纪要。返回写入路径；`minutesEnabled` 关掉时返回 null（不落盘、也不报错）。 */
  function writeMinutes(room, markdown) {
    if (!cfg.get().minutesEnabled) return null;
    try {
      const file = join(minutesDirNow(), minutesNameOf(room));
      atomicWriteText(file, markdown);
      return file;
    } catch {
      return null;
    }
  }

  /**
   * 读纪要：先按 `room.minutesFile`（新可读名），再回退到老的 `<房间号>.md`。
   * 回退那一条是为了 2026-10-25 之前收会的房间 —— 那些纪要还叫 `mtg-…md`。
   */
  function readMinutes(room) {
    const dirs = [minutesDirNow()];
    if (store.minutesDir !== dirs[0]) dirs.push(store.minutesDir);
    const tryDir = (name) => {
      for (const d of dirs) {
        try {
          const f = join(d, name);
          if (existsSync(f)) return readFileSync(f, 'utf8');
        } catch { /* 换下一个目录 */ }
      }
      return null;
    };
    return (room.minutesFile ? tryDir(room.minutesFile) : null) ?? tryDir(`${room.id}.md`);
  }

  /**
   * 按 `liveMode` 把会场亮给用户看。
   *   web  —— 用系统浏览器打开 QQ 群样式的会场实况页（默认）
   *   cmd  —— 弹一个跟随日志的控制台窗口（旧做法）
   *   none —— 什么都不弹，只写文件
   * @returns {{mode: string, opened: boolean, url?: string, logPath: string, reason?: string, fallback?: string}}
   */
  async function openLive(roomId, topic) {
    const logPath = meetingConsole.logFile(roomId);
    const mode = cfg.get().liveMode;

    if (mode === 'none') return { mode, opened: false, logPath, reason: '会场实况已在设置里关掉' };

    if (mode === 'cmd') {
      const win = meetingConsole.openWindow(roomId, `星辰会议室 · ${topic}`);
      return { mode, opened: win.opened, logPath, reason: win.reason };
    }

    // web：先探到真实端口，再打开；探不到就退回控制台窗口，绝不弹错地址
    let resolved = null;
    try {
      resolved = await resolveLiveUrl({
        webServer: ctx.webServer,
        route: ROUTE,
        roomId,
        recentHost,
        configured: 0,
      });
    } catch { resolved = null; }

    if (resolved) {
      const opened = meetingConsole.openUrl(resolved.url);
      if (opened.opened) return { mode, opened: true, url: resolved.url, logPath, port: resolved.port };
      const win = meetingConsole.openWindow(roomId, `星辰会议室 · ${topic}`);
      return {
        mode, opened: win.opened, logPath, reason: opened.reason,
        fallback: win.opened ? '已改用控制台窗口' : `控制台窗口也打不开：${win.reason}`,
      };
    }

    const win = meetingConsole.openWindow(roomId, `星辰会议室 · ${topic}`);
    return {
      mode, opened: win.opened, logPath,
      reason: '没能确定 DSH 的 web 端口（会场页面地址探测失败）',
      fallback: win.opened ? '已改用控制台窗口' : `控制台窗口也打不开：${win.reason}`,
    };
  }

  /**
   * 弹出**会议准备页**（2026-10-16 哥哥定的入口：打 `/meeting` 就该看到它）。
   *
   * 端口怎么找跟 `openLive` 完全一样（`lib/webport.js` 多路探测 + 实测确认），
   * 区别只是这里拼的是 `/setup` 而不是 `/live/<房间号>`。
   * @returns {{opened: boolean, url: string|null, text: string}}
   */
  async function openSetup() {
    let resolved = null;
    try {
      resolved = await resolveLiveUrl({
        webServer: ctx.webServer,
        route: ROUTE,
        roomId: 'setup-probe',
        recentHost,
        configured: 0,
      });
    } catch { resolved = null; }

    if (!resolved) {
      return {
        opened: false, url: null,
        text: '没能确定 DSH 的 web 端口，准备页打不开。\n'
          + '（会场实况那套端口探测没找到我们的路由 —— 确认 DSH 的网页服务是开着的）',
      };
    }

    const url = `http://127.0.0.1:${resolved.port}${ROUTE}/setup`;
    const opened = meetingConsole.openUrl(url);
    return {
      opened: opened.opened,
      url,
      text: opened.opened
        ? `已弹出会议准备页：${url}\n在页面上选「普通会议」或「狼人杀」，设好人数、挑好参会 AI 和主持人就能开局。`
        : `没能自动打开浏览器（${opened.reason ?? '未知原因'}），手动点这个地址：${url}`,
    };
  }

  const textOut = (text) => [{ type: 'text', text }];
  const fail = (message) => ({ ok: false, message });

  // ---------------------------------------------------------------- 会话名册

  let rosterCache = { at: 0, entries: [], blocked: [] };

  /**
   * 参会准入：谁能走进会议室。
   * 规则见 lib/admit.js —— **微信端与 QQ 群一律挡在门外**，只有哥哥点名的那个
   * QQ 私聊会话例外。cfg 是热读的，所以在设置里改完规则下一步就生效。
   */
  const admitPolicy = () => normalizeAdmitPolicy(cfg.get().admit);

  function titleOfSummary(summary) {
    const values = summary?.projections?.values;
    if (!values || typeof values !== 'object') return null;
    for (const key of ['title', 'sessionTitle', 'session/title']) {
      const value = values[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (value && typeof value === 'object' && typeof value.title === 'string' && value.title.trim()) {
        return value.title.trim();
      }
    }
    return null;
  }

  /** 当前可以邀请的会话。只列独立会话：空会话、子代理、有父会话的都排除。 */
  async function loadRoster() {
    const out = [];
    let items = [];
    try {
      const listed = await ctx.sessionController.list({}, AbortSignal.timeout(15_000));
      items = Array.isArray(listed?.items) ? listed.items : [];
    } catch (error) {
      return { entries: [], error: `读取会话清单失败: ${error?.message ?? String(error)}` };
    }
    const liveIds = new Set();
    try {
      for (const s of ctx.sessions.list()) liveIds.add(String(s.id));
    } catch { /* 拿不到活跃集合不影响名册 */ }

    for (const item of items) {
      const sessionId = String(item?.sessionId ?? '');
      if (!sessionId) continue;
      if (item.blank === true) continue;
      if (item.origin === 'subagent') continue;
      if (item.parentSessionId) continue;
      out.push({
        sessionId,
        title: titleOfSummary(item),
        cwd: typeof item.cwd === 'string' ? item.cwd : null,
        running: item.running === true,
        updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
        live: liveIds.has(sessionId),
        log: inventory.weigh(sessionId),
        sealed: sealed.find(sessionId),
      });
    }
    out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    // 参会准入：名册先过一遍规则 —— 微信端 / QQ 群不进会议室。
    // 被挡下的也一并返回：准备页要显示"谁被挡了、为什么"，用户才不会以为名单漏了人。
    const { allowed, blocked } = splitRoster(out, admitPolicy());
    return { entries: allowed, blocked, error: null };
  }

  async function roster({ refresh = false } = {}) {
    const now = Date.now();
    if (!refresh && rosterCache.entries.length > 0 && now - rosterCache.at < ROSTER_TTL_MS) {
      return { entries: rosterCache.entries, blocked: rosterCache.blocked, error: null, cached: true };
    }
    const loaded = await loadRoster();
    if (!loaded.error) rosterCache = { at: now, entries: loaded.entries, blocked: loaded.blocked };
    return { ...loaded, cached: false };
  }

  /** 把模型给的成员引用（名册编号 / 会话 id）解析成成员描述。
   *  编号一律按**最近一次名册快照**解释：模型先 meeting_roster 看到编号、再开会，
   *  中间即使隔了一会儿，编号的含义也不会漂移。 */
  async function resolveMemberRefs(refs) {
    let entries = rosterCache.entries;
    if (entries.length === 0) {
      const loaded = await roster({ refresh: true });
      if (loaded.error) throw new Error(loaded.error);
      entries = loaded.entries;
    }
    const picked = [];
    for (const raw of Array.isArray(refs) ? refs : []) {
      const value = String(raw ?? '').trim();
      if (!value) continue;
      if (/^\d+$/.test(value)) {
        const hit = entries[Number(value) - 1];
        if (!hit) throw new Error(`名册里没有第 ${value} 号会话（先跑一次 meeting_roster 看看当前清单）`);
        picked.push(hit);
        continue;
      }
      const hit = entries.find((e) => e.sessionId === value);
      picked.push(hit ?? { sessionId: value, title: null, cwd: null, log: null });
    }
    // 封存状态必须实时查：名册有 15 秒缓存，刚 seal 的那位在缓存里还带着旧的 null。
    // 准入也在这里判 —— 这是所有邀请路径的**唯一漏斗**（编号、会话 id 都得过它），
    // 所以模型就算直接拿 id 来邀请，微信端和 QQ 群照样进不来。
    const policy = admitPolicy();
    return picked.map((entry) => {
      const verdict = judgeAdmit(entry, policy);
      if (!verdict.ok) {
        throw new Error(`不能邀请「${entry.title || entry.sessionId}」：${verdict.reason}`
          + '（准入规则可在「设置 → 星辰会议室」里调整）');
      }
      return { ...entry, sealed: sealed.find(entry.sessionId) };
    });
  }

  // ---------------------------------------------------------------- 串行闸门

  /**
   * 同一间房同一时刻只允许一个推进动作。
   * 模型有可能在一条消息里并发调两次 meeting_speak；没有这道闸门，两位成员会同时
   * 被叫起来，发言顺序和座位就全乱了。队列按房间隔离，不同房间互不阻塞。
   */
  const roomQueues = new Map();
  function withRoomLock(roomId, task) {
    const previous = roomQueues.get(roomId) ?? Promise.resolve();
    const run = previous.then(task, task);
    roomQueues.set(roomId, run.then(() => undefined, () => undefined));
    return run;
  }

  // ---------------------------------------------------------------- 房间定位

  function hostSessionId(exec) {
    const id = exec?.agent?.id;
    return typeof id === 'string' ? id : String(id ?? '');
  }

  /** 找到"我在主持、且还没结束"的那间房（房间号可以省略时的默认值）。 */
  function activeRoomOf(sessionId) {
    return store.list().find((r) => r.host.sessionId === sessionId && r.status !== ROOM_CLOSED) ?? null;
  }

  function resolveRoom(exec, roomIdArg) {
    const me = hostSessionId(exec);
    const wanted = typeof roomIdArg === 'string' ? roomIdArg.trim() : '';
    let room = null;
    if (wanted) {
      if (!isValidRoomId(wanted)) throw new Error(`房间号格式不对: ${wanted}`);
      room = store.read(wanted);
      if (!room) throw new Error(`找不到房间 ${wanted}`);
    } else {
      room = activeRoomOf(me);
      if (!room) throw new Error('你手上没有正在主持的会议室；先用 meeting_open 开一间');
    }
    if (!isHost(room, me)) {
      throw new Error(`房间 ${room.id} 的主持人是别人，你不能操作它（只有主持人能推进或结束会议）`);
    }
    return { room, me };
  }

  /**
   * 在房间里点名找一位成员：座位号（"3"）或会话 id 都行。
   * **只在本房 members 里找** —— 没被邀请的会话永远进不来（准入的第二道门，
   * 第一道是 meeting_open 拒绝归档会话）。
   */
  function resolveRoomMember(room, ref, { allowOut = false } = {}) {
    const s = String(ref ?? '').trim();
    if (!s) throw new Error('要指定跟谁说话（member 传座位号或会话 id）');
    let found = null;
    if (/^\d+$/.test(s)) {
      found = room.members.find((m) => m.order === Number(s));
      if (!found) throw new Error(`本房没有第 ${s} 位成员（共 ${room.members.length} 位）`);
    } else {
      found = room.members.find((m) => m.sessionId === s);
      if (!found) throw new Error(`这位不在本房名单里: ${s}（用 meeting_status 看名单）`);
    }
    // 出局的人默认不再接收投递 —— 狼人杀里死人不能说话。
    // 但"游戏结束时给每个人发结局卡"需要能投给出局者，所以留了 allowOut 这道门。
    if (found.status === 'out' && !allowOut) {
      throw new Error(`${memberLabel(found)} 已经出局了，不再接收投递`
        + '（确有需要——比如收尾发结局卡——就带 force: true）');
    }
    return found;
  }

  /** 同一位小星辰同时只能在一场进行中的会议里当成员，避免上下文串味。 */
  function conflictingRoomFor(sessionId, exceptRoomId) {
    return store.list().find((r) => r.id !== exceptRoomId
      && r.status !== ROOM_CLOSED
      && isMember(r, sessionId)) ?? null;
  }

  // ---------------------------------------------------------------- 发言

  /**
   * 驱动一位成员发言一次，并把结果记进房间。
   * 这里刻意把"投递 → 等待 → 落账 → 存盘"做成一个不可分割的步骤：
   * 即使下一步崩了，已经说过的内容也已经落盘。
   */
  /**
   * 人类席位的"发言" —— 投递不到他，只能停下来等他在会场页面上写。
   *
   * 2026-10-19 加：哥哥真玩了一局后指出的第一条。他还没开口，其他小星辰已经
   * 说完并投完票，整条流程是错位的。人类既然坐了那个位子，就得占住轮次里的位置。
   *
   * 他的发言走 `POST /api/room/<id>/say`：那条路由发现"正好轮到他"时，会把记录
   * 记成 `kind:'member'`，于是 `record()` 自己推进游标 —— 这里只负责**等**。
   * 等不到就跳过这一位，别把整场卡死。
   */
  async function speakAsHuman(room, member, { signal, waitMs }) {
    const started = Date.now();
    // 真人的等待单独收窄 —— AI 几秒就答完，用 5 分钟没问题；真人在打字，而且
    // 不一定盯着页面。2026-10-19 那局就是被 200 秒超时跳掉的。
    const humanWaitMs = Math.max(30_000, Math.min(waitMs, humanWaitLimitMs()));
    const beforeSpoke = member.spokeCount ?? 0;
    const beforeRound = room.round;
    logEvent(room, 'speak.human', { round: room.round, seat: member.order });
    // 页面靠这三个字段显示「现在轮到你 · 还剩 N 秒」
    room.waitingFor = { seat: member.order, since: started, until: started + humanWaitMs };
    store.save(room);
    meetingConsole.note(room.id,
      `▷ 轮到 ${memberLabel(member)}（真人）—— 在会场页面发言，最多等 ${Math.round(humanWaitMs / 1000)} 秒`);

    while (Date.now() < started + humanWaitMs) {
      if (signal?.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      if ((member.spokeCount ?? 0) > beforeSpoke) break;   // 他说完了
      if (room.status === ROOM_CLOSED) break;
    }

    room.waitingFor = null;
    const spoke = (member.spokeCount ?? 0) > beforeSpoke;
    // 他说完之后，把他这一轮的正文捞回来。
    // 不捞的话 `text` 恒为空串，`meeting_round` 的汇报会显示「0 字」——
    // 法官看到「12 号 0 字 · 182 秒」会以为他一个字没说（2026-10-24 实测：他说了 94 字）。
    let said = '';
    if (spoke) {
      const mine = [...(room.transcript ?? [])].reverse().find(
        (t) => t.kind === 'member' && t.seat === member.order && Number(t.at) >= started,
      );
      if (mine) said = String(mine.text ?? '');
    }
    if (!spoke) {
      passTurn(room, member, { timedOut: true });
      meetingConsole.note(room.id, `⏱ ${memberLabel(member)}（真人）没来得及说完，跳过这一位`);
    }
    store.save(room);
    return {
      member,
      ok: spoke,
      phase: spoke ? 'human' : 'human-timeout',
      text: said,
      ms: Date.now() - started,
      error: spoke ? null : `等了 ${Math.round(humanWaitMs / 1000)} 秒没等到，这一位跳过`,
      // ⚠️ 外层（meeting_speak）要读这三个字段。2026-10-19 漏了它们，
      // 工具直接报 "invalid output: value is not lossless JSON"。
      round: room.round,
      seat: member.order,
      roundCompleted: room.round !== beforeRound,
    };
  }

  async function speakOnce(room, member, {
    signal, waitSeconds, note, channel = null, audience = null, noAdvance = false,
  } = {}) {
    const token = newToken();
    // 下限只防呆（0/负数/NaN 已经被 || 兜住），不设高门槛：
    // 想快速探测的调用方就该能探测，不能被迫干等半分钟。
    const waitMs = Math.max(5, Math.min(Number(waitSeconds) || DEFAULT_WAIT_S, 3600)) * 1000;
    // 真人坐下之后没有"投递"这条路，只能等他自己在页面上说
    if (member.human === true) {
      return speakAsHuman(room, member, { signal, waitMs });
    }
    const settings = cfg.get();
    const prompt = formatSpeakingPrompt(room, member, token, {
      note: note || null,
      recentCount: settings.contextRecentCount,
      speechLimitChars: settings.speechLimitChars,
    });
    // channel / audience 决定**这一条发言给谁看**（2026-10-16 加）：
    //   不传 = 公开（兼容既有会议）；狼人夜聊传 audience:['tag:狼人']。
    // 它管的是"这条发言的可见范围"；投给这位成员的**历史**早在
    // formatSpeakingPrompt 里按 viewer 过滤过了 —— 两件事，别混。
    const visibility = { channel, audience };
    logEvent(room, 'speak.dispatch', {
      round: room.round, seat: member.order, sessionId: member.sessionId, token,
    });
    store.save(room);

    meetingConsole.note(room.id, `▷ 请 ${memberLabel(member)}（第 ${room.round} 轮 · 第 ${member.order} 位）发言…`);
    const started = Date.now();
    const result = await relay.relay({
      sessionId: member.sessionId,
      text: prompt,
      token,
      // 这条 source 是需求 6 的全部秘密：kind 不是 'user'，Chat 就不会把它当"人说的话"，
      // 而是渲染成一张折叠的 turn-trigger 卡片（标题+时间，正文要点开），会议内容
      // 因此不再铺开在成员的会话界面里。见 lib/relay.js 顶部注释。
      source: {
        summary: `星辰会议室 · 第 ${room.round} 轮 · ${memberLabel(member)}`,
        roomId: room.id,
        round: room.round,
        seat: member.order,
        topic: room.topic,
      },
      markWaitMs: waitMs,
      replyWaitMs: waitMs,
      signal,
    });

    const solved = result.ok || (result.phase === 'timeout-reply' && result.text.length > 0);
    const { item, roundCompleted } = record(room, {
      kind: 'member',
      seat: member.order,
      sessionId: member.sessionId,
      name: memberLabel(member),
      text: result.text,
      ms: result.ms,
      timedOut: !result.ok,
      error: result.ok ? null : (solved ? '超时，只收到部分内容' : result.error),
      noAdvance,
      ...visibility,
    });
    logEvent(room, 'speak.result', {
      round: item.round, seat: member.order, phase: result.phase, chars: result.text.length,
      roundCompleted, via: result.via ?? null,
    });
    store.save(room);

    // 会场实况：把这一位的发言原样打出去，用户在控制台窗口里就能看着它们说话
    meetingConsole.gap(room.id);
    meetingConsole.emit(room.id, `【${memberLabel(member)}】第 ${item.round} 轮 · 第 ${member.order} 位`
      + `${solved ? '' : ` ⚠️ ${item.error ?? '未完成'}`}`);
    if (result.text) {
      for (const line of result.text.split(/\r?\n/)) meetingConsole.emit(room.id, `    ${line}`);
    } else {
      meetingConsole.emit(room.id, '    （这一轮没有留下文字）');
    }
    if (roundCompleted) {
      meetingConsole.note(room.id, `✓ 本轮结束 —— 已完成 ${room.completedRounds}/${room.roundLimit} 轮`);
    }
    meetingConsole.gap(room.id);

    return {
      member,
      ok: solved,
      phase: result.phase,
      text: result.text,
      roundCompleted,
      round: item.round,
      seat: member.order,
      ms: Date.now() - started,
      error: result.ok ? null : result.error,
    };
  }

  /**
   * 私聊一轮：投一条**只给这位成员**的消息，收回他的回答。
   *
   * 与 speakOnce 的四点不同：
   *   · 不占发言位、不推进轮次（`offRecord`）—— 夜里的私聊不该搅乱白天的发言顺序；
   *   · 默认不带公开历史 —— 夜里它只需要知道自己该干什么；
   *   · 可以附一张状态卡（brief）—— 治"AI 会忘"；
   *   · 落账时那一对记录（主持人问 + 成员答）**都只对这位成员可见**。
   *
   * 狼人杀夜里那句"你要用解药吗"，走的就是这里。
   */
  /**
   * 法官对**真人**的私聊：投递不到，就落一条他能在会场页面看到的记录，然后**等他回话**。
   *
   * 2026-10-19 哥哥要求的两件事：
   *   ① 他面板上要看得见法官说了什么 —— 这条记录 audience 只有 `user:self`，
   *      页面能显示，其他小星辰的投递按 audience 过滤直接挡掉；
   *   ② 法官得**真的等** —— 之前这里写完就立刻返回，法官以为他答了、其实一个字
   *      都没收到。现在轮询 transcript，直到他用「只发主持人」回过来或者超时。
   *
   * 他的回话走 `/say` 的 `to: 'host'`，落成 `kind:'user'` + `humanPrivate`。
   */
  async function whisperHuman(room, member, { text, expect, brief, waitMs, signal } = {}) {
    const started = Date.now();
    const humanWaitMs = Math.max(15_000, Math.min(Number(waitMs) || humanWaitLimitMs(), humanWaitLimitMs()));
    const audience = [USER_SEAT_ID];
    const beforeLen = room.transcript.length;   // 必须在写记录之前取
    record(room, {
      kind: 'host', seat: null, sessionId: room.host.sessionId, name: '主持人',
      text: String(text ?? ''),
      channel: 'private', audience, humanPrivate: true,
    });
    if (brief) {
      record(room, {
        kind: 'system', seat: member.order, sessionId: USER_SEAT_ID, name: memberLabel(member),
        text: `【状态卡】${String(brief)}`,
        channel: 'private', audience, humanPrivate: true,
      });
    }
    logEvent(room, 'whisper.human', {
      round: room.round, seat: member.order, chars: String(text ?? '').length,
    });
    // 页面靠 waitingFor 高亮「现在轮到你回答」
    room.waitingFor = {
      seat: member.order, since: started, until: started + humanWaitMs, kind: 'whisper',
    };
    store.save(room);
    meetingConsole.note(room.id,
      `🔒 主持人私聊真人 —— 等他在会场页面回话，最多 ${Math.round(humanWaitMs / 1000)} 秒`);

    let reply = null;
    while (Date.now() < started + humanWaitMs) {
      if (signal?.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      reply = room.transcript.slice(beforeLen)
        .find((t) => t.kind === 'user' && t.humanPrivate === true);
      if (reply) break;
      if (room.status === ROOM_CLOSED) break;
    }

    room.waitingFor = null;
    store.save(room);
    const answered = Boolean(reply);
    if (!answered) {
      meetingConsole.note(room.id,
        `⏱ 真人 ${Math.round(humanWaitMs / 1000)} 秒没回，这条私聊先挂着`);
    }
    return {
      member,
      ok: answered,
      phase: answered ? 'human-reply' : 'human-timeout',
      text: answered ? String(reply.text ?? '') : '',
      ms: Date.now() - started,
      error: answered ? null : `等了 ${Math.round(humanWaitMs / 1000)} 秒没回话`,
    };
  }

  async function whisperOnce(room, member, {
    text, expect, brief, historyCount, signal, waitSeconds, audience: rawAudience,
  } = {}) {
    const token = newToken();
    const waitMs = Math.max(5, Math.min(Number(waitSeconds) || DEFAULT_WAIT_S, 3600)) * 1000;
    // 2026-10-19 补：`audience` 之前**根本没接进来** —— 法官传了也被丢掉，
    // 于是"上警发言"这种「**一个人说、全体听**」的环节全变成了私密消息，
    // 其他玩家一个字都看不到。现在按传进来的 audience 决定可见范围。
    const vis = resolveVisibility(rawAudience);
    const visAudience = vis.audience ?? [member.sessionId];
    const visChannel = visAudience.length > 0 ? 'private' : 'public';
    if (member.human === true) {
      return whisperHuman(room, member, { text, expect, brief, waitMs, signal });
    }
    const prompt = formatWhisperPrompt(room, member, token, { text, expect, brief, historyCount });
    logEvent(room, 'whisper.dispatch', {
      round: room.round, seat: member.order, sessionId: member.sessionId, token, chars: prompt.length,
    });
    store.save(room);

    meetingConsole.gap(room.id);
    meetingConsole.note(room.id, `🔒 私聊 ${memberLabel(member)}…`);
    const started = Date.now();
    const result = await relay.relay({
      sessionId: member.sessionId,
      text: prompt,
      token,
      source: {
        summary: `星辰会议室 · 私聊 · ${memberLabel(member)}`,
        roomId: room.id,
        round: room.round,
        seat: member.order,
        topic: room.topic,
        private: true,
      },
      markWaitMs: waitMs,
      replyWaitMs: waitMs,
      signal,
    });

    const solved = result.ok || (result.phase === 'timeout-reply' && result.text.length > 0);
    const audience = visAudience;
    // 主持人那一问也进记录 —— 否则回头翻纪要时，不知道它为什么这么答
    record(room, {
      kind: 'host', seat: null, sessionId: room.host.sessionId, name: '主持人',
      text: `（私聊 ${memberLabel(member)}）${String(text ?? '')}`,
      channel: visChannel, audience,
    });
    const { item } = record(room, {
      kind: 'member', seat: null, offRecord: true,
      sessionId: member.sessionId, name: memberLabel(member),
      text: result.text, ms: result.ms,
      timedOut: !result.ok,
      error: result.ok ? null : (solved ? '超时，只收到部分内容' : result.error),
      channel: visChannel, audience,
    });
    logEvent(room, 'whisper.result', {
      round: item.round, seat: member.order, phase: result.phase, chars: result.text.length,
    });
    store.save(room);

    // 观战日志**不写私聊内容、也不写对象** —— 玩家手里有文件工具，读得到这份日志。
    // 夜里被私聊的是谁、答了什么（「刀 5 号」），那条信息本身就是身份。
    meetingConsole.note(room.id, '🔒 主持人完成 1 次私聊'
      + `${solved ? '' : `（⚠️ ${item.error ?? '未完成'}）`} —— 对象与内容不进入日志`);
    meetingConsole.gap(room.id);

    return {
      member,
      ok: solved,
      phase: result.phase,
      text: result.text,
      ms: Date.now() - started,
      error: result.ok ? null : result.error,
    };
  }

  /**
   * **并发**私聊一组人：每人一条同样的消息，各答各的、互不可见。
   *
   * 为什么要有它：夜里问守卫 / 狼队 / 女巫 / 预言家，串行问就是 4 倍等待；白天收投票同理。
   * 并发之所以成立，是因为**他们本来就不该看到彼此的回答** —— 私聊的语义天然满足这一点。
   *
   * 两段式：先把 N 条投递**一起发出去、一起等**，全部回来之后再统一落账。
   * 这样房间里不会留下"一半人刚问了、一半人还没问"的中间态。
   */
  async function panelOnce(room, members, { text, expect, historyCount, signal, waitSeconds } = {}) {
    const waitMs = Math.max(5, Math.min(Number(waitSeconds) || DEFAULT_WAIT_S, 3600)) * 1000;
    const settled = await Promise.all(members.map(async (member) => {
      // 真人席位：没有会话可投递。走 whisperHuman —— 它会写记录、把 waitingFor 挂上，
      // 并且**等他真的在页面上回话**（2026-10-19 加；之前这里直接拿 user:self 去投递，
      // 必然失败，法官只能退化成逐个私聊）。
      if (member.human === true) {
        const res = await whisperHuman(room, member, { text, expect, waitMs, signal });
        return {
          member,
          human: true,
          ms: res.ms,
          result: { ok: res.ok, phase: res.phase, text: res.text, error: res.error },
        };
      }
      const token = newToken();
      const prompt = formatWhisperPrompt(room, member, token, { text, expect, historyCount });
      logEvent(room, 'panel.dispatch', { round: room.round, seat: member.order, token });
      meetingConsole.note(room.id, `🔒 并发私聊 ${memberLabel(member)}…`);
      const started = Date.now();
      try {
        const result = await relay.relay({
          sessionId: member.sessionId,
          text: prompt,
          token,
          source: {
            summary: `星辰会议室 · 私聊 · ${memberLabel(member)}`,
            roomId: room.id,
            round: room.round,
            seat: member.order,
            topic: room.topic,
            private: true,
            panel: true,
          },
          markWaitMs: waitMs,
          replyWaitMs: waitMs,
          signal,
        });
        return { member, result, ms: Date.now() - started };
      } catch (error) {
        return {
          member,
          result: { ok: false, phase: 'error', text: '', error: String(error?.message ?? error) },
          ms: Date.now() - started,
        };
      }
    }));

    const outcomes = [];
    for (const { member, result, ms, human } of settled) {
      const solved = result.ok || (result.phase === 'timeout-reply' && result.text.length > 0);
      const audience = [member.sessionId];
      // 真人的那一问一答已经由 whisperHuman 写进记录了，别重复记
      if (!human) {
        record(room, {
          kind: 'host', seat: null, sessionId: room.host.sessionId, name: '主持人',
          text: `（并发私聊 ${memberLabel(member)}）${String(text ?? '')}`,
          channel: 'private', audience,
        });
        record(room, {
          kind: 'member', seat: null, offRecord: true,
          sessionId: member.sessionId, name: memberLabel(member),
          text: result.text, ms,
          timedOut: !result.ok,
          error: result.ok ? null : (solved ? '超时，只收到部分内容' : result.error),
          channel: 'private', audience,
        });
      }
      const outcome = {
        member,
        ok: solved,
        text: result.text ?? '',
        ms,
        error: result.ok ? null : (result.error ?? '未完成'),
      };
      outcomes.push(outcome);
      // 这里**故意不逐条打印**：并发私聊的名单和应答，加起来就是夜里的身份表。
    }
    logEvent(room, 'panel.result', {
      round: room.round, count: outcomes.length, answered: outcomes.filter((o) => o.ok).length,
    });
    meetingConsole.note(room.id,
      `🔒 主持人并发私聊 ${outcomes.length} 位（应答 ${outcomes.filter((o) => o.ok).length} 位）`
      + ' —— 对象与内容不进入日志');
    store.save(room);
    meetingConsole.gap(room.id);

    return outcomes;
  }

  // 发言结果的文本渲染已搬到 lib/report.js（纯函数、可单测、可切 full/brief 两种粒度）。

  /**
   * 遗言：给**已经出局的人**一次公开发言的机会。
   *
   * 为什么单开一条路：狼人杀的遗言是"死者当着所有人说最后一段话"。
   * 用 `meeting_whisper` 办，它会被记成私聊 —— 别人的投递里根本看不见；
   * 用 `meeting_speak` 办，它会推进轮次 —— 把死人也算进了发言顺序。
   * 遗言两头都不该占，所以它走自己的路：**公开发言，但不占位、不推进轮次**。
   */
  async function lastWordsOnce(room, member, { text, audience = null, signal, waitSeconds } = {}) {
    const token = newToken();
    const waitMs = Math.max(5, Math.min(Number(waitSeconds) || DEFAULT_WAIT_S, 3600)) * 1000;
    const prompt = formatWhisperPrompt(room, member, token, { text, historyCount: 0 });
    logEvent(room, 'lastwords.dispatch', { round: room.round, seat: member.order, token });
    store.save(room);

    meetingConsole.gap(room.id);
    meetingConsole.note(room.id, `🕯️ 请 ${memberLabel(member)} 留遗言…`);
    const started = Date.now();
    const result = await relay.relay({
      sessionId: member.sessionId,
      text: prompt,
      token,
      source: {
        summary: `星辰会议室 · 遗言 · ${memberLabel(member)}`,
        roomId: room.id, round: room.round, seat: member.order, topic: room.topic,
      },
      markWaitMs: waitMs,
      replyWaitMs: waitMs,
      signal,
    });

    const solved = result.ok || (result.phase === 'timeout-reply' && result.text.length > 0);
    record(room, {
      kind: 'member', seat: member.order, extra: true,
      sessionId: member.sessionId, name: memberLabel(member),
      text: result.text, ms: result.ms,
      timedOut: !result.ok,
      error: result.ok ? null : (solved ? '超时，只收到部分内容' : result.error),
      channel: 'public', audience,
    });
    store.save(room);

    meetingConsole.emit(room.id, `🕯️【${memberLabel(member)} · 遗言】${solved ? '' : ` ⚠️ ${result.error ?? '未完成'}`}`);
    for (const line of (result.text || '').split(/\r?\n/)) meetingConsole.emit(room.id, `    ${line}`);
    meetingConsole.gap(room.id);

    return {
      member,
      ok: solved,
      phase: result.phase,
      text: result.text,
      ms: Date.now() - started,
      error: result.ok ? null : result.error,
    };
  }

  /**
   * 报告粒度：工具参数 > 配置项 speakReport > 'full'（默认，兼容旧行为）。
   * brief 只影响**回给法官的文本**，落盘与观战窗口一个字都不少。
   */
  function resolveReport(explicit) {
    if (explicit === 'brief' || explicit === 'full') return explicit;
    return cfg.get().speakReport === 'brief' ? 'brief' : 'full';
  }

  /** 把 audience 参数翻译成（channel, audience）两个落盘字段。 */
  function resolveVisibility(raw) {
    const list = (Array.isArray(raw) ? raw : [raw])
      .map((v) => String(v ?? '').trim())
      .filter(Boolean);
    const audience = list.length > 0 ? list : null;
    if (audience === null) return { channel: null, audience: null };
    const single = audience.length === 1 && !audience[0].startsWith('tag:');
    return { channel: single ? 'private' : 'group', audience };
  }

  // ---------------------------------------------------------------- 工具

  // ctx.effect 自带卸载清理：插件被停用/重载时工具会一起注销。
  const register = (definition) => ctx.effect(() => ctx.tools.register(definition));

  // ---- 名册 ----
  register(defineTool({
    name: 'meeting_roster',
    description: '列出当前所有可以邀请参加「星辰会议室」的小星辰（每个会话一位）。'
      + '返回带编号的名单，meeting_open 时用编号或会话 id 指定成员。'
      + '名册只含独立的顶层会话，不含空会话与子代理。',
    parameters: {
      refresh: { type: 'boolean', description: 'true 则强制重新扫描，忽略 15 秒缓存' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => textOut(v.message) },
    async execute(args) {
      const { entries, error } = await roster({ refresh: args?.refresh === true });
      if (error) return fail(error);
      if (entries.length === 0) return fail('现在没有可邀请的会话。');
      const lines = [`可邀请的小星辰（${entries.length} 位，按最近活动排序）：`, ''];
      entries.forEach((entry, index) => {
        const bits = [];
        bits.push(entry.title || shortId(entry.sessionId));
        if (entry.cwd) bits.push(entry.cwd);
        bits.push(entry.running ? '正在忙' : (entry.live ? '在线空闲' : '未激活'));
        if (entry.sealed?.archived) bits.push('⛔ 已封存');
        else if (entry.sealed) bits.push('⛔ 在封存记录里');
        bits.push(`${entry.log?.warn ? '⚠️ ' : ''}${entry.log?.label ?? '体量未知'}`);
        lines.push(`${index + 1}. ${bits.join(' · ')}`);
        lines.push(`   id: ${entry.sessionId}`);
        if (entry.sealed) {
          const why = entry.sealed.reason ?? '（没写理由）';
          const when = entry.sealed.sealedAt ? ` · ${fmtTime(entry.sealed.sealedAt, ZONE)}` : '';
          lines.push(`   ⛔ 封存理由：${why}${when}`);
          lines.push(entry.sealed.archived
            ? '      会话已归档，归档门会挡下一切投递，不会再有回话'
            : '      只在封存记录里，会话**没有归档** —— 技术上还叫得醒');
        }
      });
      const archCount = entries.filter((e) => e.sealed?.archived).length;
      if (archCount > 0) {
        lines.push('', `⛔ 名册里有 ${archCount} 位已经封存（会话已归档）：请勿打扰 —— `
          + '归档门会挡下一切投递，meeting_open 也会直接拒绝邀请。');
      }
      const onlyRecord = entries.filter((e) => e.sealed && !e.sealed.archived).length;
      if (onlyRecord > 0) {
        lines.push('', `⚠️ 还有 ${onlyRecord} 位只在封存记录里、会话其实没归档 —— 技术上叫得醒。`);
      }
      const risky = entries.filter((e) => e.log?.level === 'huge');
      if (risky.length > 0) {
        lines.push('', `ℹ️ 名册里有 ${risky.length} 位会话的日志 ≥8 MB：把历史读回来约 0.3 秒，`
          + '**不会**导致失败 —— 但压缩后的上下文仍可能有几十万 token，模型首字会慢。');
      }
      lines.push('', 'meeting_open 的 members 填编号（如 ["1","3"]）或完整 id 都行，**顺序就是发言顺序**。');
      return { ok: true, message: lines.join('\n'), entries: entries.map((e) => ({ ...e, log: e.log?.label ?? null })) };
    },
  }));

  // ---- 开房 ----
  register(defineTool({
    name: 'meeting_open',
    description: '开一间「星辰会议室」并担任主持人。你的开场发言（议题、目标、安排）会作为会议第一条记录，'
      + '之后按 members 的顺序一位一位发言，最后一位说完算一轮结束。'
      + '成员请先用 meeting_roster 查编号。',
    parameters: {
      topic: { type: 'string', description: '会议议题（必填）' },
      goal: { type: 'string', description: '会议要达成的目标或要完成的任务' },
      agenda: { type: 'string', description: '你对成员的具体安排、分工或要求' },
      rounds: { type: 'number', description: `轮次上限，默认 2，最多 ${MAX_ROUNDS}` },
      members: {
        type: 'array',
        description: '按邀请顺序排列的成员，用 meeting_roster 的编号或会话 id。顺序即发言顺序。',
        items: { type: 'string' },
      },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => textOut(v.message) },
    async execute(args, exec) {
      const me = hostSessionId(exec);
      if (!me) return fail('拿不到当前会话身份，无法开房。');
      const topic = String(args?.topic ?? '').trim();
      if (!topic) return fail('议题（topic）不能为空。');
      const refs = Array.isArray(args?.members) ? args.members : [];
      if (refs.length === 0) return fail('至少要邀请一位成员（members）。先用 meeting_roster 查编号。');
      if (refs.length > MAX_MEMBERS) return fail(`成员最多 ${MAX_MEMBERS} 位。`);

      const existing = activeRoomOf(me);
      if (existing) {
        return fail(`你手上已经有一间没结束的会议室（${existing.id}：「${existing.topic}」）。`
          + '先 meeting_close 收掉它，或者继续推进它。');
      }

      let picked;
      try {
        picked = await resolveMemberRefs(refs);
      } catch (error) {
        return fail(error?.message ?? String(error));
      }
      if (picked.some((m) => m.sessionId === me)) return fail('不用邀请自己：主持人的开场发言由 meeting_open 直接记入。');

      const barred = picked.filter((m) => m.sealed);
      if (barred.length > 0) {
        return fail('这些会话已经封存，请不了：\n'
          + barred.map((m) => {
            const why = m.sealed?.reason ? `（${m.sealed.reason}）` : '';
            const how = m.sealed?.archived ? '会话已归档' : '只在封存记录里';
            return `- ${m.title || shortId(m.sessionId)}${why} · ${how}`;
          }).join('\n')
          + '\n\n换人吧。归档是用户在 DSH 界面上的动作，本插件只读归档状态、改不了它；'
          + '也不会去改 —— 那道门的意义就是不再打扰。');
      }

      const busy = [];
      for (const member of picked) {
        const clash = conflictingRoomFor(member.sessionId, null);
        if (clash) busy.push(`${member.title || shortId(member.sessionId)}（已在 ${clash.id} 里）`);
      }
      if (busy.length > 0) {
        return fail(`这些会话已经在一场没结束的会议里，请先让那边收会，或换人：\n- ${busy.join('\n- ')}`);
      }

      let room;
      try {
        room = createRoom({
          // 主持人名字：工具开的房以前固定写 title: null，导致纪要里只能落 sessionId，
          // 翻纪要看不出是谁主持的。这里尽量补上标题，拿不到仍然回退到 id。
          host: {
            sessionId: me,
            title: exec?.agent?.session?.header?.title
              ?? (() => { try { return ctx.sessions.list().find((x) => String(x.id) === me)?.title ?? null; } catch { return null; } })(),
            cwd: exec?.agent?.session?.header?.cwd ?? null,
          },
          topic,
          goal: args?.goal,
          agenda: args?.agenda,
          rounds: Number.isFinite(Number(args?.rounds)) ? args.rounds : cfg.get().defaultRounds,
          members: picked,
        });
      } catch (error) {
        return fail(error?.message ?? String(error));
      }

      // 主持人的开场发言就是开房时写下的这三样，直接记成会议第一条
      const opening = [
        `议题：${room.topic}`,
        room.goal ? `目标：${room.goal}` : null,
        room.agenda ? `安排：${room.agenda}` : null,
      ].filter(Boolean).join('\n');
      record(room, {
        kind: 'host',
        seat: 0,
        sessionId: me,
        name: room.host.title || '主持人',
        text: opening,
      });
      room.status = ROOM_LIVE;
      logEvent(room, 'opened', { topic: room.topic, rounds: room.roundLimit, members: picked.map((m) => m.sessionId) });
      store.save(room);

      // 会场实况：开场白写进实时日志，并弹一个跟随它的可见控制台窗口
      meetingConsole.emit(room.id, '════════════════════════════════════════════════');
      meetingConsole.emit(room.id, `星辰会议室 · ${room.topic}`);
      meetingConsole.emit(room.id, `房间 ${room.id} · 主持人 ${room.host.title || room.host.sessionId}`);
      meetingConsole.emit(room.id, `轮次 ${room.roundLimit} 轮 · 发言顺序：${room.members.map((m) => memberLabel(m)).join(' → ')}`);
      meetingConsole.emit(room.id, '════════════════════════════════════════════════');
      meetingConsole.gap(room.id);
      meetingConsole.emit(room.id, `【主持人】${opening.replace(/\r?\n/g, '　')}`);
      meetingConsole.gap(room.id);
      const live = await openLive(room.id, room.topic);

      const heavy = picked.filter((m) => m.log?.level === 'huge');
      const lines = [
        `会议室已开：${room.id}`,
        `议题：${room.topic}`,
        room.goal ? `目标：${room.goal}` : null,
        `轮次上限：${room.roundLimit} 轮`,
        `成员（发言顺序）：${room.members.map((m) => `${m.order}. ${memberLabel(m)}`).join('　')}`,
        heavy.length > 0
          ? `ℹ️ 提醒：${heavy.map((m) => m.title || shortId(m.sessionId)).join('、')} 的日志很大`
            + '（≥8 MB）。把历史读回来只要约 0.3 秒、**不会**失败，但压缩后的上下文仍可能有'
            + '几十万 token，模型首字会比较慢 —— 推进到它们时把 waitSeconds 给足就行。'
          : null,
        '',
        '接下来按顺序发言：轮到你推进时调用 meeting_speak（一次一位）或 meeting_round（一次跑完一整轮）。',
        `轮次用完、或你判断目标已达成，就调用 meeting_close 收会${cfg.get().minutesEnabled ? '并生成纪要' : ''}，然后把成果提交给用户。`,
        live.opened
          ? (live.mode === 'web'
            ? `会场实况已经弹出来了：${live.url}\n（浏览器里那个页面每 2 秒自动刷新；同一份内容也追加写在 ${live.logPath}）`
            : `已为这场会议弹出一个控制台窗口，用户能实时看到会场对话；同一份内容也写在 ${live.logPath}。`)
          : `没能弹出观看窗口（${live.reason ?? '未知原因'}${live.fallback ? '，' + live.fallback : ''}）；会场对话仍然写在 ${live.logPath}。`,
      ].filter(Boolean);
      return { ok: true, message: lines.join('\n'), roomId: room.id, members: room.members, liveUrl: live.url ?? null };
    },
  }));

  // ---- 让一位发言 ----
  register(defineTool({
    name: 'meeting_speak',
    description: '让会议里**下一位**成员发言：把会议记录发给他，等他这一轮说完，把他的发言收回来记进会议。'
      + '这个调用会阻塞到他答完（通常几十秒到几分钟），期间不要重复调用。'
      + '**也可以点名**（传 member）：警长定了发言顺序、或要从死者左手边开始，就用它。',
    parameters: {
      roomId: { type: 'string', description: '房间号；省略时用你正在主持的那间' },
      member: {
        type: 'string',
        description: '可选。**点名**让谁发言：座位号（如 "3"）或会话 id。'
          + '省略 = 按游标走的下一位。点名不会打乱游标，下一轮照常接着走。',
      },
      waitSeconds: { type: 'number', description: `最多等多久（秒），默认 ${DEFAULT_WAIT_S}` },
      note: { type: 'string', description: '可选。想让这一位特别注意的一句话，会附加在会议记录后面' },
      audience: {
        type: 'array',
        items: { type: 'string' },
        description: '这一条发言**给谁看**。省略 = 公开（后面所有人都看得到）；'
          + '也可以写会话 id 或标签（如 ["tag:狼人"]）—— 狼人夜聊就靠它。',
      },
      report: {
        type: 'string',
        description: "返回值粒度：'full' 回显全文（默认）；'brief' 只回一行摘要"
          + '（发言全文照旧落盘、照旧进观战窗口，只是不回显进你的上下文）。',
      },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => textOut(v.message) },
    async execute(args, exec) {
      return withRoomLock(`room:${String(args?.roomId ?? '')}:${hostSessionId(exec)}`, async () => {
        let room;
        try {
          ({ room } = resolveRoom(exec, args?.roomId));
        } catch (error) {
          return fail(error?.message ?? String(error));
        }
        if (room.status === ROOM_CLOSED) return fail(`房间 ${room.id} 已经结束了。`);

        // 点名优先：警长定顺序 / 从死者左手边开始，都靠它。
        // 点名**不打乱游标** —— 下一位照常按原顺序走，所以它不会把轮次带歪。
        const pointed = args?.member === undefined || args?.member === null
          ? '' : String(args.member).trim();
        let member = null;
        if (pointed !== '') {
          try {
            member = resolveRoomMember(room, pointed, { allowOut: false });
          } catch (error) {
            return fail(error?.message ?? String(error));
          }
        } else {
          member = nextSpeaker(room);
        }
        if (!member) {
          return fail(isRoundsExhausted(room)
            ? `轮次已用完（${room.completedRounds}/${room.roundLimit} 轮）。请 meeting_close 收会，或者先 meeting_extend 加轮次。`
            : '本轮已经走完了，会议状态有点异常，请用 meeting_status 看看。');
        }

        const note = typeof args?.note === 'string' && args.note.trim() ? args.note.trim() : null;
        const report = resolveReport(args?.report);
        const visibility = resolveVisibility(args?.audience);
        // 点名插队（点的**不是**游标指向的那位）→ 说完不推进游标，顺序留在原地。
        // 否则点完 3 号，下一句会把刚说完的 3 号再问一遍（2026-10-17 真跑时抓到的）。
        // 反过来，点名的正好是"该轮到的那位"时要照常推进，否则会卡在他身上。
        const noAdvance = pointed !== '' && member !== nextSpeaker(room);
        let outcome;
        try {
          outcome = await speakOnce(room, member, {
            signal: exec?.signal,
            waitSeconds: args?.waitSeconds,
            note,
            noAdvance,
            ...visibility,
          });
        } catch (error) {
          return fail(`驱动 ${memberLabel(member)} 发言时出错: ${error?.message ?? String(error)}`);
        }
        return {
          ok: outcome.ok,
          message: renderSpeakOutcome(outcome, room, report),
          roomId: room.id,
          round: outcome.round,
          seat: outcome.seat,
          roundCompleted: outcome.roundCompleted,
          nextSpeaker: nextSpeaker(room)?.sessionId ?? null,
        };
      });
    },
  }));

  // ---- 跑一整轮 ----
  register(defineTool({
    name: 'meeting_round',
    description: '把当前这一轮剩下的成员**依次**跑完，直到最后一位受邀者发完言、这一轮结束。'
      + '每一位都要等他真的说完才轮到下一位，所以这个调用可能持续好几分钟；中途的发言都已经落盘，不会丢。',
    parameters: {
      roomId: { type: 'string', description: '房间号；省略时用你正在主持的那间' },
      waitSeconds: { type: 'number', description: `每位成员最多等多久（秒），默认 ${DEFAULT_WAIT_S}` },
      report: {
        type: 'string',
        description: "返回值粒度：'full' 回显全文（默认）；'brief' 每人只回一行"
          + '（全文照旧落盘、照旧进观战窗口，只是不回显进你的上下文）。',
      },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => textOut(v.message) },
    async execute(args, exec) {
      return withRoomLock(`room:${String(args?.roomId ?? '')}:${hostSessionId(exec)}`, async () => {
        let room;
        try {
          ({ room } = resolveRoom(exec, args?.roomId));
        } catch (error) {
          return fail(error?.message ?? String(error));
        }
        if (room.status === ROOM_CLOSED) return fail(`房间 ${room.id} 已经结束了。`);
        if (isRoundsExhausted(room)) {
          return fail(`轮次已用完（${room.completedRounds}/${room.roundLimit} 轮），请 meeting_close 收会。`);
        }

        const startedRound = room.round;
        const outcomes = [];
        let guard = 0;
        while (guard < MAX_MEMBERS + 1) {
          guard += 1;
          const member = nextSpeaker(room);
          if (!member) break;
          let outcome;
          try {
            // 会议就是要一位一位来，不能并发
            outcome = await speakOnce(room, member, {
              signal: exec?.signal,
              waitSeconds: args?.waitSeconds,
            });
          } catch (error) {
            outcomes.push({
              ok: false, round: room.round, seat: member.order, member,
              text: '', ms: 0, error: error?.message ?? String(error),
            });
            break;
          }
          outcomes.push(outcome);
          if (outcome.roundCompleted) break;
        }

        return {
          ok: true,
          message: renderRoundReport(outcomes, room, startedRound, resolveReport(args?.report)),
          roomId: room.id,
          round: room.round,
          completedRounds: room.completedRounds,
          roundsExhausted: room.roundsExhausted,
          outcomes: outcomes.map((o) => ({ seat: o.seat, sessionId: o.member.sessionId, ok: o.ok, chars: o.text.length })),
        };
      });
    },
  }));

  // ---- 私聊（狼人杀夜里问技能靠它） ----
  register(defineTool({
    name: 'meeting_whisper',
    description: '跟**某一位**成员私聊一轮：把话单独说给他，等他的回答收回来。'
      + '这条对话只有你和这位成员看得到 —— 其他人既看不到内容，也不会被投递。'
      + '**不占发言位、不推进轮次**，所以夜里问技能、单独交代都用它。',
    parameters: {
      roomId: { type: 'string', description: '房间号；省略时用你正在主持的那间' },
      member: { type: 'string', description: '跟谁私聊：座位号（如 "3"）或会话 id' },
      text: { type: 'string', description: '你要单独跟他说的话（问什么、要他做什么决定）' },
      expect: { type: 'string', description: '可选。期望的回答格式（如「只回：用解药 / 不救」）—— 这是软引导，不硬解析' },
      brief: { type: 'string', description: '可选。附一张**状态卡**（身份、技能余量、已知情报）—— 治"它忘了自己是女巫"' },
      historyCount: { type: 'number', description: '可选。附带最近几条**公开**记录（默认 0，不给历史）' },
      waitSeconds: { type: 'number', description: `最多等多久（秒），默认 ${DEFAULT_WAIT_S}` },
      report: { type: 'string', description: "返回值粒度：'full' 回显全文（默认）；'brief' 只回一行摘要 + 答案首行（省你的上下文）" },
      force: { type: 'boolean', description: 'true 则允许对**已出局**的成员投递（默认不允许：死人不能说话）。只在收尾发结局卡时才用' },
      audience: {
        type: 'array',
        items: { type: 'string' },
        description: '可选。这一问一答的**可见范围**。默认只有当事人看得到；'
          + '传了就是「定向公开」——投递仍然只给他一个人，但**记录对这些人可见**。'
          + '典型用法：警长竞选的上警发言（一个人说、全体听），此时传全部存活成员的 sessionId，'
          + '或传 tag:xxx。传空数组 = 真正公开。',
      },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => textOut(v.message) },
    async execute(args, exec) {
      return withRoomLock(`room:${String(args?.roomId ?? '')}:${hostSessionId(exec)}`, async () => {
        let room;
        try {
          ({ room } = resolveRoom(exec, args?.roomId));
        } catch (error) {
          return fail(error?.message ?? String(error));
        }
        if (room.status === ROOM_CLOSED) return fail(`房间 ${room.id} 已经结束了。`);

        let member;
        try {
          member = resolveRoomMember(room, args?.member, { allowOut: args?.force === true });
        } catch (error) {
          return fail(error?.message ?? String(error));
        }

        const text = String(args?.text ?? '').trim();
        if (!text) return fail('要跟他说的话（text）不能为空。');

        let outcome;
        try {
          outcome = await whisperOnce(room, member, {
            text,
            expect: typeof args?.expect === 'string' ? args.expect.trim() : null,
            brief: typeof args?.brief === 'string' ? args.brief.trim() : null,
            historyCount: Number.isInteger(args?.historyCount) ? args.historyCount : 0,
            signal: exec?.signal,
            waitSeconds: args?.waitSeconds,
            audience: args?.audience,
          });
        } catch (error) {
          return fail(`私聊 ${memberLabel(member)} 时出错: ${error?.message ?? String(error)}`);
        }

        return {
          ok: outcome.ok,
          message: renderWhisperOutcome(outcome, room, resolveReport(args?.report)),
          roomId: room.id,
          seat: member.order,
          sessionId: member.sessionId,
          chars: outcome.text.length,
        };
      });
    },
  }));

  // ---- 并发私聊（夜里问一圈 / 白天收票） ----
  register(defineTool({
    name: 'meeting_panel',
    description: '**并发**私聊一组人：同一条消息同时发给多位成员，各答各的、互不可见。'
      + '夜里一次问完守卫 / 狼队 / 女巫 / 预言家，或者白天收投票，都用它 —— '
      + '串行问是 N 倍等待，并发只要一趟。',
    parameters: {
      roomId: { type: 'string', description: '房间号；省略时用你正在主持的那间' },
      members: {
        type: 'array',
        items: { type: 'string' },
        description: '要问哪些人：座位号或会话 id 的数组（如 ["1","3","5"]）',
      },
      text: { type: 'string', description: '同时问他们的话（大家收到的是同一条）' },
      expect: { type: 'string', description: '可选。期望的回答格式（软引导，不硬解析）' },
      historyCount: { type: 'number', description: '可选。附带最近几条公开记录（默认 0，不给历史）' },
      waitSeconds: { type: 'number', description: `最多等多久（秒），默认 ${DEFAULT_WAIT_S}` },
      report: { type: 'string', description: "返回值粒度：'brief' 每人两行（推荐，省上下文）；'full' 每人全文（默认）" },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => textOut(v.message) },
    async execute(args, exec) {
      return withRoomLock(`room:${String(args?.roomId ?? '')}:${hostSessionId(exec)}`, async () => {
        let room;
        try {
          ({ room } = resolveRoom(exec, args?.roomId));
        } catch (error) {
          return fail(error?.message ?? String(error));
        }
        if (room.status === ROOM_CLOSED) return fail(`房间 ${room.id} 已经结束了。`);

        const refs = Array.isArray(args?.members) ? args.members : [];
        if (refs.length === 0) return fail('要指定问哪些人（members 传座位号或会话 id 的数组）');

        let targets;
        try {
          targets = refs.map((ref) => resolveRoomMember(room, ref, { allowOut: false }));
        } catch (error) {
          return fail(error?.message ?? String(error));
        }
        // 去重：同一个人被并发问两次，两边会抢他同一个回合
        const seen = new Set();
        targets = targets.filter((m) => {
          if (seen.has(m.sessionId)) return false;
          seen.add(m.sessionId);
          return true;
        });

        const text = String(args?.text ?? '').trim();
        if (!text) return fail('要问的话（text）不能为空。');

        let outcomes;
        try {
          outcomes = await panelOnce(room, targets, {
            text,
            expect: typeof args?.expect === 'string' ? args.expect.trim() : null,
            historyCount: Number.isInteger(args?.historyCount) ? args.historyCount : 0,
            signal: exec?.signal,
            waitSeconds: args?.waitSeconds,
          });
        } catch (error) {
          return fail(`并发私聊时出错: ${error?.message ?? String(error)}`);
        }

        return {
          ok: outcomes.some((o) => o.ok),
          message: renderPanelOutcome(outcomes, room, resolveReport(args?.report)),
          roomId: room.id,
          asked: outcomes.length,
          answered: outcomes.filter((o) => o.ok).length,
          failed: outcomes.filter((o) => !o.ok).map((o) => o.member.order),
        };
      });
    },
  }));

  // ---- 让一位成员出局 ----
  register(defineTool({
    name: 'meeting_kick',
    description: '让一位成员**出局**（狼人杀的放逐 / 夜里被刀 / 被毒）。'
      + '出局之后：不再轮到他发言、默认也不再接收投递。'
      + '**遗言要趁早问** —— 先用 `meeting_lastwords` 让他把话说完，再调这个'
      + '（踢完就只能靠 force 投递了，不如顺着流程走）。',
    parameters: {
      roomId: { type: 'string', description: '房间号；省略时用你正在主持的那间' },
      member: { type: 'string', description: '让谁出局：座位号（如 "3"）或会话 id' },
      reason: { type: 'string', description: '可选。原因（如「白天被投票放逐」「第 2 夜被刀」），会记进会议记录' },
      silent: { type: 'boolean', description: 'true 则不写这条出局公告（默认会写 —— "谁出局了"通常是公开信息）' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => textOut(v.message) },
    async execute(args, exec) {
      return withRoomLock(`room:${String(args?.roomId ?? '')}:${hostSessionId(exec)}`, async () => {
        let room;
        try {
          ({ room } = resolveRoom(exec, args?.roomId));
        } catch (error) {
          return fail(error?.message ?? String(error));
        }
        if (room.status === ROOM_CLOSED) return fail(`房间 ${room.id} 已经结束了。`);

        let member;
        try {
          member = resolveRoomMember(room, args?.member, { allowOut: false });
        } catch (error) {
          return fail(error?.message ?? String(error));
        }

        const reason = typeof args?.reason === 'string' && args.reason.trim() ? args.reason.trim() : null;
        try {
          kickMember(room, member, { reason });
        } catch (error) {
          return fail(error?.message ?? String(error));
        }

        if (args?.silent !== true) {
          record(room, {
            kind: 'system',
            seat: member.order,
            sessionId: member.sessionId,
            name: memberLabel(member),
            text: `【出局】${memberLabel(member)}${reason ? ` —— ${reason}` : ''}`,
          });
        }
        logEvent(room, 'member.kick', { seat: member.order, sessionId: member.sessionId, reason });
        store.save(room);

        const alive = activeMembers(room);
        const gone = outMembers(room);
        meetingConsole.gap(room.id);
        meetingConsole.emit(room.id, `⛔ ${memberLabel(member)} 出局${reason ? `（${reason}）` : ''}`);
        meetingConsole.note(room.id, `在场 ${alive.length} 人 / 已出局 ${gone.length} 人`);
        meetingConsole.gap(room.id);

        const next = nextSpeaker(room);
        return {
          ok: true,
          message: `${memberLabel(member)}（第 ${member.order} 位）已出局${reason ? ` —— ${reason}` : ''}。\n`
            + `在场 ${alive.length} 人：${alive.map((m) => `${m.order}.${memberLabel(m)}`).join('、') || '（无）'}\n`
            + `已出局 ${gone.length} 人：${gone.map((m) => m.order).join('、') || '（无）'}\n`
            + (next ? `下一位发言：${memberLabel(next)}（第 ${next.order} 位）` : '本轮已走完，或轮次已用完。'),
          roomId: room.id,
          seat: member.order,
          sessionId: member.sessionId,
          activeCount: alive.length,
          outCount: gone.length,
        };
      });
    },
  }));

  // ---- 遗言（死者公开发言：进记录，但不占位、不推进轮次） ----
  register(defineTool({
    name: 'meeting_lastwords',
    description: '让一位**已经出局**的成员公开发言（留遗言）。'
      + '这条发言**进公开记录**（后面别人投递时看得到），但**不占发言位、不推进轮次**。'
      + '狼人杀的遗言规则全靠它：首夜被刀的、首夜被毒的、白天被票出的，都该先留完遗言再往下走。',
    parameters: {
      roomId: { type: 'string', description: '房间号；省略时用你正在主持的那间' },
      member: { type: 'string', description: '让谁留遗言：座位号（如 "3"）或会话 id —— 允许传**已出局**的成员' },
      text: { type: 'string', description: '交代他的话（如「你昨晚被狼人杀了，请留遗言」）' },
      audience: {
        type: 'array',
        items: { type: 'string' },
        description: '可选。这条遗言给谁看：留空 = 公开（默认）；也可以填会话 id 或 tag:标签',
      },
      waitSeconds: { type: 'number', description: `最多等多久（秒），默认 ${DEFAULT_WAIT_S}` },
      report: { type: 'string', description: "返回值粒度：'full' 回显全文（默认）；'brief' 只回一行" },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => textOut(v.message) },
    async execute(args, exec) {
      return withRoomLock(`room:${String(args?.roomId ?? '')}:${hostSessionId(exec)}`, async () => {
        let room;
        try {
          ({ room } = resolveRoom(exec, args?.roomId));
        } catch (error) {
          return fail(error?.message ?? String(error));
        }
        if (room.status === ROOM_CLOSED) return fail(`房间 ${room.id} 已经结束了。`);

        let member;
        try {
          // allowOut: true —— 遗言本来就是说给死人听的
          member = resolveRoomMember(room, args?.member, { allowOut: true });
        } catch (error) {
          return fail(error?.message ?? String(error));
        }

        const text = String(args?.text ?? '').trim();
        if (!text) return fail('要交代他的话（text）不能为空。');

        const { audience } = resolveVisibility(args?.audience);
        let outcome;
        try {
          outcome = await lastWordsOnce(room, member, {
            text, audience, signal: exec?.signal, waitSeconds: args?.waitSeconds,
          });
        } catch (error) {
          return fail(`请 ${memberLabel(member)} 留遗言时出错: ${error?.message ?? String(error)}`);
        }

        const next = nextSpeaker(room);
        const head = `—— ${memberLabel(member)}（第 ${member.order} 位）的遗言 ——`;
        const body = outcome.ok ? outcome.text : `⚠️ ${outcome.error ?? '没收全'}\n${outcome.text}`;
        return {
          ok: outcome.ok,
          message: `${head}\n${body}\n\n（已进公开记录，不占发言位、不推进轮次。`
            + (next ? `下一位发言：${memberLabel(next)}（第 ${next.order} 位）` : '本轮已走完。') + '）',
          roomId: room.id,
          seat: member.order,
          sessionId: member.sessionId,
          chars: outcome.text.length,
        };
      });
    },
  }));

  // ---- 中止本轮（自爆 / 提前收场） ----
  register(defineTool({
    name: 'meeting_abort',
    description: '**中止当前轮**：这一轮剩下的成员不再发言，直接结束本轮（轮次 +1、游标归零）。'
      + '狼人杀的**自爆**就靠它 —— 有人在发言环节自爆，当场转入黑夜，剩下的人不能再说话。'
      + '注意：`meeting_round` 一旦开跑会把剩下的人依次问完、中途停不下来，'
      + '所以**打算留自爆余地时，请用 `meeting_speak` 一位一位点**。',
    parameters: {
      roomId: { type: 'string', description: '房间号；省略时用你正在主持的那间' },
      reason: { type: 'string', description: '可选。为什么中止（如「3 号狼人自爆」），会记进会议记录' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => textOut(v.message) },
    async execute(args, exec) {
      return withRoomLock(`room:${String(args?.roomId ?? '')}:${hostSessionId(exec)}`, async () => {
        let room;
        try {
          ({ room } = resolveRoom(exec, args?.roomId));
        } catch (error) {
          return fail(error?.message ?? String(error));
        }
        if (room.status === ROOM_CLOSED) return fail(`房间 ${room.id} 已经结束了。`);

        const reason = typeof args?.reason === 'string' && args.reason.trim() ? args.reason.trim() : null;
        const before = room.round;
        const after = abortRound(room, { reason });
        record(room, {
          kind: 'system', seat: null, sessionId: null, name: '主持人',
          text: `【本轮中止】第 ${before} 轮到此为止${reason ? ` —— ${reason}` : ''}`,
        });
        store.save(room);

        meetingConsole.gap(room.id);
        meetingConsole.emit(room.id, `⏹️ 第 ${before} 轮中止${reason ? `（${reason}）` : ''} → 进入第 ${after} 轮`);
        meetingConsole.gap(room.id);

        const next = nextSpeaker(room);
        return {
          ok: true,
          message: `第 ${before} 轮已中止${reason ? `（${reason}）` : ''}，现在进入第 ${after} 轮。\n`
            + (room.roundsExhausted
              ? '⚠️ 轮次已经用完（roundsExhausted = true），要接着跑得先用 meeting_extend 加轮次。'
              : (next ? `第 ${after} 轮第一位：${memberLabel(next)}（第 ${next.order} 位）` : '（本轮没有可发言的人）')),
          roomId: room.id,
          abortedRound: before,
          round: after,
          roundsExhausted: room.roundsExhausted,
        };
      });
    },
  }));

  // ---- 公告板（全房间共享的局面快照） ----
  register(defineTool({
    name: 'meeting_board',
    description: '读写**公告板**：全房间共享的一段状态文字（第几天 / 谁还活着 / 警长是谁 / 昨夜死讯 / 警徽在谁手上）。'
      + '写进去之后**每次投递都会自动附带** —— 治"AI 忘了现在是什么局面"，也省得你每轮口头重申。'
      + '不传 text = 读当前内容；传空串 = 清空。',
    parameters: {
      roomId: { type: 'string', description: '房间号；省略时用你正在主持的那间' },
      text: { type: 'string', description: '要写的局面快照；省略 = 只读；传空字符串 = 清空' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => textOut(v.message) },
    async execute(args, exec) {
      return withRoomLock(`room:${String(args?.roomId ?? '')}:${hostSessionId(exec)}`, async () => {
        let room;
        try {
          ({ room } = resolveRoom(exec, args?.roomId));
        } catch (error) {
          return fail(error?.message ?? String(error));
        }

        if (typeof args?.text === 'string') {
          const saved = setBoard(room, args.text);
          logEvent(room, 'board.write', { chars: saved ? saved.length : 0 });
          store.save(room);
          if (saved) {
            return {
              ok: true,
              message: `公告板已更新（${saved.length} 字），从下一条投递起自动附带：\n\n${saved}`,
              roomId: room.id, board: saved,
            };
          }
          return { ok: true, message: '公告板已清空。', roomId: room.id, board: null };
        }

        const current = room.board ?? null;
        return {
          ok: true,
          message: current
            ? `当前公告板（${current.length} 字）：\n\n${current}`
            : '公告板还是空的。用 meeting_board 写一句局面快照（第几天 / 谁还在 / 警长是谁），之后每次投递都会自动带上它。',
          roomId: room.id,
          board: current,
        };
      });
    },
  }));

  // ---- 角色卡（狼人杀的身份、阵营、技能余量） ----
  register(defineTool({
    name: 'meeting_role',
    description: '给一位成员设**角色卡**（身份 / 阵营 / 说明 / 技能余量 / 持久状态卡）。'
      + '设好之后**每次投递都会自动带上这张卡** —— 不用你次次手写，它也不会忘。'
      + '另外用 `use` 可以扣一次技能：**扣光了会被直接拒绝**，不靠你记。',
    parameters: {
      roomId: { type: 'string', description: '房间号；省略时用你正在主持的那间' },
      member: { type: 'string', description: '给谁设：座位号（如 "3"）或会话 id' },
      name: { type: 'string', description: '角色名（如「女巫」「狼人」「预言家」）' },
      team: { type: 'string', description: '可选。阵营（如「好人」「狼人」）' },
      note: { type: 'string', description: '可选。角色说明（如「解药毒药各一瓶；同一夜不可既救又毒；不可自救」）' },
      skills: {
        type: 'object',
        // 必须显式写 additionalProperties —— DSH 的 author 层编译器对 object 类型强制要求，
        // 漏了它整个插件都激活不了（2026-10-16 踩过；回归检查见工具链的 check-tool-schema）。
        additionalProperties: true,
        description: '可选。技能余量，**中文键**（如 {"解药":1,"毒药":1}）。只覆盖传进来的键',
      },
      brief: { type: 'string', description: '可选。**持久状态卡**（如「你查过 3 号，他是狼人」）—— 每次投递自动带上' },
      use: { type: 'string', description: '可选。扣一次技能（如 "解药"）：扣光了直接拒绝' },
      silent: { type: 'boolean', description: 'true 则不记进会议记录（默认记，且**只对当事人可见**）' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => textOut(v.message) },
    async execute(args, exec) {
      return withRoomLock(`room:${String(args?.roomId ?? '')}:${hostSessionId(exec)}`, async () => {
        let room;
        try {
          ({ room } = resolveRoom(exec, args?.roomId));
        } catch (error) {
          return fail(error?.message ?? String(error));
        }

        let member;
        try {
          // 出局的人也要能设角色（收尾发结局卡时要用），所以这里 allowOut
          member = resolveRoomMember(room, args?.member, { allowOut: true });
        } catch (error) {
          return fail(error?.message ?? String(error));
        }

        let used = null;
        if (typeof args?.use === 'string' && args.use.trim()) {
          try {
            used = { skill: args.use.trim(), left: useSkill(member, args.use.trim()) };
          } catch (error) {
            return fail(error?.message ?? String(error));
          }
        }

        const before = member.role?.name ?? null;
        const role = setRole(member, {
          name: args?.name, team: args?.team, note: args?.note,
          skills: args?.skills, brief: args?.brief,
        });

        if (args?.silent !== true) {
          // 真人席位（2026-10-19 修）：他没有"投递"这条路，角色卡**只能**写进记录里。
          // 哥哥上一局就是这么踩的 —— 开局没收到自己是什么身份、预言家查完人也没收到
          // 查验结果，全靠猜。现在 human 的卡直接落成一条 humanPrivate 记录，
          // 会场页面能看到正文，别的成员照样看不到。
          const isHuman = member.human === true;
          record(room, {
            kind: 'system',
            seat: member.order,
            sessionId: member.sessionId,
            name: memberLabel(member),
            text: isHuman
              ? `【身份卡 · 只给你看】\n${renderRoleBrief(member) ?? '（这张卡还是空的）'}`
                + `${used ? `\n\n（本次用掉了「${used.skill}」，还剩 ${used.left} 次）` : ''}`
              : `【角色】${memberLabel(member)} → ${role.name ?? '（未命名）'}`
                + `${used ? ` · 使用「${used.skill}」（剩 ${used.left}）` : ''}`,
            channel: 'private',
            audience: [member.sessionId],
            humanPrivate: isHuman,
          });
        }
        logEvent(room, 'member.role', {
          seat: member.order, sessionId: member.sessionId, name: role.name ?? null,
          from: before, used: used?.skill ?? null,
        });
        store.save(room);

        const card = renderRoleBrief(member) ?? '（这张卡还是空的）';
        // 只记"发了卡"，不记他是什么 —— 日志玩家读得到
        meetingConsole.note(room.id, `🎭 已给 ${memberLabel(member)} 发角色卡 —— 内容只给他本人`);
        return {
          ok: true,
          message: [
            `${memberLabel(member)}（第 ${member.order} 位）的角色卡：`,
            '',
            card,
            '',
            '之后每次投递给他的消息都会自动带上这张卡。',
            used ? `本次用掉了「${used.skill}」，还剩 ${used.left} 次。` : '',
          ].filter(Boolean).join('\n'),
          roomId: room.id,
          seat: member.order,
          sessionId: member.sessionId,
          role: role.name ?? null,
          skills: role.skills ?? {},
        };
      });
    },
  }));

  // ---- 主持人插话 ----
  register(defineTool({
    name: 'meeting_say',
    description: '主持人自己往会议记录里插一句话（不占成员发言位、不推进轮次）。'
      + '适合中途纠偏、补充要求、回应某位成员的发言——它会被后面发言的成员看到。',
    parameters: {
      roomId: { type: 'string', description: '房间号；省略时用你正在主持的那间' },
      text: { type: 'string', description: '要记入会议的话' },
      audience: {
        type: 'array',
        items: { type: 'string' },
        description: '这句话**给谁看**。省略 = 公开；也可以写会话 id 或标签（如 ["tag:狼人"]）'
          + '—— 夜里对狼队的交代就用它。',
      },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => textOut(v.message) },
    async execute(args, exec) {
      let room;
      try {
        ({ room } = resolveRoom(exec, args?.roomId));
      } catch (error) {
        return fail(error?.message ?? String(error));
      }
      const text = String(args?.text ?? '').trim();
      if (!text) return fail('要记入的内容不能为空。');
      const visibility = resolveVisibility(args?.audience);
      record(room, {
        kind: 'host', seat: 0, sessionId: room.host.sessionId, name: '主持人', text,
        ...visibility,
      });
      logEvent(room, 'host.note', { chars: text.length, audience: visibility.audience });
      store.save(room);
      meetingConsole.gap(room.id);
      meetingConsole.emit(room.id, `【主持人】${text.replace(/\r?\n/g, '　')}`);
      meetingConsole.gap(room.id);
      return {
        ok: true,
        message: visibility.audience
          ? `已记入会议记录（第 ${room.round} 轮，**只给 ${visibility.audience.join('、')} 看**）。`
          : `已记入会议记录（第 ${room.round} 轮）。后面发言的成员都会看到。`,
        roomId: room.id,
      };
    },
  }));

  // ---- 看状态 ----
  register(defineTool({
    name: 'meeting_status',
    description: '看当前会议的状态：议题、轮次进度、每位成员发过几次言、下一位该谁。'
      + '也可以通过 transcript 参数直接调出完整会议记录。',
    parameters: {
      roomId: { type: 'string', description: '房间号；省略时用你正在主持的那间' },
      transcript: { type: 'boolean', description: 'true 则连完整会议记录一起返回' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => textOut(v.message) },
    async execute(args, exec) {
      let room;
      try {
        ({ room } = resolveRoom(exec, args?.roomId));
      } catch (error) {
        return fail(error?.message ?? String(error));
      }
      const parts = [renderStatus(room)];
      if (args?.transcript === true) {
        parts.push('', '——— 完整会议记录 ———', renderFullTranscript(room));
      }
      return { ok: true, message: parts.join('\n'), roomId: room.id, status: room.status };
    },
  }));

  // ---- 加轮次 ----
  register(defineTool({
    name: 'meeting_extend',
    description: '给会议再加几轮（轮次用完但事情还没谈完时用）。只有主持人能加。',
    parameters: {
      roomId: { type: 'string', description: '房间号；省略时用你正在主持的那间' },
      rounds: { type: 'number', description: '在当前基础上再加几轮，默认 1' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => textOut(v.message) },
    async execute(args, exec) {
      let room;
      try {
        ({ room } = resolveRoom(exec, args?.roomId));
      } catch (error) {
        return fail(error?.message ?? String(error));
      }
      if (room.status === ROOM_CLOSED) return fail(`房间 ${room.id} 已经结束了，不能再加轮次。`);
      const add = Number.isFinite(Number(args?.rounds)) ? Math.max(1, Math.floor(Number(args.rounds))) : 1;
      const before = room.roundLimit;
      room.roundLimit = Math.min(room.roundLimit + add, MAX_ROUNDS);
      room.roundsExhausted = false;
      if (room.round <= room.completedRounds) room.round = room.completedRounds + 1;
      logEvent(room, 'extended', { from: before, to: room.roundLimit });
      store.save(room);
      return {
        ok: true,
        message: `轮次上限 ${before} → ${room.roundLimit}。现在在第 ${room.round} 轮，下一位：${nextSpeaker(room) ? memberLabel(nextSpeaker(room)) : '（本轮已走完）'}。`,
        roomId: room.id,
      };
    },
  }));

  // ---- 收会 ----
  register(defineTool({
    name: 'meeting_close',
    description: '结束会议并生成会议纪要（落成 markdown 文件）。'
      + '调用前请先根据会议记录写好总结：这是要提交给用户的"会议成果"。'
      + '收会之后这间房就不能再发言了。',
    parameters: {
      roomId: { type: 'string', description: '房间号；省略时用你正在主持的那间' },
      summary: { type: 'string', description: '你对整场会议的总结（必填，这是提交给用户的正文）' },
      conclusions: { type: 'string', description: '会议达成的结论，一行一条' },
      actions: { type: 'string', description: '会后待办 / 下一步，一行一条' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => textOut(v.message) },
    async execute(args, exec) {
      let room;
      try {
        ({ room } = resolveRoom(exec, args?.roomId));
      } catch (error) {
        return fail(error?.message ?? String(error));
      }
      if (room.status === ROOM_CLOSED) return fail(`房间 ${room.id} 已经结束过了（${fmtTime(room.closedAt, ZONE)}）。`);
      const summary = String(args?.summary ?? '').trim();
      if (!summary) return fail('summary 不能为空——那是要提交给用户的会议成果。');

      room.status = ROOM_CLOSED;
      room.closedAt = Date.now();
      logEvent(room, 'closed', { completedRounds: room.completedRounds, roundLimit: room.roundLimit });
      const minutes = renderMinutes(room, {
        summary,
        conclusions: args?.conclusions,
        actions: args?.actions,
      }, ZONE);
      let saved = null;
      const wantMinutes = cfg.get().minutesEnabled;
      if (wantMinutes) {
        try {
          saved = writeMinutes(room, minutes);
        } catch (error) {
          logEvent(room, 'minutes.failed', { error: error?.message ?? String(error) });
        }
      } else {
        logEvent(room, 'minutes.skipped', { reason: 'minutesEnabled=false' });
      }
      store.save(room);

      // 会场实况：收会也落到同一个窗口里，用户能当场看到会议成果
      meetingConsole.gap(room.id);
      meetingConsole.emit(room.id, '────────────────────────────────────────────────');
      meetingConsole.note(room.id, `会议结束 —— 完成 ${room.completedRounds}/${room.roundLimit} 轮，共 ${room.transcript.length} 条记录`);
      meetingConsole.emit(room.id, !wantMinutes
        ? '（纪要已按设置关闭，不落盘）'
        : (saved === null ? '（纪要写盘失败）' : `纪要：${saved}`));
      meetingConsole.emit(room.id, '────────────────────────────────────────────────');
      for (const line of minutes.split(/\r?\n/)) meetingConsole.emit(room.id, line);
      meetingConsole.emit(room.id, '（会议已结束，这个窗口可以关掉了）');

      const lines = [
        `会议已结束：${room.id}（「${room.topic}」）`,
        `完成 ${room.completedRounds}/${room.roundLimit} 轮，共 ${room.transcript.length} 条记录。`,
        !wantMinutes
          ? 'ℹ️ 设置里关掉了「生成会议纪要」，所以这次没有写盘 —— 但内容就在下面，你照样可以转给用户。'
          : (saved === null
            ? '⚠️ 纪要写盘失败，但上面这些内容你已经拿到了。'
            : `纪要已保存：${saved}`),
        '',
        '下面就是提交给用户的会议成果全文（请在你的回复里转述给用户，别只说"已保存"）：',
        '',
        minutes,
      ];
      return {
        ok: true,
        message: lines.join('\n'),
        roomId: room.id,
        minutesPath: saved,
        minutes,
      };
    },
  }));

  // ---- 收会之后的清理：留一个手动删除的口子 ----
  register(defineTool({
    name: 'meeting_forget',
    description: '删掉一间已结束的会议室（连同它的纪要文件）。只用于清理，不能删还在进行中的会议。',
    parameters: {
      roomId: { type: 'string', description: '要删除的房间号' },
      confirm: { type: 'boolean', description: '必须显式传 true 才会真的删' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => textOut(v.message) },
    async execute(args, exec) {
      const me = hostSessionId(exec);
      const roomId = String(args?.roomId ?? '').trim();
      if (args?.confirm !== true) return fail('要真的删除，请把 confirm 传成 true。');
      if (!isValidRoomId(roomId)) return fail('房间号格式不对。');
      const room = store.read(roomId);
      if (!room) return fail(`找不到房间 ${roomId}。`);
      if (!isHost(room, me)) return fail('只有主持人能删自己的会议室。');
      if (room.status !== ROOM_CLOSED) return fail(`房间 ${roomId} 还没结束，不能删。`);
      const okDeleted = store.remove(roomId);
      return okDeleted
        ? { ok: true, message: `已删除 ${roomId} 及其纪要。` }
        : fail('删除失败，文件可能被占用。');
    },
  }));

  // ---- 通道自检 ----
  register(defineTool({
    name: 'meeting_selftest',
    description: '自检「星辰会议室」的跨会话通道：挑一个会话投一条探针消息过去，看他能不能回话。'
      + '不建房间、不落盘、不改任何东西。刚装机、或怀疑"投递不出去 / 收不到回复"时用它定位。',
    parameters: {
      session: { type: 'string', description: '目标会话（名册编号或会话 id）；省略则自动挑一个不是自己的会话' },
      timeoutSeconds: { type: 'number', description: '最多等多久（秒），默认 120' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => textOut(v.message) },
    async execute(args, exec) {
      const me = hostSessionId(exec);
      const lines = ['【星辰会议室 · 通道自检】', ''];
      const problems = [];

      const hasPrompt = typeof ctx.sessionController?.prompt === 'function';
      lines.push(`${hasPrompt ? '✅' : '❌'} sessionController.prompt —— ${hasPrompt ? '可用' : '不可用'}`);
      if (!hasPrompt) problems.push('宿主没有 sessionController.prompt，投递通道不可用');

      const { entries, error } = await roster({ refresh: true });
      if (error) {
        lines.push(`❌ 会话名册 —— ${error}`);
        problems.push(error);
      } else {
        lines.push(`✅ 会话名册 —— 读到 ${entries.length} 个可邀请会话`);
      }

      const want = String(args?.session ?? '').trim();
      let target = null;
      if (want) {
        target = /^\d+$/.test(want)
          ? (entries[Number(want) - 1] ?? null)
          : (entries.find((e) => e.sessionId === want) ?? null);
      } else {
        target = entries.find((e) => e.sessionId !== me) ?? null;
      }
      if (!target) {
        lines.push('', '⚠️ 没有可用的目标会话：至少要有另一个会话才能自检。');
        return { ok: false, message: lines.join('\n'), problems };
      }
      lines.push(`🎯 目标会话：${target.title || shortId(target.sessionId)}（${target.sessionId}）`
        + `${target.log?.warn ? ` · ⚠️ ${target.log.label}` : ''}`, '');
      if (target.log?.level === 'huge') {
        lines.push('ℹ️ 这个会话的日志很大（≥8 MB）：读回来约 0.3 秒，但压缩后的上下文仍可能有'
          + '几十万 token，模型首字会慢 —— timeoutSeconds 要给足。'
          + '只想快速验证通道本身，可以换一个日志小的会话。', '');
      }

      const token = newToken();
      const probe = '【星辰会议室 · 自检探针】\n\n'
        + '这是一条通道自检消息，你不需要做别的事。请只回复一句话：\n\n星辰会议室自检通过\n\n'
        + `（探针编号 ${token}，不必在回复里提到它。）`;
      const waitMs = Math.max(30, Math.min(Number(args?.timeoutSeconds) || 120, 1800)) * 1000;
      const started = Date.now();
      const result = await relay.relay({
        sessionId: target.sessionId,
        text: probe,
        token,
        source: { summary: '星辰会议室 · 通道自检' },
        markWaitMs: waitMs,
        replyWaitMs: waitMs,
        signal: exec?.signal,
      });

      lines.push(`⏱️ 耗时 ${Math.round((Date.now() - started) / 1000)} 秒，阶段：${result.phase}`);
      if (result.text) {
        lines.push('', `📨 ${target.title || shortId(target.sessionId)} 的回话：`, '', result.text);
      }
      const pass = result.ok && result.text.length > 0;
      lines.push('', pass
        ? '✅ 通道是通的：消息投递出去了，回复也收回来了。'
        : `❌ 没跑通：${result.error ?? '没有收到任何回话'}`);
      if (!pass) {
        problems.push(result.error ?? '没有收到回话');
        lines.push('', '排查方向：',
          '· 目标会话可能正忙（正跑一个很长的 turn），换一个空闲会话再试；',
          '· 目标会话可能已被归档或删除，用 meeting_roster 的 refresh 重看清单；',
          '· 都对不上，就把上面的「阶段」原样报给用户。');
      }
      return { ok: pass, message: lines.join('\n'), phase: result.phase, problems };
    },
  }));

  // ---- 封存名单 ----
  register(defineTool({
    name: 'meeting_seal',
    description: '维护「封存名单」。一个会话开不开得了口由 DSH 的**归档状态**决定'
      + '（$DSH_HOME/storages/workspace.json 的 archivedSessionIds，本工具只读）：'
      + '归档的会话被 archived-session-gate 挡着，投递进去连模型请求都不发，所以请不动。'
      + '这里存的是另一层东西 ——「用户为什么封存它」的理由与时间。'
      + 'action=list 看名单（同时显示它到底归档了没有），seal 记理由，unseal 摘掉记录。'
      + '**本工具不会去改 DSH 的归档状态**，那是用户在界面上的动作。',
    parameters: {
      action: { type: 'string', description: 'list 看名单 / seal 加人 / unseal 摘人，默认 list', enum: ['list', 'seal', 'unseal'] },
      session: { type: 'string', description: 'seal / unseal 的目标：名册编号或完整会话 id' },
      reason: { type: 'string', description: 'seal 的理由，会一直显示在名册里（比如「上下文过载，手动封存」）' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => textOut(v.message) },
    async execute(args, exec) {
      const action = String(args?.action ?? 'list').trim().toLowerCase();

      if (action === 'list') {
        const list = sealed.all();
        if (list.length === 0) {
          return {
            ok: true,
            message: `封存名单是空的。\n记录文件：${sealed.file}\n归档状态：${archive.file}`,
            sessions: [],
          };
        }
        const lines = [`封存名单（${list.length} 位，无法参加会议）：`, ''];
        for (const entry of list) {
          lines.push(`· ${entry.title || shortId(entry.sessionId)}`);
          lines.push(`  id: ${entry.sessionId}`);
          lines.push(entry.archived
            ? '  状态：⛔ 会话已归档 —— 投递会被挡回，一个字都说不了'
            : '  状态：⚠️ 只在记录里，会话**没有归档** —— 技术上还叫得醒');
          if (entry.reason) lines.push(`  理由：${entry.reason}`);
          if (entry.sealedAt) lines.push(`  记录于：${fmtTime(entry.sealedAt, ZONE)}`);
        }
        lines.push('', `记录文件：${sealed.file}`);
        lines.push(`归档状态：${archive.file}（只读）`);
        return { ok: true, message: lines.join('\n'), sessions: list };
      }

      if (action !== 'seal' && action !== 'unseal') {
        return fail(`不认识的 action：${action}（只能是 list / seal / unseal）`);
      }
      const want = String(args?.session ?? '').trim();
      if (!want) return fail(`${action} 需要指定 session（名册编号或完整会话 id）`);

      const { entries, error } = await roster();
      if (error) return fail(error);
      const hit = /^\d+$/.test(want)
        ? entries[Number(want) - 1]
        : entries.find((e) => e.sessionId === want);
      if (!hit && /^\d+$/.test(want)) return fail(`名册里没有第 ${want} 号会话。`);
      const target = hit ?? { sessionId: want, title: null };

      if (action === 'seal') {
        if (target.sessionId === hostSessionId(exec)) {
          return fail('不能封存自己 —— 封存记录是写给「已经叫不醒的会话」的，而你现在醒着。');
        }
        const entry = sealed.seal({
          sessionId: target.sessionId,
          title: target.title,
          reason: args?.reason,
          sealedBy: 'meeting_seal',
        });
        rosterCache = { at: 0, entries: [] };   // 名册缓存里还带着旧的封存状态，丢掉
        return {
          ok: true,
          message: `已记下封存：${entry.title || entry.sessionId}\n理由：${entry.reason ?? '（没写）'}\n`
            + (entry.archived
              ? '状态：✅ 这个会话**已经在 DSH 里归档了** —— 名册会标 ⛔，meeting_open 会拒绝邀请它。'
              : '状态：⚠️ 记录写好了，但**这个会话在 DSH 里还没有归档** —— 技术上仍然叫得醒。\n'
                + '      要真正封住它，得在 DSH 界面里把那个会话归档。\n'
                + '      归档之后名册会自动跟上：本插件读的就是 DSH 自己的归档名单，不需要再来记一次。'),
          entry,
        };
      }

      const removed = sealed.unseal(target.sessionId);
      if (removed) rosterCache = { at: 0, entries: [] };
      if (!removed) return fail(`${target.sessionId} 本来就不在封存记录里。`);
      const stillArchived = archive.has(target.sessionId);
      return {
        ok: true,
        message: `已摘掉封存记录：${target.title || target.sessionId}。\n`
          + (stillArchived
            ? '⚠️ **但它在 DSH 里仍然是归档状态**，还是叫不醒 —— 摘记录不等于解封。\n'
              + '      要让它真的回来，得在 DSH 界面上解归档。'
            : '✅ 它也不在归档名单里，所以现在请得动它。'),
      };
    },
  }));

  ctx.effect(() => () => { /* 工具与路由都由各自的 effect 注销，这里只留一个显式的卸载点 */ });

  // ---------------------------------------------------------------- /meeting 斜杠命令
  //
  // DSH 的斜杠命令走**命令平面**：UI 直接把 handler 的返回值渲染出来，不产生模型消息、
  // 不花 token、不影响 KV cache（见 @deepseek-ai/dsh-commands 的 README）。
  // 所以"看状态""开实况页面"这类事天生适合做成命令；而"开一场新会"要挑成员、定轮次，
  // 参数太多，就照 dsh-plan-mode 的做法 —— 由命令显式提交一条消息交给模型去办。
  //
  // `commands` 用响应式注入：注册表存在才注册，别为了一个斜杠命令把整个插件拖下水。
  const MEETING_USAGE = [
    '星辰会议室 · 用法',
    '  /meeting                 弹出会议准备页（选普通会议 / 狼人杀，挑人参会、定主持人）',
    '  /meeting status          看你现在这场会的状态（轮次、成员、下一位该谁）',
    '  /meeting list            列出最近的会议室',
    '  /meeting live [房间号]    打开会场实况网页（QQ 群样式，不叫模型、立刻弹浏览器）',
    '  /meeting open <议题>      让模型开一场新会（要邀请成员、定轮次，所以交给模型办）',
    '  /meeting help            这一页',
  ].join('\n');

  /** 这个会话主持的所有房间（新的在前）。 */
  const roomsHostedBy = (sessionId) => store.list().filter((r) => r.host?.sessionId === String(sessionId ?? ''));

  async function runMeetingCommand(invocation) {
    const agent = invocation?.agent ?? null;
    const sessionId = String(agent?.id ?? '');
    const raw = String(invocation?.rawInput ?? '').trim();
    const spaceAt = raw.search(/\s/);
    const word = (spaceAt < 0 ? raw : raw.slice(0, spaceAt)).toLowerCase();
    const tail = spaceAt < 0 ? '' : raw.slice(spaceAt).trim();

    if (word === 'help' || word === '-h' || word === '--help') {
      return { kind: 'success', text: MEETING_USAGE };
    }

    if (word === 'list') {
      const rooms = store.list().slice(0, 10);
      if (rooms.length === 0) return { kind: 'success', text: '还没有开过会。先让模型调用 meeting_open 开一间。' };
      const lines = [`最近的会议室（共 ${store.list().length} 间）：`, ''];
      for (const room of rooms) {
        const label = room.status === 'closed' ? '已结束' : (room.status === 'open' ? '未开场' : '进行中');
        const mine = room.host?.sessionId === sessionId ? ' ← 你主持的' : '';
        lines.push(`· ${room.id}　[${label}]　${room.topic}`);
        lines.push(`  主持人 ${room.host?.title || shortId(room.host?.sessionId)} · `
          + `${room.members.length} 位成员 · ${room.completedRounds}/${room.roundLimit} 轮 · `
          + `${room.transcript.length} 条发言${mine}`);
      }
      lines.push('', `实况页面：把房间号填进 /meeting live <房间号>`);
      return { kind: 'success', text: lines.join('\n') };
    }

    if (word === 'live') {
      const rooms = roomsHostedBy(sessionId);
      const roomId = tail || rooms.find((r) => r.status === 'live')?.id || rooms[0]?.id || store.list()[0]?.id || '';
      if (!roomId || !isValidRoomId(roomId)) {
        return { kind: 'error', text: `没找到可看的会议室。${MEETING_USAGE}` };
      }
      const room = store.read(roomId);
      const live = await openLive(roomId, room?.topic ?? roomId);
      if (live.opened && live.mode === 'web') {
        return { kind: 'success', text: `会场实况已打开：${live.url}\n（页面每 2 秒自动刷新，房间 ${roomId}）` };
      }
      if (live.opened) {
        return { kind: 'success', text: `已打开控制台窗口跟随会议日志：${live.logPath}` };
      }
      return {
        kind: 'error',
        text: `没能打开观看窗口：${live.reason ?? '未知原因'}${live.fallback ? `（${live.fallback}）` : ''}\n`
          + `原始记录仍然写在：${live.logPath}`,
      };
    }

    if (word === 'open') {
      if (!tail) {
        return { kind: 'error', text: `开一场会要说明议题。用法：/meeting open <议题>\n\n${MEETING_USAGE}` };
      }
      if (!agent || typeof agent.followup !== 'function') {
        return { kind: 'error', text: '这个环境里拿不到当前会话，没法把开会的请求交给模型。' };
      }
      try {
        agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{
            type: 'text',
            text: `【来自 /meeting 命令】请用 meeting_open 开一场星辰会议室，议题：${tail}\n\n`
              + '成员由你按议题来挑（先 meeting_roster 看名册）。开完把房间号和实况链接告诉用户。',
          }],
          source: { kind: SOURCE_KIND_COMMAND, form: 'notice', summary: `星辰会议室 · 开新会：${tail}` },
        });
        return { kind: 'success', text: `已把这个请求交给模型：开一场会，议题「${tail}」。\n（它会先看名册挑成员，然后开房）` };
      } catch (error) {
        return { kind: 'error', text: `提交失败：${error?.message ?? String(error)}` };
      }
    }

    if (word !== '' && word !== 'status') {
      return { kind: 'error', text: `不认识的子命令：${word}\n\n${MEETING_USAGE}` };
    }

    // 不带子命令 = **弹出会议准备页**（2026-10-16 哥哥定的入口）。
    // 想看当前这一场的状态就打 `/meeting status`，两条路各走各的。
    if (word === '') {
      const setup = await openSetup();
      return { kind: setup.opened ? 'success' : 'error', text: setup.text };
    }

    // status：看我现在这场会的状态
    const rooms = roomsHostedBy(sessionId);
    if (rooms.length === 0) {
      return {
        kind: 'success',
        text: `你还没有主持过会议。\n\n${MEETING_USAGE}`,
      };
    }
    const room = rooms.find((r) => r.status === 'live') ?? rooms[0];
    const live = room.status === 'live' ? '（用 /meeting live 打开实况页面）' : '';
    return { kind: 'success', text: `${renderStatus(room)}${live ? `\n${live}` : ''}` };
  }

  /**
   * `/meeting` 的命令定义。**每个 agent 一份**。
   *
   * 为什么不注册一次全局就完事：命令注册表 `commands` 挂在 **agent 自己的 scope** 里
   * （`dsh-base/cordis.patch.yml` 第 307 行，跟 skill / goal / plan-mode / token-meter
   * 并列在一个嵌套块里），根上下文 `inject` 不到它 —— 2026-10-14 实测：插件加载正常，
   * 用户在输入框打 `/` 却看不到 meeting。所以改成对每个 agent 在 `agent.ctx` 下注册，
   * README 对这条路径的说法是「该定义只对这个 agent 生效」—— 正是我们要的。
   */
  const meetingCommandDefinition = () => ({
    name: 'meeting',
    description: '星辰会议室：看状态 / 开会场实况 / 开一场新会',
    input: { hint: '[live|list|open <议题>|help]' },
    handler: (invocation) => runMeetingCommand(invocation),
  });

  /** 注册过的 agent（resume 会再次触发 agent/created，重复注册同名命令会抛异常）。 */
  const commandRegistered = new WeakSet();

  /**
   * 给一个 agent 的命令平面注册命令。
   * 任何一步拿不到就静静跳过 —— `agent/created` 是 serial 事件，**监听器抛错会让整个
   * agent 创建失败**，一个斜杠命令绝不该有这种权力。
   */
  const registerCommandFor = (agent) => {
    if (!agent || typeof agent !== 'object' || commandRegistered.has(agent)) return;
    try {
      const host = agent.ctx;
      if (!host || typeof host.inject !== 'function') return;
      commandRegistered.add(agent);
      host.inject(['commands'], (cmdCtx) => {
        try {
          cmdCtx.effect(() => cmdCtx.commands.register(meetingCommandDefinition()));
        } catch { /* 注册失败也不抛给宿主 */ }
      });
    } catch { /* 同上：命令注册不该影响任何会话 */ }
  };

  if (typeof ctx.inject === 'function') {
    ctx.inject(['agents'], (agentsCtx) => {
      // 插件加载时已经活着的会话
      try {
        const live = agentsCtx.agents?.list?.() ?? [];
        for (const agent of live) registerCommandFor(agent);
      } catch { /* 列不出已有会话就算了，新会话照常注册 */ }
      // 之后创建 / 恢复的会话
      agentsCtx.on('agent/created', (payload) => {
        registerCommandFor(payload?.agent ?? payload);
      });
    });
  } else if (typeof ctx.get === 'function' && ctx.get('commands')) {
    // 退化路径（离线自检桩）：没有响应式注入，但服务已经在了
    try {
      ctx.effect(() => ctx.commands.register(meetingCommandDefinition()));
    } catch { /* 同上 */ }
  }

  // ---------------------------------------------------------------- 准备开局

  /** 法官手册的位置：投递给主持人时直接告诉它，省得它满盘找。 */
  const manualPath = fileURLToPath(new URL('./WEREWOLF.md', import.meta.url));

  /** 用户自己的席位 id —— 它**不是会话**，投递不到它（见 lib/meeting.js 的 isPassive）。 */
  const USER_SEAT_ID = 'user:self';

  /** 夹一个整数进区间；给不出数就返回 null，由调用方兜底。 */
  function clampNum(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(min, Math.min(max, Math.round(n)));
  }

  /** 规则开关：只收白名单里的键，值一律布尔 —— 房间文件是唯一真相，别塞进奇怪东西。 */
  function normalizeGameRules(raw) {
    const out = {};
    const source = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    for (const rule of WOLF_RULES) {
      out[rule.key] = source[rule.key] === undefined ? rule.on === true : source[rule.key] === true;
    }
    return out;
  }

  /** 开局时写给主持人（法官）的那封信 —— 它读完就该自己动起来。 */
  function openingBrief(room, liveUrl) {
    const g = room.game ?? {};
    const isWolf = g.kind === 'werewolf';
    const players = room.members.map((m, i) => `　${i + 1}. ${m.title || m.sessionId}`).join('\n');
    const lines = [
      `【星辰会议室 · 新开局】房间 ${room.id}`,
      `类型：${isWolf ? `狼人杀 · ${g.size} 人局` : '普通会议'}　议题：${room.topic}`,
    ];
    if (isWolf && g.board) {
      lines.push(`板子：${g.board.wolves} 狼 / ${g.board.gods} 神（${g.board.godList.join('、')}）/ ${g.board.villagers} 民`);
    }
    lines.push('', '参会（顺序即发言顺序）：', players, '');
    const humanSeat = room.members.find((m) => m.human === true);
    if (humanSeat) {
      lines.push(
        `⚠️ ${humanSeat.order} 号「${humanSeat.title}」是**用户本人**，不是 AI 会话：`,
        '　· 他**在轮转里** —— `meeting_speak` 轮到他时，会议会停下等他在会场页面发言'
          + '（工具会一直等到他说完或超时，几分钟，不用你额外操心）；',
        `　· 你**也可以单独找他**：\`meeting_whisper\` 的 member 填 \`${humanSeat.order}\` 或`
          + '`user:self`，消息会直接出现在他的会场页面上，他回的话也会回到你这里；',
        '　· 他随时可能插话 —— 那些话进公开记录，每次投递都会带上；',
        ...(g.myRole
          ? [`　· **他指定自己要当「${g.myRole}」** —— \`meeting_role\` 发给他时用这个身份，别发成别的。`]
          : []),
        '',
      );
    }
    if (isWolf) {
      lines.push('本局规则口径：');
      for (const rule of WOLF_RULES) {
        lines.push(`　${g.rules?.[rule.key] ? '✅' : '⬜'} ${rule.name} —— ${rule.desc}`);
      }
    } else {
      lines.push(`轮次上限：${room.roundLimit} 轮`);
    }
    lines.push(`发言软上限：${g.speakLimit} 字（软约束，超了不拦，只在投递里提醒）`, '');
    lines.push(`你是本局**主持人${isWolf ? '（法官）' : ''}**，meeting_* 工具都在你手上。现在开局：`);
    if (isWolf) {
      lines.push('　① meeting_status 确认房间与座位；');
      lines.push('　② 用 meeting_role 逐人发身份（只给本人可见，别广播）；');
      lines.push('　③ 宣布「天黑请闭眼」，进入第一夜。');
      lines.push(`法官手册（开局流程、夜里怎么问、边界怎么判）：${manualPath}`);
    } else {
      lines.push('　① meeting_status 确认房间与座位；');
      lines.push('　② 用 meeting_say 交代议题与要求；');
      lines.push('　③ 用 meeting_speak（一位一位）或 meeting_round（一次跑完一轮）让成员发言。');
    }
    if (liveUrl) lines.push('', `会场实况（用户在看这个页面）：${liveUrl}`);
    return lines.join('\n');
  }

  /** 把开局这件事交给主持人 —— 后台动作，不等回话，页面不必为它多等一分钟。 */
  async function deliverOpening(room, hostEntry, liveUrl) {
    try {
      await relay.relay({
        sessionId: hostEntry.sessionId,
        text: openingBrief(room, liveUrl),
        token: newToken(),
        source: {
          summary: `星辰会议室 · 开局 · ${room.topic}`,
          roomId: room.id,
          topic: room.topic,
        },
      });
    } catch (error) {
      meetingConsole.note(room.id, `⚠️ 没能把开局交给主持人：${error?.message ?? String(error)}`);
    }
  }

  /**
   * 从准备页开一局（`POST /api/setup/start`）。
   *
   * 这是一条**绕开工具**的内部开房路径，原因是：`/meeting` 弹出的是插件的网页，
   * 用户点"开始"的那一刻并没有哪个会话在"调用工具"——而 meeting_* 全都校验
   * "调用者必须是主持人"。所以这里由插件自己建房、把主持人记成用户指定的那位；
   * 建完之后，那位就能照常用 meeting_* 接着推进了。
   *
   * 两条规矩照旧：
   *   · **准入先判**：成员只能从过了 `admitPolicy` 的名册里挑（微信端 / QQ 群进不来）；
   *   · **主持人不占参会名额**：createRoom 本来就拒绝"主持人邀请自己"。
   */
  async function setupStart(input) {
    const kind = input?.kind === 'werewolf' ? 'werewolf' : 'meeting';
    const joinSelf = input?.joinSelf === true;
    const size = clampNum(input?.size, 2, MAX_MEMBERS + (joinSelf ? 1 : 0)) ?? 6;

    const loaded = await roster();
    if (loaded.error) throw new Error(loaded.error);
    // 已封存的会话直接排除 —— 投递进去会被归档门挡下，选进来只会白等
    // （2026-10-19 哥哥发现准备页还能选到封存的小星辰）
    const byId = new Map(
      loaded.entries.filter((e) => !(e.sealed?.archived)).map((e) => [String(e.sessionId), e]),
    );

    const hostEntry = byId.get(String(input?.host ?? ''));
    if (!hostEntry) throw new Error('主持人必须从可邀请的会话里选（被准入规则挡下的进不了会场）');

    const members = [];
    const seen = new Set();
    for (const raw of Array.isArray(input?.members) ? input.members : []) {
      const id = String(raw ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const entry = byId.get(id);
      if (!entry) throw new Error(`「${id}」不在可邀请名册里（被准入规则挡下，或已归档）`);
      members.push(entry);
    }
    if (members.length === 0) throw new Error('至少要选一位参会 AI');
    if (seen.has(hostEntry.sessionId)) {
      throw new Error(`「${hostEntry.title || hostEntry.sessionId}」被同时指定为主持人和参会者 ——`
        + '主持人是独立席位，请二选一');
    }

    // 座位顺序（2026-10-19 哥哥要求）：默认按点选先后；选「随机」就当场洗牌。
    // 狼人杀里座位号会被写进发言顺序、警徽流、「刀 N 号」，所以「谁坐几号」本身也是信息，
    // 一直按点选顺序来等于给所有人固定剧本。洗牌用 crypto，不写死种子。
    if (input?.seatOrder === 'random') {
      for (let i = members.length - 1; i > 0; i -= 1) {
        const j = randomInt(i + 1);
        [members[i], members[j]] = [members[j], members[i]];
      }
    }

    const expect = size - (joinSelf ? 1 : 0);
    if (members.length !== expect) {
      throw new Error(`参会人数对不上：设定 ${size} 人${joinSelf ? '（含你自己）' : ''}，`
        + `需要 ${expect} 位 AI，实际选了 ${members.length} 位`);
    }

    const topic = kind === 'werewolf'
      ? `狼人杀 · ${size} 人局`
      : (typeof input?.topic === 'string' && input.topic.trim()
        ? input.topic.trim().slice(0, 200)
        : '（未命名会议）');

    const rules = kind === 'werewolf' ? normalizeGameRules(input?.rules) : null;
    const speakLimit = clampNum(input?.speakLimit, SPEECH_LIMIT_MIN, SPEECH_LIMIT_MAX)
      ?? cfg.get().speechLimitChars;
    const rounds = kind === 'werewolf'
      ? MAX_ROUNDS
      : (clampNum(input?.rounds, 1, MAX_ROUNDS) ?? cfg.get().defaultRounds);

    const room = createRoom({
      host: { sessionId: hostEntry.sessionId, title: hostEntry.title, cwd: hostEntry.cwd },
      topic,
      rounds,
      members: members.map((m) => ({ sessionId: m.sessionId, title: m.title, cwd: m.cwd })),
    });

    // 本局元数据：类型 / 板子 / 规则口径 / 发言软上限。
    // 规则本身**不进代码**，只作为"这一局的口径"交给法官，由它按手册去判。
    room.game = {
      kind,
      size,
      joinSelf,
      speakLimit,
      rules,
      board: kind === 'werewolf' ? (WOLF_BOARDS[size] ?? null) : null,
      // 用户自己指定的身份（空 = 交给法官随机）。插件不替他发，只在开局信里
      // 告诉法官"他想当这个"（2026-10-19 哥哥要求能自选身份）。
      myRole: kind === 'werewolf' && typeof input?.myRole === 'string' && input.myRole.trim()
        ? input.myRole.trim().slice(0, 20)
        : null,
      openedBy: 'setup-page',
    };

    // 用户自己也上桌：加一个**人类席位**。
    // 他不能像会话那样被投递，但他**在轮转里**（2026-10-19 改）—— 轮到他时后台会真的
    // 停下来等他在会场页面发言；想随时插话也行，那条走 POST /api/room/<id>/say。
    //
    // 座位号（2026-10-19 加）：他可以在准备页填「我坐第几号」。填了就把自己插到那个位置，
    // 后面的 AI 顺延；不填就坐末位。**插进去之后必须重排每个人的 order** —— order 才是
    // 座位号，数组下标只是顺序。
    if (joinSelf) {
      const wantSeat = clampNum(input?.mySeat, 1, size);
      const at = wantSeat === undefined
        ? room.members.length
        : Math.max(0, Math.min(wantSeat - 1, room.members.length));
      room.members.splice(at, 0, {
        sessionId: USER_SEAT_ID,
        title: '你（哥哥）',
        cwd: null,
        order: at + 1,
        joinedAt: Date.now(),
        status: 'invited',
        spokeCount: 0,
        lastSpokeRound: null,
        tags: ['user'],
        human: true,
      });
      room.members.forEach((m, i) => { m.order = i + 1; });
    }
    logEvent(room, 'setup.start', {
      kind, size, joinSelf, speakLimit, rules, host: hostEntry.sessionId,
      members: members.map((m) => m.sessionId),
    });
    store.save(room);
    meetingConsole.emit(room.id, `【开局】${room.topic}　主持人 ${hostEntry.title || hostEntry.sessionId}`
      + `　${members.length} 位参会（另外${joinSelf ? '用户也在场' : '用户不在场'}）`);

    // 会场实况：跟 /meeting live 走同一套（web 优先，失败退回控制台，再不行就只写文件）
    let liveUrl = null;
    try {
      const live = await openLive(room.id, room.topic);
      liveUrl = live.url ?? null;
    } catch { /* 打不开窗口不是开局失败 */ }

    void deliverOpening(room, hostEntry, liveUrl);

    return {
      roomId: room.id,
      topic: room.topic,
      kind,
      hostTitle: hostEntry.title || hostEntry.sessionId,
      memberCount: members.length,
      joinSelf,
      liveUrl,
    };
  }

  // ---------------------------------------------------------------- 只读网页

  const webServer = ctx.webServer;
  if (webServer) {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler(req, res) {
        if (denyNonLoopback(req, res)) return;
        // 记下这次请求的 Host —— 有人访问过页面，lib/webport.js 就能靠它反推出准确端口
        recentHost = req?.headers?.host ?? recentHost;
        // ⚠️ 所有 JSON 响应都必须走这里，而且**必须防重复写**。
        // 2026-10-19 血的教训：某个页面路由先 `res.writeHead(200)`、再在 `res.end(...)` 的
        // 参数里渲染 HTML，渲染抛错 → `.catch` 里又调 `json(500)` → Node 抛
        // `ERR_HTTP_HEADERS_SENT`。这是**未捕获异常**，直接把整个 host 进程干退出，
        // 桌面上看到的就是「DSH 崩了」。
        // 一个页面出错只该是那个页面 500，绝不该带上整个应用。
        const json = (code, body) => {
          if (res.headersSent || res.writableEnded) return;   // 已经回过一次了，静默丢弃
          try {
            res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(body));
          } catch { /* 连接已经断了，随它去 */ }
        };
        /** 渲染整页：**先求值、后写头** —— 渲染炸了还能体面回 500。 */
        const sendPage = (render) => {
          let html;
          try {
            html = render();
          } catch (error) {
            json(500, { ok: false, error: error?.message ?? String(error) });
            return;
          }
          if (res.headersSent || res.writableEnded) return;
          try {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(html);
          } catch { /* 同上 */ }
        };
        let pathname = '/';
        try {
          pathname = new URL(String(req.url || '/'), 'http://127.0.0.1').pathname;
        } catch { /* 保持默认 */ }
        const rest = pathname.startsWith(ROUTE) ? pathname.slice(ROUTE.length) : pathname;

        // 自检用：lib/webport.js 就是靠这个端点确认"这个端口确实是我们"
        if (rest === '/api/ping' || rest === '/api/ping/') {
          json(200, { ok: true, plugin: name, version: pluginVersion() });
          return;
        }

        // 会场实况网页（QQ 群样式）：/live/<房间号>
        const liveMatch = /^\/live\/([^/]+)\/?$/.exec(rest);
        if (liveMatch) {
          const roomId = decodeURIComponent(liveMatch[1]);
          if (!isValidRoomId(roomId)) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('房间号不合法');
            return;
          }
            sendPage(() => renderLiveHtml({ route: ROUTE, roomId, fontScale: cfg.get().fontScale ?? 1 }));
          return;
        }

        // 会议准备页：选类型 → 填参数 → 挑人 → 开局。
        // `/meeting`（不带参数）弹的就是它，也可以直接敲 /setup。
        if (rest === '/setup' || rest === '/setup/' || rest === '/new' || rest === '/new/') {
          roster().then((loaded) => {
            if (loaded.error) { json(500, { ok: false, error: loaded.error }); return; }
            // 已封存（归档）的会话不该出现在名单里 —— 选进来也投递不到，
            // 点了只会白等（2026-10-19 哥哥在准备页看到封存的小星辰还能选）。
            const inviteable = loaded.entries.filter((m) => !(m.sealed?.archived));
            sendPage(() => renderSetupHtml({
              route: ROUTE,
              members: inviteable,
              blocked: loaded.blocked ?? [],
              archivedCount: loaded.entries.length - inviteable.length,
              humanWaitSeconds: Math.round(humanWaitLimitMs() / 1000),
              fontScale: cfg.get().fontScale ?? 1,
            }));
          }).catch((error) => {
            json(500, { ok: false, error: error?.message ?? String(error) });
          });
          return;
        }

        // 准备页点「开始」打的就是这里：建房，再把"你该开局了"交给主持人。
        if (rest === '/api/setup/start' || rest === '/api/setup/start/') {
          if (req.method !== 'POST') {
            json(405, { ok: false, error: '只接受 POST' });
            return;
          }
          let body = '';
          req.on('data', (chunk) => { body += chunk; if (body.length > 65536) req.destroy(); });
          req.on('end', () => {
            let payload = null;
            try { payload = JSON.parse(body || '{}'); } catch { payload = null; }
            if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
              json(400, { ok: false, error: '请求体不是合法的 JSON 对象' });
              return;
            }
            setupStart(payload)
              .then((result) => json(200, { ok: true, ...result }))
              .catch((error) => json(400, { ok: false, error: error?.message ?? String(error) }));
          });
          return;
        }

        if (rest === '/api/config' || rest === '/api/config/') {
          if (req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; if (body.length > 8192) req.destroy(); });
            req.on('end', () => {
              let patch = null;
              try { patch = JSON.parse(body || '{}'); } catch { patch = null; }
              if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
                json(400, { ok: false, error: '请求体不是合法的 JSON 对象' });
                return;
              }
              const result = cfg.set(patch);
              json(200, { ok: true, applied: result.applied, rejected: result.rejected, config: result.values });
            });
            return;
          }
          json(200, {
            ok: true,
            version: pluginVersion(),
            dir: rootDir,
            configFile: cfg.file,
            archiveFile: archive.file,
            minutesDir: minutesDirNow(),
            editableKeys: cfg.editableKeys,
            config: cfg.get(),
            stats: {
              rooms: store.list().length,
              minutes: store.list().filter((r) => r.status === 'closed').length,
              archived: archive.all().length,
            },
            sealed: sealedAll().map((entry) => ({
              sessionId: entry.sessionId,
              title: entry.title,
              reason: entry.reason,
              archived: entry.archived,
            })),
          });
          return;
        }

        if (rest === '/api/rooms' || rest === '/api/rooms/') {
          const rooms = store.list().map((room) => ({
            id: room.id,
            topic: room.topic,
            goal: room.goal,
            status: room.status,
            round: room.round,
            completedRounds: room.completedRounds,
            roundLimit: room.roundLimit,
            createdAt: room.createdAt,
            updatedAt: room.updatedAt,
            closedAt: room.closedAt,
            host: room.host.title || room.host.sessionId,
            memberCount: room.members.length,
            turns: room.transcript.length,
          }));
          json(200, { ok: true, root: store.rootDir, rooms });
          return;
        }

        const roomMatch = /^\/api\/room\/([^/]+)\/?$/.exec(rest);
        if (roomMatch) {
          // 这个接口是**对外**的（会场实况页 / 任何能发 HTTP 的进程），所以一律脱敏 ——
          // 身份卡、逐条身份表、夜里私聊全抹掉，只留公开记录。
          // 唯一例外：人类和法官的一对一，会场页面必须看得见（`keepHumanPrivate`）。
          // 主持人要看完整记录走 `meeting_status` 工具，那条有会话身份校验。
          const room = redactRoom(store.read(decodeURIComponent(roomMatch[1])),
            {
              keepHumanPrivate: true,
              // 上警发言是 `audience = 全体`。对其他 AI 是公开的，但在脱敏这条路上
              // 会被当成私聊抹掉 —— 2026-10-19 哥哥就是这么一个字都没看到。
              // 传 userSeatId，「audience 里包含真人」的记录就按"给真人看的"保留。
              userSeatId: USER_SEAT_ID,
              // 11 个人的夜间私聊各留一句「（私聊内容，不入档）」占位，页面几十屏空白。
              // 对会场页面来说，与真人无关的私聊**整条丢掉**才干净。
              dropUnrelatedPrivate: true,
            });
          if (!room) {
            json(404, { ok: false, error: '房间不存在' });
            return;
          }
          json(200, { ok: true, room, minutes: readMinutes(room) });
          return;
        }

        // 用户在自己这场会里发言（人类旁观席）—— 不占轮转、随时可以插话。
        // 这是"我也参加"那一勾真正落地的地方：他说话走 HTTP，不走会话投递。
        const sayMatch = /^\/api\/room\/([^/]+)\/say\/?$/.exec(rest);
        if (sayMatch) {
          if (req.method !== 'POST') {
            json(405, { ok: false, error: '只接受 POST' });
            return;
          }
          const room = store.read(decodeURIComponent(sayMatch[1]));
          if (!room) {
            json(404, { ok: false, error: '房间不存在' });
            return;
          }
          if (room.status === ROOM_CLOSED) {
            json(409, { ok: false, error: '这一场已经结束了' });
            return;
          }
          const seat = (room.members ?? []).find((m) => m.human === true);
          if (!seat) {
            json(409, { ok: false, error: '这一局没有你的席位（开局时没勾「我也参加」）' });
            return;
          }
          let body = '';
          req.on('data', (chunk) => { body += chunk; if (body.length > 16384) req.destroy(); });
          req.on('end', () => {
            let payload = null;
            try { payload = JSON.parse(body || '{}'); } catch { payload = null; }
            const text = String(payload?.text ?? '').trim();
            if (!text) {
              json(400, { ok: false, error: '发言不能为空' });
              return;
            }
            try {
              const clipped = text.slice(0, 4000);
              // 2026-10-19 哥哥要的两件事都落在这里：
              // ①「to: 'host'」= 只发给法官的悄悄话；不传就是对全场说。
              // ②正好轮到他发言时，这条记录就是**他这一轮的发言**（record 会推进游标）；
              //   不是轮到他，就只是插话、不占位。
              const toHost = String(payload?.to ?? '') === 'host';
              const turn = nextSpeaker(room);
              const isTurn = !toHost && !!turn && turn.human === true && turn.order === seat.order;
              const { item } = record(room, {
                kind: isTurn ? 'member' : 'user',
                seat: seat.order,
                sessionId: seat.sessionId,
                name: seat.title,
                text: clipped,
                channel: toHost ? 'private' : 'public',
                audience: toHost ? [room.host.sessionId] : null,
                humanPrivate: toHost,
              });
              if (!isTurn) {
                seat.spokeCount = (seat.spokeCount ?? 0) + 1;
                seat.status = 'spoke';
                seat.lastSpokeRound = room.round;
              }
              logEvent(room, 'user.say', { round: room.round, chars: clipped.length, toHost });
              store.save(room);
              meetingConsole.emit(room.id,
                `💬【${seat.title}】${toHost ? '（只发给主持人）' : ''}`
                + `${clipped.length > 200 ? `${clipped.slice(0, 200)}…` : clipped}`);
              json(200, { ok: true, round: room.round, at: item.at, toHost, isTurn });
            } catch (error) {
              json(500, { ok: false, error: error?.message ?? String(error) });
            }
          });
          return;
        }

        if (rest === '/' || rest === '' || rest === '/index.html') {
          sendPage(() => renderIndexHtml(store.rootDir));
          return;
        }

        json(404, {
          ok: false,
          error: 'not found',
          routes: [
            `${ROUTE}/`,
            `${ROUTE}/setup`,
            `${ROUTE}/api/ping`,
            `${ROUTE}/api/setup/start`,
            `${ROUTE}/api/config`,
            `${ROUTE}/api/rooms`,
            `${ROUTE}/api/room/<id>`,
            `${ROUTE}/live/<id>`,
          ],
        });
      },
    }));
  } else {
    console.error('[xiaoxingchen-meeting] webServer 不可用，跳过只读页面（工具不受影响）');
  }
}

/** 只读页面：房间列表 + 点开看完整会议记录。故意做得极小，不引任何前端依赖。 */
function renderIndexHtml(rootDir) {
  const escaped = String(rootDir).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>星辰会议室</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;padding:24px;font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:1100px}
  h1{font-size:20px;margin:0 0 4px}
  .sub{opacity:.6;font-size:13px;margin-bottom:20px}
  .room{border:1px solid rgba(128,128,128,.3);border-radius:10px;padding:14px 16px;margin-bottom:12px;cursor:pointer}
  .room:hover{border-color:rgba(128,128,128,.6)}
  .topic{font-weight:600}
  .meta{opacity:.65;font-size:13px;margin-top:6px}
  .badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid currentColor;opacity:.8;margin-right:6px}
  .live{color:#2f6df6;text-decoration:none;border-bottom:1px dashed currentColor}
  .live:hover{opacity:.8}
  pre{white-space:pre-wrap;word-break:break-word;background:rgba(128,128,128,.1);padding:14px;border-radius:8px;font-size:13px;max-height:70vh;overflow:auto}
  .turn{border-left:3px solid rgba(128,128,128,.35);padding:2px 0 2px 12px;margin:10px 0}
  .who{font-size:13px;opacity:.7}
  button{margin-bottom:16px;padding:6px 14px;border-radius:8px;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit;cursor:pointer}
  .empty{opacity:.6}
</style></head><body>
<h1>星辰会议室</h1>
<div class="sub">房间目录：${escaped}</div>
<div id="list" class="empty">加载中…</div>
<div id="detail"></div>
<script>
const ZONE='Asia/Shanghai';
const fmt=(t)=>{try{return new Date(t).toLocaleString('zh-CN',{timeZone:ZONE,hour12:false})}catch{return String(t)}};
const esc=(s)=>String(s??'').replace(/[&<>]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const STATUS={open:'已开房',live:'进行中',closed:'已结束'};
async function loadList(){
  const box=document.getElementById('list');
  const res=await fetch('${ROUTE}/api/rooms').then(r=>r.json()).catch(()=>null);
  if(!res||!res.ok){box.textContent='读取失败';return}
  if(res.rooms.length===0){box.innerHTML='<div class="empty">还没有开过会。</div>';return}
  box.innerHTML=res.rooms.map(r=>'<div class="room" data-id="'+esc(r.id)+'">'
    +'<div class="topic">'+esc(r.topic)+'</div>'
    +'<div class="meta"><span class="badge">'+esc(STATUS[r.status]||r.status)+'</span>'
    +esc(r.id)+' · 主持人 '+esc(r.host)+' · '+r.memberCount+' 位成员 · '
    +r.completedRounds+'/'+r.roundLimit+' 轮 · '+r.turns+' 条记录 · '+fmt(r.createdAt)
    +' <a class="live" href="${ROUTE}/live/'+esc(r.id)+'" target="_blank"'
    +' onclick="event.stopPropagation()">▷ 会场实况</a></div></div>').join('');
  box.querySelectorAll('.room').forEach(el=>el.onclick=()=>loadRoom(el.dataset.id));
}
async function loadRoom(id){
  const box=document.getElementById('detail');
  box.innerHTML='<button onclick="document.getElementById(\\'detail\\').innerHTML=\\'\\'">← 收起</button><div class="empty">加载中…</div>';
  const res=await fetch('${ROUTE}/api/room/'+encodeURIComponent(id)).then(r=>r.json()).catch(()=>null);
  if(!res||!res.ok){box.innerHTML='<div class="empty">读取失败</div>';return}
  const room=res.room;
  const head='<h2 style="font-size:17px">'+esc(room.topic)+'</h2>'
    +'<div class="meta"><span class="badge">'+esc(STATUS[room.status]||room.status)+'</span>'
    +esc(room.id)+' · 主持人 '+esc(room.host.title||room.host.sessionId)
    +' · 成员 '+room.members.map(m=>esc(m.title||m.sessionId)).join('、')
    +' · '+room.completedRounds+'/'+room.roundLimit+' 轮</div>';
  const turns=room.transcript.map(t=>{
    const who=t.kind==='host'?(t.round===1?'主持人 · 开场':'主持人'):(esc(t.name||'成员')+' · 第 '+t.round+' 轮 · 第 '+t.seat+' 位');
    const flag=t.timedOut?' ⚠️超时':'';
    return '<div class="turn"><div class="who">'+who+flag+' · '+fmt(t.at)+'</div><pre style="background:none;padding:6px 0;max-height:none">'+esc(t.text||'（无内容）')+'</pre></div>';
  }).join('');
  const minutes=res.minutes?'<h3 style="font-size:15px">会议纪要</h3><pre>'+esc(res.minutes)+'</pre>':'';
  box.innerHTML='<button onclick="document.getElementById(\\'detail\\').innerHTML=\\'\\'">← 收起</button>'+head+turns+minutes;
}
loadList();
</script>
</body></html>`;
}
