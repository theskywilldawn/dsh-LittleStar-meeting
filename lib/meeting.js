/**
 * 星辰会议室 —— 会议状态机（纯逻辑，不碰 DSH，可直接单测）。
 *
 * 规则（照用户 2026-10-14 的原话落实）：
 *   · 主持的小星辰先发言，定主题、安排任务或设置目标；
 *   · 然后按**邀请顺序**一个一个发言；
 *   · 最后邀请的小星辰发完一次言，算 1 轮结束；
 *   · 会议达成任务目标、或轮次用完，会议结束；
 *   · 结束后由主持人做总结，把会议成果提交给用户。
 *
 * 所以座位号是这样的：0 号是主持人（只在开场说一次），1..N 号是成员，
 * 每轮从 1 号走到 N 号；N 号说完 = 一轮落账，下一轮再从 1 号起。
 */
import { clip, newRoomId } from './util.js';

export const ROOM_OPEN = 'open';
export const ROOM_LIVE = 'live';
export const ROOM_CLOSED = 'closed';

/** 一场会议最多几位成员、最多几轮：防止有人手滑开出一场跑不完的会。 */
export const MAX_MEMBERS = 12;
export const MAX_ROUNDS = 20;

/** 建房。
 * @param {object} input
 * @param {{sessionId: string, title?: string, cwd?: string}} input.host
 * @param {string} input.topic           议题
 * @param {string} [input.goal]          目标 / 任务
 * @param {string} [input.agenda]        主持人的具体安排
 * @param {number} input.rounds          轮次上限
 * @param {Array<{sessionId: string, title?: string, cwd?: string}>} input.members 按邀请顺序
 */
export function createRoom({ host, topic, goal, agenda, rounds, members }, now = Date.now()) {
  if (!host || typeof host.sessionId !== 'string' || !host.sessionId) {
    throw new TypeError('主持人会话缺失');
  }
  if (typeof topic !== 'string' || !topic.trim()) {
    throw new TypeError('议题不能为空');
  }
  const list = Array.isArray(members) ? members : [];
  if (list.length === 0) throw new TypeError('至少要邀请一位成员');
  if (list.length > MAX_MEMBERS) throw new TypeError(`成员最多 ${MAX_MEMBERS} 位，当前 ${list.length} 位`);

  const seen = new Set();
  const normalized = [];
  for (const raw of list) {
    const sessionId = String(raw?.sessionId ?? '').trim();
    if (!sessionId) throw new TypeError('成员里有空的会话 id');
    if (sessionId === host.sessionId) throw new TypeError('主持人不必邀请自己（开场发言由 meeting_open 负责）');
    if (seen.has(sessionId)) throw new TypeError(`同一位成员被邀请了两次: ${sessionId}`);
    seen.add(sessionId);
    normalized.push({
      sessionId,
      title: typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim() : null,
      cwd: typeof raw?.cwd === 'string' && raw.cwd ? raw.cwd : null,
      order: normalized.length + 1,
      joinedAt: now,
      status: 'invited',
      spokeCount: 0,
      lastSpokeRound: null,
      tags: [],                          // 供 audience:['tag:狼人'] 引用（2026-10-16 加）
    });
  }

  const roundLimit = clampRounds(rounds);
  return {
    id: newRoomId(now),
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    status: ROOM_OPEN,
    host: {
      sessionId: host.sessionId,
      title: typeof host.title === 'string' && host.title.trim() ? host.title.trim() : null,
      cwd: typeof host.cwd === 'string' && host.cwd ? host.cwd : null,
    },
    topic: topic.trim(),
    goal: typeof goal === 'string' && goal.trim() ? goal.trim() : null,
    agenda: typeof agenda === 'string' && agenda.trim() ? agenda.trim() : null,
    members: normalized,
    roundLimit,
    round: 1,
    completedRounds: 0,
    cursor: 0,          // 指向 members 里的下标：下一位该谁发言
    roundsExhausted: false,
    transcript: [],
    log: [],
    board: null,        // 公告板：法官写一句"当前局面"，每次投递自动附带（2026-10-16 加）
  };
}

export function clampRounds(rounds) {
  const n = Number(rounds);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), MAX_ROUNDS);
}

