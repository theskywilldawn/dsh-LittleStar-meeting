/**
 * 星辰会议室 —— 封存名单。
 *
 * 这里要说清两件**不同**的事，之前把它们混成了一件：
 *
 * 1. **技术上叫不叫得醒** —— 由 DSH 自己的**归档状态**决定
 *    （`$DSH_HOME/storages/workspace.json` 的 `global.archivedSessionIds`）。
 *    会话一旦归档，`archived-session-gate` 会拒绝它的一切模型步骤：投递进去只会
 *    `turn/start` → 几毫秒后 `turn/end`（`reason.kind === 'blocked'`），**连模型
 *    请求都不发**。所以归档的会话永远不可能在会议上开口 —— 跟日志多大无关。
 *    （2026-10-14 实证：一个 9.55 MB 的会话曾被归因为「太沉」，其实是被门挡着。）
 *
 * 2. **用户为什么封存它** —— 归档文件里只有一串 id，没有理由。
 *    理由、时间、备注是人写下来的，存在这里的 `sealed.json`。
 *
 * 所以本模块把两层合并：`all()`/`find()` 返回的每一条都带 `archived` 字段，
 * 告诉调用方「它现在到底是不是真的叫不醒」。
 *
 * 文件：$DSH_HOME/xiaoxingchen-meeting/sealed.json（只存第 2 层的东西）
 */
import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteJson } from './util.js';

export const SEALED_VERSION = 1;

function normalize(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const sessionId = String(entry.sessionId ?? '').trim();
  if (!sessionId) return null;
  return {
    sessionId,
    title: typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : null,
    reason: typeof entry.reason === 'string' && entry.reason.trim() ? entry.reason.trim() : null,
    sealedAt: Number.isFinite(entry.sealedAt) ? entry.sealedAt : null,
    sealedBy: typeof entry.sealedBy === 'string' ? entry.sealedBy : null,
  };
}

export function createSealedList(file, { archive = null } = {}) {
  let cache = null;

  function load() {
    if (cache) return cache;
    if (!existsSync(file)) {
      cache = { version: SEALED_VERSION, note: '被封存的会话无法参加会议。', sessions: [] };
      return cache;
    }
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const sessions = Array.isArray(raw?.sessions)
        ? raw.sessions.map(normalize).filter(Boolean)
        : [];
      cache = {
        version: SEALED_VERSION,
        note: typeof raw?.note === 'string' && raw.note ? raw.note
          : '被封存的会话无法参加会议。',
        sessions,
      };
    } catch {
      // 文件坏了就从空名单起，绝不因为一份名单把会议功能拖垮
      cache = { version: SEALED_VERSION, note: '（原名单文件损坏，已按空名单处理）', sessions: [] };
    }
    return cache;
  }

  function persist() {
    atomicWriteJson(file, load());
  }

  /** 给一条记录补上「它的会话现在归档了没有」，这是 DSH 说了算的。 */
  function decorate(entry) {
    if (!entry) return null;
    return {
      ...entry,
      archived: archive ? archive.has(entry.sessionId) : false,
      source: 'record',
    };
  }

  /** 合并后的名单：人写的记录 ∪ DSH 的归档列表。 */
  function all() {
    const records = load().sessions;
    const seen = new Set(records.map((entry) => entry.sessionId));
    const merged = records.map(decorate);
    if (archive) {
      for (const id of archive.all()) {
        if (seen.has(id)) continue;
        merged.push({
          sessionId: id,
          title: null,
          reason: null,
          sealedAt: null,
          sealedBy: null,
          archived: true,
          source: 'archive',       // 只有归档状态，没人写理由
        });
      }
    }
    return merged;
  }

  function find(sessionId) {
    const id = String(sessionId ?? '');
    if (!id) return null;
    const record = load().sessions.find((entry) => entry.sessionId === id);
    if (record) return decorate(record);
    if (archive?.has(id)) {
      return {
        sessionId: id,
        title: null,
        reason: null,
        sealedAt: null,
        sealedBy: null,
        archived: true,
        source: 'archive',
      };
    }
    return null;
  }

  function has(sessionId) {
    return find(sessionId) !== null;
  }

  /** 只问归档状态，不问有没有人写理由。 */
  function isArchived(sessionId) {
    return archive ? archive.has(sessionId) : false;
  }

  function seal({ sessionId, title, reason, sealedBy }, now = Date.now()) {
    const id = String(sessionId ?? '').trim();
    if (!id) throw new TypeError('少了会话 id');
    const data = load();
    const existing = data.sessions.find((entry) => entry.sessionId === id);
    if (existing) {
      if (typeof title === 'string' && title.trim()) existing.title = title.trim();
      if (typeof reason === 'string' && reason.trim()) existing.reason = reason.trim();
      if (typeof sealedBy === 'string' && sealedBy.trim()) existing.sealedBy = sealedBy.trim();
      existing.sealedAt = now;
      persist();
      return decorate(existing);
    }
    const entry = normalize({ sessionId: id, title, reason, sealedAt: now, sealedBy });
    data.sessions.push(entry);
    persist();
    return decorate(entry);
  }

  /** 只摘掉「记录」，**不碰** DSH 的归档状态 —— 那个只有用户在界面上能改。 */
  function unseal(sessionId) {
    const id = String(sessionId ?? '').trim();
    const data = load();
    const before = data.sessions.length;
    data.sessions = data.sessions.filter((entry) => entry.sessionId !== id);
    if (data.sessions.length === before) return false;
    persist();
    return true;
  }

  return Object.freeze({ file, all, find, has, isArchived, seal, unseal });
}
