/**
 * 星辰会议室 —— 会议纪要。
 *
 * 收会时把整场会议落成一份 markdown：谁主持、谁参加、每轮谁说了什么、
 * 最后得出的结论与待办。这份文件是会议唯一可归档的产物，用户随时能翻。
 */
import { fmtClock, fmtTime } from './util.js';
import { hostLabel, memberLabel } from './meeting.js';

function asList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v ?? '').trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*·]|\d+[.)、])\s*/, '').trim())
      .filter(Boolean);
  }
  return [];
}

function quote(text) {
  const body = String(text ?? '').trim();
  if (!body) return '> （这一轮没有留下文字）';
  return body
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * @param {object} room
 * @param {object} [outcome]
 * @param {string} [outcome.summary]     主持人的总结
 * @param {string|string[]} [outcome.conclusions] 会议达成的结论
 * @param {string|string[]} [outcome.actions]     会后待办
 * @param {string} [zone]  时区
 */
export function renderMinutes(room, outcome = {}, zone = 'Asia/Shanghai') {
  const started = room.createdAt;
  const ended = room.closedAt ?? Date.now();
  const lines = [];

  lines.push(`# 星辰会议室 · ${room.topic}`, '');
  lines.push(`- 房间号：\`${room.id}\``);
  lines.push(`- 开始：${fmtTime(started, zone)}`);
  lines.push(`- 结束：${fmtTime(ended, zone)}`);
  lines.push(`- 用时：${formatDuration(ended - started)}`);
  lines.push(`- 主持人：${hostLabel(room)}`);
  lines.push('- 成员（按邀请顺序）：');
  for (const m of room.members) {
    lines.push(`  ${m.order}. ${memberLabel(m)} — 发言 ${m.spokeCount} 次`);
  }
  lines.push(`- 轮次：上限 ${room.roundLimit} 轮，实际完成 ${room.completedRounds} 轮`
    + (room.roundsExhausted ? '（轮次已用完）' : '（提前达成目标收会）'));
  lines.push('');

  lines.push('## 议题', '', room.topic, '');
  if (room.goal) lines.push('## 目标', '', room.goal, '');
  if (room.agenda) lines.push('## 主持人的安排', '', room.agenda, '');

  lines.push('## 会议记录', '');
  const hostTurns = room.transcript.filter((t) => t.kind === 'host');
  if (hostTurns.length > 0) {
    lines.push('### 开场 · 主持人', '');
    for (const t of hostTurns) {
      lines.push(`*（第 ${t.round} 轮前）*`, '', quote(t.text), '');
    }
  }

  const memberTurns = room.transcript.filter((t) => t.kind === 'member');
  if (memberTurns.length === 0) {
    lines.push('（这场会议没有产生成员发言）', '');
  } else {
    let currentRound = null;
    for (const t of memberTurns) {
      if (t.round !== currentRound) {
        currentRound = t.round;
        lines.push(`### 第 ${currentRound} 轮`, '');
      }
      const flag = t.timedOut ? ' ⏱️超时' : (t.error ? ` ⚠️${t.error}` : '');
      lines.push(`#### 第 ${t.seat} 位 · ${t.name || '成员'}${flag}`, '');
      lines.push(quote(t.text), '');
    }
  }

  const systemTurns = room.transcript.filter((t) => t.kind === 'system');
  if (systemTurns.length > 0) {
    lines.push('### 其他记录', '');
    for (const t of systemTurns) lines.push(`- ${t.text}`);
    lines.push('');
  }

  lines.push('## 会议成果', '');
  lines.push('### 主持人的总结', '');
  lines.push(String(outcome.summary ?? '').trim() || '（主持人没有留下总结）', '');

  const conclusions = asList(outcome.conclusions);
  lines.push('### 结论', '');
  if (conclusions.length === 0) lines.push('（未单独列出结论）');
  else for (const item of conclusions) lines.push(`- ${item}`);
  lines.push('');

  const actions = asList(outcome.actions);
  lines.push('### 待办 / 下一步', '');
  if (actions.length === 0) lines.push('（没有留下待办）');
  else for (const item of actions) lines.push(`- [ ] ${item}`);
  lines.push('');

  lines.push('---', '');
  lines.push(`*由 ${hostLabel(room)} 于 ${fmtClock(ended, zone)} 提交 · 星辰会议室*`, '');

  return lines.join('\n');
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}