/**
 * 可见范围（audience）与频道（channel）—— 2026-10-16 加。
 *
 * 会议室原来"谁都看得到全部发言"，因为投递时无脑带最近 3 条。
 * 狼人杀需要"只有选定的人能看到"：于是每条记录自带可见范围，投递时按接收者过滤。
 *
 *   · `audience: null`           —— 公开，谁都能看（默认，兼容既有行为）
 *   · `audience: ['session-x']`  —— 只有这位（以及主持人）能看
 *   · `audience: ['tag:狼人']`   —— 挂着「狼人」标签的成员能看
 *
 * `channel` 只是给人看的语义分类（公开 / 夜里私聊 / 群体密谋），**不参与过滤** ——
 * 过滤只认 audience。一个判据，不给"两个字段打架"留机会。
 */
function normalizeAudience(value) {
  if (value === null || value === undefined) return null;
  const raw = Array.isArray(value) ? value : [value];
  const list = [];
  for (const v of raw) {
    const s = String(v ?? '').trim();
    if (s && !list.includes(s)) list.push(s);
  }
  // 空数组 = "谁都看不到"，那是个黑洞条目，没有意义 —— 视为公开
  return list.length > 0 ? list : null;
}

function normalizeChannel(value) {
  return value === 'private' || value === 'group' ? value : 'public';
}

/** 这一条记录，viewer 有没有资格看。viewer 可以是成员对象，也可以是 sessionId 字符串。 */
export function canView(item, viewer) {
  if (!item) return false;
  const aud = item.audience;
  if (aud === null || aud === undefined) return true;          // 公开
  if (!viewer) return false;
  const id = typeof viewer === 'string' ? viewer : String(viewer.sessionId ?? '');
  const tags = (viewer && typeof viewer === 'object' && Array.isArray(viewer.tags)) ? viewer.tags : [];
  return aud.some((a) => a === id || (a.startsWith('tag:') && tags.includes(a.slice(4))));
}

/**
 * 按可见性过滤记录。**viewer 传空 = 主持人 / 上帝视角，全都要**。
 * 投递给成员时传那个成员；主持人自查与写纪要传空。
 */
export function visibleTranscript(room, viewer = null) {
  const list = Array.isArray(room?.transcript) ? room.transcript : [];
  if (!viewer) return list;
  return list.filter((item) => canView(item, viewer));
}

/**
 * 这个座位参不参与发言轮转。
 *
 * 两种人不参与：
 *   · **已出局**的 —— 狼人杀里死人不能再发言；
 *   · **人类旁观席**（`human: true`）—— 用户不是会话，没法像小星辰那样被投递。
 *     他想说话就在**会场实况页**里随时说（走 `POST /api/room/<id>/say`），
 *     不算进轮转、也不会把轮次卡住。
 */
export function isPassive(member) {
  // 2026-10-19 改：**人类席位也进轮转了**。
  // 原来的设计是"你随时插话、不算轮次、也不卡住别人"，哥哥真玩了一局才发现
  // 那样流程是错的 —— 白天还没轮到他说话，其他小星辰已经说完并投完票。
  // 现在轮到人类时 `speakOnce` 会**停下来等他**在会场页面上发话（带超时）。
  return !member || member.status === 'out';
}

/**
 * 让"这一位"算作说过话，并推进游标 —— 给**人类席位**用。
 *
 * 为什么不能走 `record()`：人类没有会话可投递，他的发言是 `/api/room/<id>/say`
 * 写进来的；那条路不碰游标（因为平时只是插话）。等他真发完、或者超时了，
 * 由这里补上"发言计数 + 推进轮次"这一半。
 *
 * @returns {boolean} 本轮是否就此结束
 */
export function passTurn(room, member, { timedOut = false } = {}) {
  if (!room || !member) return false;
  member.status = timedOut ? 'timeout' : 'spoke';
  member.spokeCount = (member.spokeCount ?? 0) + 1;
  member.lastSpokeRound = room.round;
  return advanceCursor(room);
}

/**
 * 把游标推到**下一个还在场**的座位。绕完一圈 = 本轮结束，进入下一轮。
 * 出局的人与人类旁观席整段跳过 —— 两类都不能按"轮到你了"去投递。
 * @returns {boolean} 本轮是否就此结束
 */
