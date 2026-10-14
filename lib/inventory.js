/**
 * 星辰会议室 —— 会话体量盘点。
 *
 * 为什么要这个东西：让另一个会话说一句话，Host 得先把它的**整份日志读回来**
 * （`sessionController.prompt` → `resolveAgent` → resume）。这一步的成本随日志增长，
 * 但**绝对值很小**：2026-10-14 实测，9.55 MB 的日志（3839 个 zstd 帧 → 33.5 MB 明文、
 * 6695 行 JSONL）整个读回来只要 **298 毫秒** —— 其中从盘上读 9.55 MB 只占 **1.9 毫秒**。
 * 磁盘从来不是瓶颈，换更快的盘也省不下什么。
 *
 * 真正要等的是模型：日志被压缩过之后，最后一段未压缩的历史加上摘要，仍可能有几十万
 * token，首字延迟随它增长。所以体量标注的意义是**预告首字会慢**，不是"她醒不过来"。
 *
 * **决定一个成员开不开得了口的是归档状态**，见 archive.js —— 归档的会话被
 * archived-session-gate 挡着，投递进去连模型请求都发不出去。
 *
 * 会话日志的位置：`$DSH_HOME/sessions/<转义后的工作区路径>/<sessionId>/session.v4.jsonl.zstd`
 * 只读 stat，不解压、不读内容。
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const SESSION_LOG_NAME = 'session.v4.jsonl.zstd';

const MB = 1024 * 1024;

/** 分档阈值：按「读回来 + 模型首字」的经验成本分级，**不代表能不能醒**。 */
export const HEAVY_MB = 2;
export const HUGE_MB = 8;

/**
 * 按日志字节数分级。
 * @returns {{level: 'light'|'heavy'|'huge'|'unknown', mb: number|null, label: string, warn: boolean}}
 */
export function weighLog(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return { level: 'unknown', mb: null, label: '体量未知', warn: false };
  }
  const mb = bytes / MB;
  if (mb < HEAVY_MB) {
    return { level: 'light', mb, label: `日志 ${mb.toFixed(1)} MB`, warn: false };
  }
  if (mb < HUGE_MB) {
    return { level: 'heavy', mb, label: `日志 ${mb.toFixed(1)} MB（偏大，首字会慢些）`, warn: true };
  }
  return { level: 'huge', mb, label: `日志 ${mb.toFixed(1)} MB（很大，首字会慢）`, warn: true };
}

/**
 * 扫一遍会话存储根目录，返回 sessionId → 日志字节数。
 * 目录结构是两层的，直接遍历；任何一层读不到就跳过，绝不因此抛错。
 */
export function scanSessionLogSizes(sessionsRoot) {
  const out = new Map();
  if (typeof sessionsRoot !== 'string' || !sessionsRoot) return out;
  let workspaces;
  try {
    workspaces = readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = join(sessionsRoot, workspace.name);
    let sessions;
    try {
      sessions = readdirSync(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      try {
        const stat = statSync(join(workspaceDir, session.name, SESSION_LOG_NAME));
        if (stat.isFile()) out.set(session.name, stat.size);
      } catch {
        /* 没有日志文件的会话（新会话、空会话）就跳过 */
      }
    }
  }
  return out;
}

/**
 * 带缓存的盘点器。日志大小变得很慢，默认 60 秒内复用同一份快照。
 * @param {{sessionsRoot: string, ttlMs?: number, now?: () => number}} options
 */
export function createInventory({ sessionsRoot, ttlMs = 60_000, now = Date.now }) {
  let cache = { at: 0, sizes: new Map() };

  function snapshot({ refresh = false } = {}) {
    if (!refresh && cache.sizes.size > 0 && now() - cache.at < ttlMs) return cache.sizes;
    const sizes = scanSessionLogSizes(sessionsRoot);
    cache = { at: now(), sizes };
    return sizes;
  }

  /** 某一个会话的体量。 */
  function weigh(sessionId, { refresh = false } = {}) {
    const sizes = snapshot({ refresh });
    return weighLog(sizes.has(sessionId) ? sizes.get(sessionId) : NaN);
  }

  return Object.freeze({
    sessionsRoot,
    snapshot,
    weigh,
    /** 统计有多少个会话属于"日志很大（≥8 MB）"那一档。 */
    countRisky(sessionIds) {
      const sizes = snapshot();
      let risky = 0;
      for (const id of sessionIds ?? []) {
        const bytes = sizes.get(id);
        if (Number.isFinite(bytes) && bytes >= HUGE_MB * MB) risky += 1;
      }
      return risky;
    },
  });
}
