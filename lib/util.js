/**
 * 星辰会议室 —— 零依赖小工具。
 *
 * 这里只放纯粹的、与 DSH 无关的函数，方便脱离宿主直接跑单测。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

/** 生成房间号，形如 mtg-20261014-a1b2c3。日期只为人类可读，唯一性靠随机段。 */
export function newRoomId(now = Date.now()) {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `mtg-${y}${m}${day}-${randomBytes(3).toString('hex')}`;
}

/** 短令牌：写进投递给参会者的消息里，用来在事件流中认出"这一条是我们的"。 */
export function newToken() {
  return randomBytes(4).toString('hex');
}

/** RPC / prompt 调用用的请求 id。 */
export function newRequestId() {
  return `xiaoxingchen-meeting-${randomUUID()}`;
}

/** 本地时间字符串，给人看的。 */
export function fmtTime(ts, zone = 'Asia/Shanghai') {
  try {
    return new Date(ts).toLocaleString('zh-CN', { timeZone: zone, hour12: false });
  } catch {
    return new Date(ts).toISOString();
  }
}

/** 时分秒，纪要里用。 */
export function fmtClock(ts, zone = 'Asia/Shanghai') {
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', { timeZone: zone, hour12: false });
  } catch {
    return new Date(ts).toISOString().slice(11, 19);
  }
}

/**
 * 从一个 Message（或裸 content 数组）里抽出所有 text 块，拼成一段文本。
 * 刻意只取 text：工具调用、图片、推理块都不是"发言"。
 */
export function textOfMessage(message) {
  const content = Array.isArray(message?.content)
    ? message.content
    : Array.isArray(message) ? message : [];
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * 原子写 JSON：先写 .tmp，再 rename 覆盖。
 * Windows 上 rename 覆盖是原子的；偶发 EPERM（杀软/索引锁）时重试一次。
 */
export function atomicWriteJson(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8' });
  try {
    renameSync(tmp, file);
  } catch (error) {
    // 再试一次；仍失败就清理临时文件并抛出，绝不留下半个文件
    try {
      renameSync(tmp, file);
    } catch {
      try { unlinkSync(tmp); } catch { /* 清理失败不掩盖原始错误 */ }
      throw error;
    }
  }
  return text.length;
}

/** 原子写文本（纪要用）。 */
export function atomicWriteText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8' });
  try {
    renameSync(tmp, file);
  } catch (error) {
    try {
      renameSync(tmp, file);
    } catch {
      try { unlinkSync(tmp); } catch { /* 同上 */ }
      throw error;
    }
  }
  return text.length;
}

/** 把长文本截短到 max 字符，末尾加省略号（纪要与提示词里都用得上）。 */
export function clip(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/** 会话标题兜底：没有标题就用短 id。 */
export function shortId(sessionId) {
  const s = String(sessionId ?? '');
  return s.length <= 12 ? s : `${s.slice(0, 8)}…${s.slice(-4)}`;
}