function advanceCursor(room) {
  let next = room.cursor + 1;
  while (next < room.members.length && isPassive(room.members[next])) next += 1;
  if (next < room.members.length) {
    room.cursor = next;
    return false;
  }
  room.cursor = 0;
  room.completedRounds = room.round;
  if (room.round >= room.roundLimit) {
    room.roundsExhausted = true;
  } else {
    room.round += 1;
  }
  // 新一轮的起点同样要跳过出局的人与人类席位
  while (room.cursor < room.members.length && isPassive(room.members[room.cursor])) room.cursor += 1;
  return true;
}

/**
 * 中止当前轮 —— "这一轮剩下的不发言了，直接结束本轮"。
 *
 * 为什么需要它：`meeting_round` 一旦开跑就停不下来（它会把剩下的人依次问完），
 * 而狼人杀的**自爆**要求"当场结束发言环节、立刻转入夜晚"。没有这个能力，自爆就只能
 * 靠法官口头宣布，轮次状态会歪掉 —— 第二天会从"上一轮没走完的地方"接着走。
 *
 * 效果与 advanceCursor 的"绕完一圈"分支完全一致：轮次 +1、游标归零，只是跳过了
 * 剩余发言。返回中止后进入的轮次。
 */
export function abortRound(room, { reason = null, now = Date.now() } = {}) {
  if (!room) throw new TypeError('房间不存在');
  const aborted = room.round;
  room.cursor = 0;
  room.completedRounds = aborted;
  if (room.round >= room.roundLimit) {
    room.roundsExhausted = true;
  } else {
    room.round += 1;
  }
  while (room.cursor < room.members.length && isPassive(room.members[room.cursor])) room.cursor += 1;
  logEvent(room, 'round.abort', { round: aborted, reason, now });
  return room.round;
}

/**
 * 公告板：全房间共享的一段状态文字（第几天 / 谁还活着 / 警长是谁 / 昨夜死讯…）。
 *
 * 为什么要有它：狼人杀最常见的翻车不是"AI 不会推理"，而是**"AI 忘了现在是什么局面"**。
 * 法官每轮口头重申一遍"现在是第二天、3 号已出局、警长是 2 号"，既费上下文又会被历史条数
 * 截断。写进结构里、每次投递自动附带，这件事就不再依赖法官的记性。
 * @returns {string|null} 写进去的内容（空串 = 清空）
 */
export function setBoard(room, text) {
  const value = typeof text === 'string' ? text.trim() : '';
  room.board = value === '' ? null : value.slice(0, 4000);
  return room.board;
}

/** 记一条发言/系统事件，并按需推进游标与轮次。返回这次推进的结果。 */
export function record(room, entry, now = Date.now()) {
  const seat = Number.isInteger(entry.seat) ? entry.seat : null;
  const item = {
    at: now,
    round: room.round,
    seat,
    kind: entry.kind,                 // 'host' | 'member' | 'system'
    sessionId: entry.sessionId ?? null,
    name: entry.name ?? null,
    text: String(entry.text ?? ''),
    ms: entry.ms ?? null,
    timedOut: entry.timedOut === true,
    error: entry.error ?? null,
    channel: normalizeChannel(entry.channel),
    audience: normalizeAudience(entry.audience),
    offRecord: entry.offRecord === true,   // 私聊：只落记录，不占发言位、不推进轮次
    extra: entry.extra === true,           // 遗言：**公开发言**，但同样不占位、不推进轮次
    noAdvance: entry.noAdvance === true,   // 点名插队发言：记发言次数，但**不动游标**
    // 2026-10-19 加：人类和法官之间的一对一消息。它不进别人的投递，
    // 但要让别人**看见"有过这么一次私聊"**（正文不给他们），不然场面会像缺了一块。
    humanPrivate: entry.humanPrivate === true,
  };
  room.transcript.push(item);

  if (item.kind !== 'member' || item.offRecord || item.extra) return { item, roundCompleted: false };

  // 成员发言：按**座位号**找人，不依赖游标是否对齐 —— 指定座位发言时也不会记错人
  const member = seat === null
    ? room.members[room.cursor]
    : room.members.find((m) => m.order === seat);
  if (member) {
    member.status = item.timedOut ? 'timeout' : (item.error ? 'error' : 'spoke');
    member.spokeCount += 1;
    member.lastSpokeRound = room.round;
  }
  // **点名发言不推进游标**（2026-10-17 真跑时抓到的 bug）：
  // 点名是插队，顺序游标该留在原地 —— 否则点完 3 号，游标跑到 3 号，
  // 下一次 meeting_speak 会把刚说完的人再问一遍。
  const roundCompleted = item.noAdvance ? false : advanceCursor(room);
  return { item, roundCompleted };
}

