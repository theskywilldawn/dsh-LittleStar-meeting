/**
 * 星辰会议室 —— 房间落盘。
 *
 * 目录布局（全部在 $DSH_HOME/xiaoxingchen-meeting 下）：
 *   rooms/<roomId>.json    房间状态 + 发言记录（**脱敏后的公开版本**）
 *   minutes/<roomId>.md    会议纪要（主持人收会时生成）
 *
 * 为什么落盘而不是纯内存：一场会议会跨越好几个会话、持续好几分钟，中途可能
 * 有会话重启；而且用户要能事后翻记录。
 *
 * ⚠️ **落盘的是脱敏副本，内存里的才是完整房间**（2026-10-17 补）。
 * 房间文件是明文 JSON，任何有文件工具的会话 —— 包括被拉来当玩家的普通会话 ——
 * 都能直接 `read` 它。而狼人杀的机密全在里面：`members[].role` 写着「狼人」和
 * 「你的狼队友：2 号、6 号」，`log[].member.role` 是一条条 `{seat, name:"狼人"}`
 * 的身份表，`transcript` 里 channel:'private' 的条目还留着夜里「刀 5 号」的问答。
 * 那局 10 号女巫读了 `live/*.log` 和这个文件、自己举手认了作弊 —— 缺口就是这么来的。
 *
 * 所以分两层：
 *   · **内存 `cache`** —— 完整房间。投递、纪要、`meeting_*` 工具都读它；
 *   · **磁盘** —— `redactRoom()` 处理过的副本。读文件的人只能看到公开部分。
 *
 * 代价：DSH 重启后 cache 清空，从磁盘读回来的房间没有身份信息，那一局作废
 * （本来重启也会断掉投递链）。**隐私 > 可恢复性**，这个取舍是故意的。
 *
 * 全部用同步 fs：房间文件只有几十 KB，而"读-改-写"必须在同一个 tick 里完成，
 * 否则并发发言会互相覆盖。同步写天然满足这一点，也省掉一层锁。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson, atomicWriteText } from './util.js';

/** 房间号白名单：只允许自家生成的形状，杜绝从路由传进来的路径穿越。 */
const ROOM_ID_RE = /^mtg-\d{8}-[0-9a-f]{6}$/;

/** 私聊内容落盘时的替身。 */
export const REDACTED_PRIVATE = '（私聊内容，不入档）';

export function isValidRoomId(id) {
  return typeof id === 'string' && ROOM_ID_RE.test(id);
}

/**
 * 生成落盘用的脱敏副本。
 *
 * 抹三处，都是 2026-10-17 那局实证泄露过的地方：
 *   1. `members[].role` —— 身份卡（含"狼队友：几号"）；
 *   2. `log[].member.role` —— 逐条身份表，最容易一眼看全；
 *   3. `transcript[].channel === 'private'` —— 夜里的问答与角色牌记录。
 *
 * 公开记录（`channel: 'public'`）原样保留 —— 那本来就是全场都知道的事。
 * 返回值一定是新对象，改它不会碰到内存里的真房间。
 *
 * @param {object} room
 * @param {object} [opts]
 * @param {boolean} [opts.keepHumanPrivate] 保留「人类 ↔ 法官」的一对一正文。
 *   **只有会场页面走这条路** —— 它必须让用户看见法官说了什么；落盘永远传 false。
 *   代价是能发 HTTP 请求的人也能读到这些内容，所以开局须知里补了
 *   「别调会议室的接口」这一条。
 * @param {string|null} [opts.userSeatId] 真人席位的 sessionId（`user:self`）。
 *   传了它，「audience 里有真人」也算**给真人看的**记录 —— 上警发言就是这种：
 *   它是 `meeting_whisper` + `audience = 全体`，对其他 AI 是公开的，
 *   但在落盘/HTTP 这条路上会被当成私聊抹掉。**2026-10-19 哥哥就是这么
 *   一个字都没看到上警发言的**（页面全是「（私聊内容，不入档）」）。
 * @param {boolean} [opts.dropUnrelatedPrivate] 把与真人无关的私聊**整条丢掉**，
 *   而不是留一句占位。会场页面用它 —— 11 个人的夜间私聊各占一个空白气泡，
 *   页面几十屏都是「（私聊内容，不入档）」，什么也读不到。落盘**不要**传：
 *   留着占位才能看出「这里本来有过一次私聊」。
 * @returns {object} 副本；输入不是对象时原样返回
 */
