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
  };
}

export function clampRounds(rounds) {
  const n = Number(rounds);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), MAX_ROUNDS);
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
  };
  room.transcript.push(item);

  if (item.kind !== 'member') return { item, roundCompleted: false };

  // 成员发言：按**座位号**找人，不依赖游标是否对齐 —— 指定座位发言时也不会记错人
  const member = seat === null
    ? room.members[room.cursor]
    : room.members.find((m) => m.order === seat);
  if (member) {
    member.status = item.timedOut ? 'timeout' : (item.error ? 'error' : 'spoke');
    member.spokeCount += 1;
    member.lastSpokeRound = room.round;
  }
  room.cursor += 1;

  let roundCompleted = false;
  if (room.cursor >= room.members.length) {
    room.cursor = 0;
    room.completedRounds = room.round;
    roundCompleted = true;
    if (room.round >= room.roundLimit) {
      room.roundsExhausted = true;
    } else {
      room.round += 1;
    }
  }
  return { item, roundCompleted };
}

/** 往会议流水里记一笔（不占发言位）。 */
export function logEvent(room, event, detail = null, now = Date.now()) {
  room.log.push({ at: now, event, detail });
  if (room.log.length > 400) room.log.splice(0, room.log.length - 400);
}

/** 下一位该发言的成员；一轮已走完时返回 null。 */
export function nextSpeaker(room) {
  if (!room || room.roundsExhausted) return null;
  return room.members[room.cursor] ?? null;
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
 */
export function renderTranscript(room, { budget = 8000, recentCount = null } = {}) {
  const lines = [];
  for (const item of room.transcript) {
    const who = item.kind === 'host'
      ? `${hostLabel(room)}（主持人，开场）`
      : `${item.name || '成员'}（第 ${item.round} 轮 · 第 ${item.seat} 位）`;
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
    '',
    '——— 最近的发言 ———',
    renderTranscript(room, { budget: transcriptBudget, recentCount }),
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
    lines.push(`  ${m.order}. ${memberLabel(m)} — ${last}，累计 ${m.spokeCount} 次 [${m.status}]`);
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