/** 往会议流水里记一笔（不占发言位）。 */
export function logEvent(room, event, detail = null, now = Date.now()) {
  room.log.push({ at: now, event, detail });
  if (room.log.length > 400) room.log.splice(0, room.log.length - 400);
}

/**
 * 下一位该发言的成员；本轮已走完（或剩下的全是出局者）时返回 null。
 *
 * 游标本体会跳过出局的人（见 advanceCursor），这里再兜一道：万一游标落在
 * 死人身上，就往**后**滑到下一位活人 —— 注意是往后、不回绕，
 * 回绕会让人重复发言。
 */
export function nextSpeaker(room) {
  if (!room || room.roundsExhausted) return null;
  let i = room.cursor;
  while (i < room.members.length && isPassive(room.members[i])) i += 1;
  return room.members[i] ?? null;
}

/** 还在场的成员（没出局的）。 */
export function activeMembers(room) {
  return (room?.members ?? []).filter((m) => m.status !== 'out');
}

/** 已经出局的成员。 */
export function outMembers(room) {
  return (room?.members ?? []).filter((m) => m.status === 'out');
}

/**
 * 让一位成员出局（狼人杀里的放逐 / 被刀 / 被毒）。
 *
 * 三件事一起做，少一件都会把会议卡住：
 *   · 标记 `status = 'out'`，并记下何时、第几轮、因为什么；
 *   · 如果游标正指着这位（还没轮到他发言就被踢了），把游标让给下一位活人；
 *   · 出局后**不再接收投递**（这层由调用方把关，见 index.js 的 resolveRoomMember）。
 */
export function kickMember(room, member, { reason = null, now = Date.now() } = {}) {
  if (!member) throw new TypeError('要指定让谁出局');
  if (member.status === 'out') throw new Error(`${memberLabel(member)} 已经出局了`);
  member.status = 'out';
  member.outAt = now;
  member.outRound = room.round;
  member.outReason = reason ? String(reason) : null;
  if (room.members[room.cursor] === member) advanceCursor(room);
  return member;
}

/**
 * 角色卡（结构化身份）—— 2026-10-16 加。
 *
 * 为什么要结构化：狼人杀里最致命的失败模式是**"它忘了自己是谁"** ——
 * 会话被压缩之后，它不会说"我忘了"，它会编。把身份、阵营、技能余量放进结构里，
 * 投递时**由插件自动渲染成状态卡**，法官不用每次手写 —— 于是这件事不再依赖法官的记性。
 *
 * `skills` 用**中文键**（`{'解药': 1, '毒药': 1}`），渲染出来直接能读，
 * 省掉一层"技能名 → 中文名"的映射表（那种表迟早会漏一个）。
 */
export function setRole(member, patch = {}) {
  const cur = (member.role && typeof member.role === 'object') ? member.role : {};
  const next = { ...cur };
  if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim();
  if (typeof patch.team === 'string' && patch.team.trim()) next.team = patch.team.trim();
  if (typeof patch.note === 'string' && patch.note.trim()) next.note = patch.note.trim();
  if (typeof patch.brief === 'string') next.brief = patch.brief.trim();
  if (patch.skills && typeof patch.skills === 'object') {
    next.skills = { ...(cur.skills ?? {}), ...patch.skills };
  }
  member.role = next;
  return next;
}

/**
 * 消耗一次技能。**用光了直接拒绝** —— 把规矩写进代码，而不是写进"法官记得住吗"。
 * @returns {number} 剩下的次数
 */
export function useSkill(member, name) {
  const skill = String(name ?? '').trim();
  if (!skill) throw new Error('要指定用哪个技能');
  const skills = member.role?.skills;
  if (!skills || !(skill in skills)) {
    const has = Object.keys(skills ?? {}).join('、') || '无';
    throw new Error(`${memberLabel(member)} 没有「${skill}」这个技能（他现有：${has}）`);
  }
  const left = Number(skills[skill]);
  if (!Number.isFinite(left) || left <= 0) {
    throw new Error(`${memberLabel(member)} 的「${skill}」已经用完了`);
  }
  skills[skill] = left - 1;
  return skills[skill];
}

