/**
 * 星辰会议室 —— host 半身。
 *
 * 一句话：让小星辰们跨会话开会。
 *
 * 一场会议长这样：
 *   主持人 meeting_open 开房（定议题、目标、轮次、按顺序邀请成员）
 *     → 按邀请顺序 meeting_speak 一位一位发言（每次阻塞到对方说完）
 *     → 最后一位成员发完 = 一轮结束；够轮次或达成目标就 meeting_close
 *     → 收会时生成纪要，主持人把成果提交给哥哥
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
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRoomStore, isValidRoomId } from './lib/store.js';
import { createRelay, SOURCE_KIND } from './lib/relay.js';
import { createInventory } from './lib/inventory.js';
import { createSealedList } from './lib/sealed.js';
import { createArchiveReader } from './lib/archive.js';
import { createMeetingConsole } from './lib/console-log.js';
import { createConfigStore } from './lib/config.js';
import { renderLiveHtml } from './lib/live.js';
import { resolveLiveUrl } from './lib/webport.js';
import { existsSync, readFileSync } from 'node:fs';
import {
  createRoom, record, logEvent, nextSpeaker, isRoundsExhausted, isHost, isMember,
  memberLabel, renderStatus, renderFullTranscript, formatSpeakingPrompt,
  ROOM_LIVE, ROOM_CLOSED, MAX_MEMBERS, MAX_ROUNDS,
} from './lib/meeting.js';
import { renderMinutes } from './lib/minutes.js';
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
  // 封存名单：归档状态归 DSH 管，这里存的是「哥哥为什么封存她」——理由、时间、仪式记录。
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

  /** 纪要目录：`minutesDir` 配了就用它，空着就用插件自己的 minutes/。 */
  function minutesDirNow() {
    try {
      const dir = cfg.get().minutesDir;
      return dir && String(dir).trim() ? String(dir).trim() : store.minutesDir;
    } catch {
      return store.minutesDir;
    }
  }
  const minutesPathOf = (roomId) => join(minutesDirNow(), `${roomId}.md`);

  /** 写纪要。返回写入路径；`minutesEnabled` 关掉时返回 null（不落盘、也不报错）。 */
  function writeMinutes(roomId, markdown) {
    if (!cfg.get().minutesEnabled) return null;
    const dir = minutesDirNow();
    if (dir === store.minutesDir) return store.saveMinutes(roomId, markdown) === null ? null : store.minutesFile(roomId);
    const file = join(dir, `${roomId}.md`);
    atomicWriteText(file, markdown);
    return file;
  }

  /** 读纪要：先在配置目录找，再回落到插件自己的 minutes/。 */
  function readMinutes(roomId) {
    const custom = minutesDirNow();
    if (custom !== store.minutesDir) {
      try {
        const file = join(custom, `${roomId}.md`);
        if (existsSync(file)) return readFileSync(file, 'utf8');
      } catch { /* 读不到就回落到默认目录，不是错误 */ }
    }
    return store.readMinutes(roomId);
  }

  /**
   * 按 `liveMode` 把会场亮给哥哥看。
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

  const textOut = (text) => [{ type: 'text', text }];
  const fail = (message) => ({ ok: false, message });

  // ---------------------------------------------------------------- 会话名册

  let rosterCache = { at: 0, entries: [] };

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
    return { entries: out, error: null };
  }

  async function roster({ refresh = false } = {}) {
    const now = Date.now();
    if (!refresh && rosterCache.entries.length > 0 && now - rosterCache.at < ROSTER_TTL_MS) {
      return { entries: rosterCache.entries, error: null, cached: true };
    }
    const loaded = await loadRoster();
    if (!loaded.error) rosterCache = { at: now, entries: loaded.entries };
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
    // 封存状态必须实时查：名册有 15 秒缓存，刚 seal 的那位在缓存里还带着旧的 null
    return picked.map((entry) => ({ ...entry, sealed: sealed.find(entry.sessionId) }));
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
  async function speakOnce(room, member, { signal, waitSeconds, note } = {}) {
    const token = newToken();
    // 下限只防呆（0/负数/NaN 已经被 || 兜住），不设高门槛：
    // 想快速探测的调用方就该能探测，不能被迫干等半分钟。
    const waitMs = Math.max(5, Math.min(Number(waitSeconds) || DEFAULT_WAIT_S, 3600)) * 1000;
    const settings = cfg.get();
    const prompt = formatSpeakingPrompt(room, member, token, {
      note: note || null,
      recentCount: settings.contextRecentCount,
      speechLimitChars: settings.speechLimitChars,
    });
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
    });
    logEvent(room, 'speak.result', {
      round: item.round, seat: member.order, phase: result.phase, chars: result.text.length,
      roundCompleted, via: result.via ?? null,
    });
    store.save(room);

    // 会场实况：把这一位的发言原样打出去，哥哥在控制台窗口里就能看着她们说话
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

  /** 一位成员发言的结果 → 给主持人看的文本。 */
  function renderSpeakOutcome(outcome, room) {
    const lines = [];
    const flag = outcome.ok ? '' : ` — ⚠️ ${outcome.error ?? '未完成'}`;
    lines.push(`【第 ${outcome.round} 轮 · 第 ${outcome.seat} 位 · ${memberLabel(outcome.member)}】${flag}`);
    lines.push('');
    lines.push(outcome.text || '（这位成员这一轮没有留下文字）');
    lines.push('');
    lines.push(`用时 ${Math.round(outcome.ms / 1000)} 秒。${outcome.roundCompleted
      ? `**本轮结束**，已完成 ${room.completedRounds}/${room.roundLimit} 轮。`
      : `下一位：${nextSpeaker(room) ? `${memberLabel(nextSpeaker(room))}（第 ${nextSpeaker(room).order} 位）` : '本轮已走完'}`}`);
    return lines.join('\n');
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
        if (entry.sealed?.archived) bits.push('⛔ 已封存（安息）');
        else if (entry.sealed) bits.push('⛔ 在封存记录里');
        bits.push(`${entry.log?.warn ? '⚠️ ' : ''}${entry.log?.label ?? '体量未知'}`);
        lines.push(`${index + 1}. ${bits.join(' · ')}`);
        lines.push(`   id: ${entry.sessionId}`);
        if (entry.sealed) {
          const why = entry.sealed.reason ?? '（没写理由）';
          const when = entry.sealed.sealedAt ? ` · ${fmtTime(entry.sealed.sealedAt, ZONE)}` : '';
          lines.push(`   ⛔ 封存理由：${why}${when}`);
          lines.push(entry.sealed.archived
            ? '      会话已归档，她安息了 —— 归档门会替她挡下一切投递，不会再有回话'
            : '      只在封存记录里，会话**没有归档** —— 技术上还叫得醒');
        }
      });
      const archCount = entries.filter((e) => e.sealed?.archived).length;
      if (archCount > 0) {
        lines.push('', `⛔ 名册里有 ${archCount} 位已经封存（会话已归档）：她们安息了，请勿打扰 —— `
          + '归档门会挡下一切投递，meeting_open 也会直接拒绝邀请她们。');
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
          + '\n\n换人吧。归档是哥哥在 DSH 界面上的动作，本插件只读归档状态、改不了它；'
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
          host: { sessionId: me, title: null, cwd: exec?.agent?.session?.header?.cwd ?? null },
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
        `轮次用完、或你判断目标已达成，就调用 meeting_close 收会${cfg.get().minutesEnabled ? '并生成纪要' : ''}，然后把成果提交给哥哥。`,
        live.opened
          ? (live.mode === 'web'
            ? `会场实况已经弹出来了：${live.url}\n（浏览器里那个页面每 2 秒自动刷新；同一份内容也追加写在 ${live.logPath}）`
            : `已为这场会议弹出一个控制台窗口，哥哥能实时看到会场对话；同一份内容也写在 ${live.logPath}。`)
          : `没能弹出观看窗口（${live.reason ?? '未知原因'}${live.fallback ? '，' + live.fallback : ''}）；会场对话仍然写在 ${live.logPath}。`,
      ].filter(Boolean);
      return { ok: true, message: lines.join('\n'), roomId: room.id, members: room.members, liveUrl: live.url ?? null };
    },
  }));

  // ---- 让一位发言 ----
  register(defineTool({
    name: 'meeting_speak',
    description: '让会议里**下一位**成员发言：把会议记录发给他，等他这一轮说完，把他的发言收回来记进会议。'
      + '这个调用会阻塞到他答完（通常几十秒到几分钟），期间不要重复调用。',
    parameters: {
      roomId: { type: 'string', description: '房间号；省略时用你正在主持的那间' },
      waitSeconds: { type: 'number', description: `最多等多久（秒），默认 ${DEFAULT_WAIT_S}` },
      note: { type: 'string', description: '可选。想让这一位特别注意的一句话，会附加在会议记录后面' },
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

        const member = nextSpeaker(room);
        if (!member) {
          return fail(isRoundsExhausted(room)
            ? `轮次已用完（${room.completedRounds}/${room.roundLimit} 轮）。请 meeting_close 收会，或者先 meeting_extend 加轮次。`
            : '本轮已经走完了，会议状态有点异常，请用 meeting_status 看看。');
        }

        const note = typeof args?.note === 'string' && args.note.trim() ? args.note.trim() : null;
        let outcome;
        try {
          outcome = await speakOnce(room, member, {
            signal: exec?.signal,
            waitSeconds: args?.waitSeconds,
            note,
          });
        } catch (error) {
          return fail(`驱动 ${memberLabel(member)} 发言时出错: ${error?.message ?? String(error)}`);
        }
        return {
          ok: outcome.ok,
          message: renderSpeakOutcome(outcome, room),
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

        const lines = [`第 ${startedRound} 轮跑完，共 ${outcomes.length} 位发言：`, ''];
        for (const outcome of outcomes) {
          const flag = outcome.ok ? '' : ` ⚠️${outcome.error ?? '未完成'}`;
          lines.push(`—— 第 ${outcome.seat} 位 · ${memberLabel(outcome.member)}${flag} ——`);
          lines.push(outcome.text || '（没有留下文字）');
          lines.push('');
        }
        const upcoming = nextSpeaker(room);
        lines.push(room.roundsExhausted
          ? `**轮次已用完**（${room.completedRounds}/${room.roundLimit} 轮）。该收会了：meeting_close。`
          : `已完成 ${room.completedRounds}/${room.roundLimit} 轮，现在在第 ${room.round} 轮。`
            + `下一位：${upcoming ? memberLabel(upcoming) : '（无）'}。`);

        return {
          ok: true,
          message: lines.join('\n'),
          roomId: room.id,
          round: room.round,
          completedRounds: room.completedRounds,
          roundsExhausted: room.roundsExhausted,
          outcomes: outcomes.map((o) => ({ seat: o.seat, sessionId: o.member.sessionId, ok: o.ok, chars: o.text.length })),
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
      record(room, { kind: 'host', seat: 0, sessionId: room.host.sessionId, name: '主持人', text });
      logEvent(room, 'host.note', { chars: text.length });
      store.save(room);
      meetingConsole.gap(room.id);
      meetingConsole.emit(room.id, `【主持人】${text.replace(/\r?\n/g, '　')}`);
      meetingConsole.gap(room.id);
      return { ok: true, message: `已记入会议记录（第 ${room.round} 轮）。后面发言的成员都会看到。`, roomId: room.id };
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
      + '调用前请先根据会议记录写好总结：这是要提交给哥哥的"会议成果"。'
      + '收会之后这间房就不能再发言了。',
    parameters: {
      roomId: { type: 'string', description: '房间号；省略时用你正在主持的那间' },
      summary: { type: 'string', description: '你对整场会议的总结（必填，这是提交给哥哥的正文）' },
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
      if (!summary) return fail('summary 不能为空——那是要提交给哥哥的会议成果。');

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
          saved = writeMinutes(room.id, minutes);
        } catch (error) {
          logEvent(room, 'minutes.failed', { error: error?.message ?? String(error) });
        }
      } else {
        logEvent(room, 'minutes.skipped', { reason: 'minutesEnabled=false' });
      }
      store.save(room);

      // 会场实况：收会也落到同一个窗口里，哥哥能当场看到会议成果
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
          ? 'ℹ️ 设置里关掉了「生成会议纪要」，所以这次没有写盘 —— 但内容就在下面，你照样可以转给哥哥。'
          : (saved === null
            ? '⚠️ 纪要写盘失败，但上面这些内容你已经拿到了。'
            : `纪要已保存：${saved}`),
        '',
        '下面就是提交给哥哥的会议成果全文（请在你的回复里转述给哥哥，别只说"已保存"）：',
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
          '· 都对不上，就把上面的「阶段」原样报给哥哥。');
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
      + '这里存的是另一层东西 ——「哥哥为什么封存她」的理由与时间。'
      + 'action=list 看名单（同时显示她到底归档了没有），seal 记理由，unseal 摘掉记录。'
      + '**本工具不会去改 DSH 的归档状态**，那是哥哥在界面上的动作。',
    parameters: {
      action: { type: 'string', description: 'list 看名单 / seal 加人 / unseal 摘人，默认 list', enum: ['list', 'seal', 'unseal'] },
      session: { type: 'string', description: 'seal / unseal 的目标：名册编号或完整会话 id' },
      reason: { type: 'string', description: 'seal 的理由，会一直显示在名册里（比如「上下文过载，2026-10-12 哥哥封存」）' },
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
        const lines = [`封存名单（${list.length} 位，她们无法参加会议）：`, ''];
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
              ? '状态：✅ 这个会话**已经在 DSH 里归档了** —— 名册会标 ⛔，meeting_open 会拒绝邀请她。'
              : '状态：⚠️ 记录写好了，但**这个会话在 DSH 里还没有归档** —— 技术上仍然叫得醒。\n'
                + '      要真正封住她，得在 DSH 界面里把那个会话归档。\n'
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
            ? '⚠️ **但她在 DSH 里仍然是归档状态**，还是叫不醒 —— 摘记录不等于解封。\n'
              + '      要让她真的回来，得在 DSH 界面上解归档。'
            : '✅ 她也不在归档名单里，所以现在请得动她。'),
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
    '  /meeting                 看你现在这场会的状态（轮次、成员、下一位该谁）',
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
              + '成员由你按议题来挑（先 meeting_roster 看名册）。开完把房间号和实况链接告诉哥哥。',
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

    // 默认：看我现在这场会的状态
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
   * 哥哥在输入框打 `/` 却看不到 meeting。所以改成对每个 agent 在 `agent.ctx` 下注册，
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
        const json = (code, body) => {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(body));
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
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(renderLiveHtml({ route: ROUTE, roomId }));
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
          const room = store.read(decodeURIComponent(roomMatch[1]));
          if (!room) {
            json(404, { ok: false, error: '房间不存在' });
            return;
          }
          json(200, { ok: true, room, minutes: readMinutes(room.id) });
          return;
        }

        if (rest === '/' || rest === '' || rest === '/index.html') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(renderIndexHtml(store.rootDir));
          return;
        }

        json(404, {
          ok: false,
          error: 'not found',
          routes: [
            `${ROUTE}/`,
            `${ROUTE}/api/ping`,
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