export function redactRoom(room, {
  keepHumanPrivate = false, userSeatId = null, dropUnrelatedPrivate = false,
} = {}) {
  if (!room || typeof room !== 'object') return room;
  let copy;
  try {
    copy = JSON.parse(JSON.stringify(room));
  } catch {
    return room; // 循环引用之类，宁可退回原样也不抛
  }

  for (const m of Array.isArray(copy.members) ? copy.members : []) {
    if (m && m.role) {
      // 保留结构、清空内容：下游读 `role.name` 得 null，不会报错，但什么也拿不到
      m.role = { name: null, team: null, note: null, brief: null, sealed: true };
    }
  }

  for (const e of Array.isArray(copy.log) ? copy.log : []) {
    if (!e || !e.detail || typeof e.detail !== 'object') continue;
    const ev = String(e.event ?? '');
    if (ev === 'member.role') {
      e.detail = { seat: e.detail.seat ?? null, sealed: true };
      continue;
    }
    // 夜里"找了谁"本身就是身份线索：第 1 夜 panel 找的 1/2/6/4，正好是三狼加预言家。
    // 所以 panel / whisper 的座位号、会话 id 一并抹掉，只留"第几轮、几个人"。
    if (ev.startsWith('panel.') || ev.startsWith('whisper.')) {
      delete e.detail.seat;
      delete e.detail.sessionId;
      delete e.detail.token;
      e.detail.sealed = true;
      continue;
    }
    if (ev === 'host.note' || ev === 'host.say') {
      delete e.detail.audience;   // 私密广播的收件人也是线索
    }
  }

  const keptTranscript = [];
  for (const t of Array.isArray(copy.transcript) ? copy.transcript : []) {
    if (!t) continue;
    // 判据用 **audience 非空 或 channel==='private'** —— 真正决定可见性的是 audience，
    // 只认 channel 会漏掉「公开频道却指定了受众」的那种记录。
    // audience 覆盖了**全部在场成员** —— 这条其实是公开广播，不是私聊。
    // 上警发言、PK 发言就是拿 `meeting_whisper` + `audience = 全体` 发的：
    // 投递上对每个 AI 都是公开的，可它的 `channel` 仍是 `'private'`，
    // 于是被当成私聊抹成「（私聊内容，不入档）」—— 法官事后一个字都翻不到
    // （2026-10-24 12 人局实测：12 位玩家的上警发言原文全部丢失）。
    const aliveIds = (Array.isArray(copy.members) ? copy.members : [])
      .filter((m) => m && !m.outAt)
      .map((m) => m.sessionId)
      .filter(Boolean);
    const coversAll = Array.isArray(t.audience) && aliveIds.length > 1
      && aliveIds.every((id) => t.audience.includes(id));

    const isPrivate = !coversAll && (t.channel === 'private'
      || (Array.isArray(t.audience) && t.audience.length > 0));
    if (!isPrivate) { keptTranscript.push(t); continue; }

    // 这条是不是**本来就该给真人看**的？
    //   · humanPrivate === true  → 法官和真人的一对一；
    //   · audience 里有真人        → 定向公开里包含他（上警发言就是这种）。
    // 两者都不是，那它是**别的成员的私聊** —— 页面不该看见，也不该占位。
    const forUser = userSeatId !== null && (
      t.humanPrivate === true
      || (Array.isArray(t.audience) && t.audience.includes(userSeatId))
    );
    if (forUser && keepHumanPrivate) { keptTranscript.push(t); continue; }
    if (dropUnrelatedPrivate && !forUser) continue;   // 与真人无关：整条丢掉

    // 人类和法官之间的一对一：**存档一定抹掉**（玩家读得到文件），
    // 但会场页面得看见，所以那条 HTTP 路径可以要求保留。
    t.text = REDACTED_PRIVATE;
    t.audience = null;   // 受众本身也是线索：谁会收到私聊 = 谁在夜里被找
    t.sessionId = null;
    t.name = null;
    t.sealed = true;
    keptTranscript.push(t);
  }
  if (Array.isArray(copy.transcript)) copy.transcript = keptTranscript;

  return copy;
}