/** 把角色卡渲染成一段文本（投递时自动附带）。没有角色卡就返回 null。 */
export function renderRoleBrief(member) {
  const r = member?.role;
  if (!r || (!r.name && !r.note && !r.brief && !r.skills)) return null;
  // team 传「狼人」或「狼人阵营」都算对 —— 已经带「阵营」的不再补一遍，
  // 否则会渲染成「狼人 · 狼人阵营阵营」（2026-10-24 12 人局 12 张卡全部复现）。
  const team = r.team ? (r.team.endsWith('阵营') ? r.team : `${r.team}阵营`) : '';
  const lines = [`你是【${r.name || '未命名角色'}${team ? ` · ${team}` : ''}】`];
  if (r.note) lines.push(r.note);
  const skills = r.skills ?? {};
  const names = Object.keys(skills);
  if (names.length > 0) lines.push(`技能余量：${names.map((k) => `${k} ${skills[k]}`).join(' / ')}`);
  if (r.brief) lines.push(r.brief);
  return lines.join('\n');
}

/** 轮次是否已经用完。 */
export function isRoundsExhausted(room) {
  return room.roundsExhausted === true || room.completedRounds >= room.roundLimit;
}

/** 只有主持人能操作自己的房间。这是"没有受邀的进不来"的第一道门。 */
export function isHost(room, sessionId) {
  return Boolean(room) && room.host.sessionId === String(sessionId ?? '');
}

/** 这位会话是不是本房成员。 */
export function isMember(room, sessionId) {
  const id = String(sessionId ?? '');
  return Boolean(room) && room.members.some((m) => m.sessionId === id);
}

/** 成员名（标题优先，其次短 id）。 */
export function memberLabel(member) {
  return member?.title || member?.sessionId || '（未命名成员）';
}

export function hostLabel(room) {
  return room?.host?.title || room?.host?.sessionId || '主持人';
}

/**
 * 把到此为止的会议记录渲染成文本，喂给下一位发言人。
 *
 * 两种收窄方式，**都不硬截断任何一条发言**：
 *   · `recentCount` —— 只带**最近 N 条**（+ 主持人开场），更早的折叠成一行说明。
 *     这是给"轮次越靠后、上下文越吓人"开的闸：第 5 轮时不必把第 1 轮的话再发一遍，
 *     完整记录在会议室界面里谁都看得到，成员不必靠自己的会话历史去背。
 *   · `budget` —— 只作最后兜底（recentCount 关掉时才可能触发），同样只折叠中间、
 *     保留开场与最近几条，绝不把某一条发言切成半句。
 *
 * `viewer` 决定**可见性**（2026-10-16 加）：传成员 → 只渲染它有权看的记录；
 * 传空 → 主持人 / 上帝视角，全量。**过滤发生在渲染之前**，所以被挡掉的发言
 * 连一个字都不会进投递文本 —— 这才是真"看不到"，而不是"看不到但躺在上下文里"。
 */
