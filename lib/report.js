/**
 * 星辰会议室 —— 报告渲染（给**主持人**看的文本）。
 *
 * 2026-10-16 单独拆出来，两个原因：
 *   1) **可测**：`index.js` 依赖宿主包（`@deepseek-ai/dsh-tools`），测试里 import 不了；
 *      放这里就能进 `test-meeting.mjs`。省上下文这件事必须锁死，不能靠"感觉还行"。
 *   2) **它是省上下文的那道闸**：`report: 'brief'` 只回一行摘要 ——
 *      发言全文照样落盘、照样进观战窗口（观众要的上帝视角一个字不少），
 *      只是**不再回显进法官的上下文**。
 *
 * 两种粒度：
 *   · `'full'`  —— 回显全文（默认，兼容既有行为；也适合"我就是要看它说了什么"）
 *   · `'brief'` —— 一位一行：位次 · 名字 · 字数 · 用时 · 状态
 */
import { memberLabel, nextSpeaker } from './meeting.js';

/** 一位成员发言的结果 → 给主持人看的文本。 */
export function renderSpeakOutcome(outcome, room, report = 'full') {
  const flag = outcome.ok ? '' : ` — ⚠️ ${outcome.error ?? '未完成'}`;
  const secs = Math.round(outcome.ms / 1000);
  const head = `【第 ${outcome.round} 轮 · 第 ${outcome.seat} 位 · ${memberLabel(outcome.member)}】`;
  const next = nextSpeaker(room);
  const tail = outcome.roundCompleted
    ? `**本轮结束**，已完成 ${room.completedRounds}/${room.roundLimit} 轮。`
    : `下一位：${next ? `${memberLabel(next)}（第 ${next.order} 位）` : '本轮已走完'}`;

  if (report === 'brief') {
    const stat = ` ${outcome.text.length} 字 · ${secs} 秒`;
    return `${head}${outcome.ok ? stat : `${flag} ·${stat}`}\n${tail}`;
  }

  return [
    `${head}${flag}`,
    '',
    outcome.text || '（这位成员这一轮没有留下文字）',
    '',
    `用时 ${secs} 秒。${tail}`,
  ].join('\n');
}

/**
 * 一轮跑完 → 给主持人看的文本。
 * `brief` 模式刻意**只给每人一行**：法官推进流程不需要读全文，
 * 需要时自己去房间文件里读那一段（第四招：三层分离）。
 */
export function renderRoundReport(outcomes, room, startedRound, report = 'full') {
  const lines = [];
  if (report === 'brief') {
    lines.push(`第 ${startedRound} 轮跑完，共 ${outcomes.length} 位发言`
      + '（全文已落盘，要看再读）：', '');
    for (const o of outcomes) {
      const flag = o.ok ? '' : ` ⚠️ ${o.error ?? '未完成'}`;
      lines.push(`  ${o.seat}. ${memberLabel(o.member)} — ${o.text.length} 字`
        + ` · ${Math.round(o.ms / 1000)} 秒${flag}`);
    }
  } else {
    lines.push(`第 ${startedRound} 轮跑完，共 ${outcomes.length} 位发言：`, '');
    for (const o of outcomes) {
      const flag = o.ok ? '' : ` ⚠️ ${o.error ?? '未完成'}`;
      lines.push(`—— 第 ${o.seat} 位 · ${memberLabel(o.member)}${flag} ——`);
      lines.push(o.text || '（没有留下文字）');
      lines.push('');
    }
  }

  const upcoming = nextSpeaker(room);
  lines.push(room.roundsExhausted
    ? `**轮次已用完**（${room.completedRounds}/${room.roundLimit} 轮）。该收会了：meeting_close。`
    : `已完成 ${room.completedRounds}/${room.roundLimit} 轮，现在在第 ${room.round} 轮。`
      + `下一位：${upcoming ? memberLabel(upcoming) : '（无）'}。`);
  return lines.join('\n');
}

/**
 * 宽松提取：取第一行非空文本。
 *
 * 它**不是解析器** —— 弱模型经常多说两句，硬解析会把好答案判成失败。
 * 法官拿它快速扫一眼就够；真要读全文，自己去房间文件里看
 * （第三招：只回可判定的答案，不回原文）。
 */
export function firstLine(text, max = 80) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 一次私聊（whisper）的结果 → 给主持人看的文本。 */
export function renderWhisperOutcome(outcome, room, report = 'full') {
  const flag = outcome.ok ? '' : ` — ⚠️ ${outcome.error ?? '未完成'}`;
  const secs = Math.round(outcome.ms / 1000);
  const head = `【私聊 · ${memberLabel(outcome.member)}】`;

  if (report === 'brief') {
    const stat = ` ${outcome.text.length} 字 · ${secs} 秒`;
    const gist = firstLine(outcome.text);
    return `${head}${outcome.ok ? stat : `${flag} ·${stat}`}\n答：${gist || '（没有回答）'}`;
  }

  return [
    `${head}${flag}`,
    '',
    outcome.text || '（这位成员没有回答）',
    '',
    `用时 ${secs} 秒。`,
  ].join('\n');
}

/**
 * 一次**并发私聊**（panel）的结果 → 给主持人看的文本。
 *
 * 报告里必须把"谁答了 / 谁没答"分清楚 —— 研究里那条提醒很实在：
 * **失败与选择混在一起记，复盘时的统计全是假的**（超时不能被当成"他决定不动手"）。
 */
export function renderPanelOutcome(outcomes, room, report = 'full') {
  const list = Array.isArray(outcomes) ? outcomes : [];
  const answered = list.filter((o) => o.ok);
  const chars = list.reduce((n, o) => n + (o.text?.length ?? 0), 0);
  const lines = [
    `【并发私聊 · ${list.length} 位】应答 ${answered.length}/${list.length}，共 ${chars} 字`,
  ];
  const missing = list.filter((o) => !o.ok);
  if (missing.length > 0) {
    lines.push(`⚠️ 没答上来的：${missing.map((o) => `${o.member.order}.${memberLabel(o.member)}`
      + `（${o.error ?? '超时'}）`).join('、')}`);
  }
  lines.push('');

  for (const o of list) {
    const flag = o.ok ? '' : ` ⚠️ ${o.error ?? '未完成'}`;
    const stat = `${o.text.length} 字 · ${Math.round(o.ms / 1000)} 秒`;
    if (report === 'brief') {
      lines.push(`${o.member.order}. ${memberLabel(o.member)} — ${stat}${flag}`);
      lines.push(`   答：${firstLine(o.text) || '（没有回答）'}`);
    } else {
      lines.push(`—— ${o.member.order}. ${memberLabel(o.member)} — ${stat}${flag} ——`);
      lines.push(o.text || '（没有回答）');
      lines.push('');
    }
  }
  return lines.join('\n');
}