export function createRoomStore(rootDir) {
  const roomsDir = join(rootDir, 'rooms');
  const minutesDir = join(rootDir, 'minutes');
  mkdirSync(roomsDir, { recursive: true });
  mkdirSync(minutesDir, { recursive: true });

  /** 内存里的完整房间（含身份）。落盘的是它的脱敏副本。 */
  const cache = new Map();

  const roomFile = (id) => join(roomsDir, `${id}.json`);
  const minutesFile = (id) => join(minutesDir, `${id}.md`);

  /** 列出目录里所有像房间号的文件名（不读内容，坏文件也不会带崩列表）。 */
  function roomIds() {
    let names = [];
    try {
      names = readdirSync(roomsDir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith('.json') && isValidRoomId(n.slice(0, -5)))
      .map((n) => n.slice(0, -5));
  }

  /**
   * 取房间：**内存优先**（完整），没有才读磁盘（脱敏版）。
   *
   * 重启后的房间因此只剩公开信息 —— 那一局没法继续，但历史还能翻。
   */
  function read(id) {
    if (!isValidRoomId(id)) return null;
    if (cache.has(id)) return cache.get(id);
    const file = roomFile(id);
    if (!existsSync(file)) return null;
    try {
      const room = JSON.parse(readFileSync(file, 'utf8'));
      if (room && room.id === id) cache.set(id, room);
      return room;
    } catch {
      return null; // 损坏的房间当不存在，别让它拖垮整场会议
    }
  }

  /** 原子落盘（脱敏副本）。返回写入字节数，方便调用方验证。 */
  function save(room) {
    if (!room || !isValidRoomId(room.id)) {
      throw new TypeError(`房间号非法，拒绝落盘: ${String(room?.id)}`);
    }
    room.updatedAt = Date.now();
    cache.set(room.id, room);
    return atomicWriteJson(roomFile(room.id), redactRoom(room));
  }

  /** 全部房间，按最后活动时间倒序。内存里的优先，磁盘上的补齐。 */
  function list() {
    const out = [];
    const seen = new Set();
    for (const [id, room] of cache) {
      if (!isValidRoomId(id)) continue;
      out.push(room);
      seen.add(id);
    }
    for (const id of roomIds()) {
      if (seen.has(id)) continue;
      const room = read(id);
      if (room && room.id === id) out.push(room);
    }
    out.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
    return out;
  }

  function remove(id) {
    if (!isValidRoomId(id)) return false;
    cache.delete(id);
    for (const file of [roomFile(id), minutesFile(id)]) {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        return false;
      }
    }
    return true;
  }

  function saveMinutes(id, markdown) {
    if (!isValidRoomId(id)) throw new TypeError(`房间号非法: ${String(id)}`);
    return atomicWriteText(minutesFile(id), markdown);
  }

  function readMinutes(id) {
    if (!isValidRoomId(id)) return null;
    const file = minutesFile(id);
    if (!existsSync(file)) return null;
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  return Object.freeze({
    rootDir,
    roomsDir,
    minutesDir,
    roomFile,
    minutesFile,
    roomIds,
    read,
    save,
    list,
    remove,
    saveMinutes,
    readMinutes,
  });
}