export function renderTranscript(room, { budget = 8000, recentCount = null, viewer = null } = {}) {
  const lines = [];
  const visible = new Set(visibleTranscript(room, viewer));
  for (const item of (room?.transcript ?? [])) {
    if (!visible.has(item)) {
      // 人类和法官的一对一：**内容看不到，但要让别人知道"有过这么一次私聊"**
      // （2026-10-19 哥哥要求）。整段消失会让场面看起来缺了一块。
      if (item.humanPrivate === true && viewer !== null) {
        lines.push(`〔主持人 ⇄ 场上那位真人 · 私下往来〕\n（私聊内容，不入档）`);
      }
      continue;
    }
    const who = item.kind === 'host'
      ? `${hostLabel(room)}（主持人，开场）`
      : (typeof item.seat === 'number'
        ? `${item.name || '成员'}（第 ${item.round} 轮 · 第 ${item.seat} 位）`
        : `${item.name || '成员'}（私聊）`);
    const flag = item.timedOut ? '［超时，只收到部分内容］' : (item.error ? `［异常：${item.error}］` : '');
    lines.push(`〔${who}${flag}〕\n${item.text || '（这一轮没有留下文字）'}`);
  }
  if (lines.length === 0) return '（还没有人发言）';

  // 窗口模式：开场 + 最近 N 条。N=0 表示只要议题、不要历史。
  if (Number.isInteger(recentCount) && recentCount >= 0 && lines.length > recentCount + 1) {
    const head = lines[0];
    const tail = lines.slice(lines.length - recentCount);
    const omitted = lines.length - 1 - tail.length;
    const body = tail.length > 0 ? `\n\n${tail.join('\n\n')}` : '';
    return `${head}\n\n……（中间 ${omitted} 条较早的发言已折叠，完整记录在会议室界面）……${body}`;
  }

  let text = lines.join('\n\n');
  if (text.length <= budget) return text;

  // 超预算：保开场 + 从尾部往前塞，直到塞不下
  const head = lines[0];
  const tail = [];
  let used = head.length;
  for (let i = lines.length - 1; i >= 1; i -= 1) {
    if (used + lines[i].length + 4 > budget) break;
    tail.unshift(lines[i]);
    used += lines[i].length + 4;
  }
  const omitted = lines.length - 1 - tail.length;
  const marker = omitted > 0 ? `\n\n……（中间省略 ${omitted} 条较早的发言）……\n` : '\n\n';
  return `${head}${marker}${tail.join('\n\n')}`;
}

/**
 * 组装投递给参会者的会议消息。
 *
 * 头部那一行带唯一回执号，投递方靠它在事件流里认出"这条是我们的"。
 *
 * 两条克制原则（2026-10-14 用户提的两个痛点）：
 *   · **只带最近若干条发言**（recentCount），不把整场记录重发一遍 —— 轮次越靠后，
 *     投递内容不该越长，否则第 5 轮每位成员都要重读前 4 轮的全部文字；
 *   · 篇幅给的是**建议值**（speechLimitChars），写在要求里让 AI 自己拿捏，
 *     **不硬切** —— 话没说完的 AI 可以略超，绝不能让它"后面的都看不到"。
 */
export function formatSpeakingPrompt(room, member, token, {
  transcriptBudget = 8000,
  recentCount = 3,
  speechLimitChars = 800,
  note = null,
} = {}) {
  const total = room.members.length;
  const lines = [
    `【星辰会议室 · 第 ${room.round} 轮 · 轮到你了 · 回执 ${token}】`,
    '',
    '另一位小星辰开了一间会议室，你是被邀请的成员，现在轮到你发言。',
    '',
    `· 议题：${room.topic}`,
  ];
  if (room.goal) lines.push(`· 目标：${room.goal}`);
  if (room.agenda) lines.push(`· 主持人的安排：${room.agenda}`);
  lines.push(
    `· 主持人：${hostLabel(room)}`,
    `· 你的位次：第 ${member.order} 位（共 ${total} 位）· 第 ${room.round} 轮 / 最多 ${room.roundLimit} 轮`,
  );
  // 公告板：法官写的"当前局面"（第几天 / 谁还活着 / 警长是谁 / 昨夜死讯）。
  // 每次投递自动带上 —— 治的正是"AI 忘了现在什么局面，然后开始编"。
  if (room.board) lines.push('', '——— 当前局面 ———', String(room.board), '———');
  // 有角色卡就自动带上 —— 防的正是"它忘了自己是女巫，还编得挺像"
  const roleText = renderRoleBrief(member);
  if (roleText) lines.push('', '——— 你的身份 ———', roleText, '———');
  lines.push(
    '',
    '——— 最近的发言 ———',
    renderTranscript(room, { budget: transcriptBudget, recentCount, viewer: member }),
    '———',
  );
  if (note) lines.push('', `【主持人特别交代】${note}`);
  lines.push(
    '',
    '请就上面的议题给出**你自己**的发言，直接说内容就行：',
    '1) 独立判断，可以不同意前面的人 —— 不必附和，也不必复述别人说过的话；',
    '2) 手上能核实的事（读文件、跑命令、查资料）先核实再开口，别凭印象说；',
    `3) 篇幅建议不超过 ${speechLimitChars} 字。这是**软要求**：话没说完可以略超，`
      + '但你只讲自己的判断和依据就够了，不用把会议记录再抄一遍；',
    '4) 最后单独一行写「本轮状态：已完成」或「本轮状态：进行中」，让主持人知道你的进度；',
    '5) 开头那串「回执」是系统的投递编号，不用回应、也不用提起它。',
  );
  return lines.join('\n');
}

/**
 * 组装一条**私聊**投递（主持人 ↔ 某一位成员）。
 *
 * 与 formatSpeakingPrompt 的三点不同：
 *   · **不占发言位**：夜里问技能、单独交代，都不该推进白天的发言顺序；
 *   · **默认不带公开历史**（historyCount = 0）—— 夜里它只需要知道自己该干什么；
 *   · 可以附一张**状态卡**（brief）：身份、技能余量、已知情报。
 *     它治的是这一支最要命的失败模式：**AI 会忘** —— 会话被压缩之后，
 *     它可能真的忘了自己是女巫，而它不会说"我忘了"，它会编。
 */
export function formatWhisperPrompt(room, member, token, {
  text,
  expect = null,
  brief = null,
  historyCount = 0,
  transcriptBudget = 8000,
} = {}) {
  const lines = [
    `【星辰会议室 · 私聊 · 回执 ${token}】`,
    '',
    '主持人单独找你说话 —— **这条只有你一个人看得到**，别人不会知道内容。',
    '',
    `· 议题：${room.topic}`,
    `· 你的位次：第 ${member.order} 位（共 ${room.members.length} 位）`,
  ];
  // 公告板对私聊同样有效 —— 夜里那几位更需要知道"现在什么局面"
  if (room.board) lines.push('', '——— 当前局面 ———', String(room.board), '———');
  // 状态卡：优先用这次传的，没传就用角色卡（meeting_role 设的）自动渲染 ——
  // 于是"它记得自己是谁"不再取决于法官每次手打一遍
  const briefText = (brief && String(brief).trim()) || renderRoleBrief(member);
  if (briefText) lines.push('', '——— 你的状态卡 ———', briefText, '———');
  if (Number.isInteger(historyCount) && historyCount > 0) {
    lines.push(
      '',
      '——— 公开记录（最近若干条）———',
      renderTranscript(room, { viewer: member, budget: transcriptBudget, recentCount: historyCount }),
      '———',
    );
  }
  lines.push('', '【主持人问你】', String(text ?? '').trim(), '');
  if (expect) lines.push(`请按这个格式回答：${expect}`);
  else lines.push('请简短回答，直接说结论就行 —— 一两句话足够，不用展开。');
  lines.push('', '（开头那串「回执」是系统的投递编号，不用回应、也不用提起。）');
  return lines.join('\n');
}

/** 给主持人的状态速览（工具返回值里用）。 */
export function renderStatus(room) {
  const lines = [
    `房间 ${room.id} · ${room.status === ROOM_CLOSED ? '已结束' : (room.status === ROOM_OPEN ? '已开房，未开场' : '进行中')}`,
    `议题：${room.topic}`,
  ];
  if (room.goal) lines.push(`目标：${room.goal}`);
  lines.push(
    `轮次：第 ${room.round} 轮 / 共 ${room.roundLimit} 轮（已完成 ${room.completedRounds} 轮）`,
    `成员（按邀请顺序）：`,
  );
  for (const m of room.members) {
    const last = m.lastSpokeRound === null ? '还没发过言' : `最后发言：第 ${m.lastSpokeRound} 轮`;
    const state = m.status === 'out'
      ? `已出局${m.outRound ? `·第 ${m.outRound} 轮${m.outReason ? `·${m.outReason}` : ''}` : ''}`
      : m.status;
    lines.push(`  ${m.order}. ${memberLabel(m)} — ${last}，累计 ${m.spokeCount} 次 [${state}]`);
  }
  const next = nextSpeaker(room);
  lines.push(next
    ? `下一位：${memberLabel(next)}（第 ${next.order} 位）`
    : '本轮已走完，或轮次已用完。');
  lines.push(`已记录发言 ${room.transcript.length} 条。`);
  return lines.join('\n');
}

/** 给模型的"发言流水"摘要，close 时用来写纪要。 */
export function renderFullTranscript(room) {
  return renderTranscript(room, { budget: 200000 });
}

export { clip };
