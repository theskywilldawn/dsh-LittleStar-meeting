/**
 * 星辰会议室 —— DSH 归档状态读取器。
 *
 * 「封存」在 DSH 里对应的就是**归档（archive）**：会话一旦归档，
 * `archived-session-gate` 会拒绝它的一切模型步骤 —— 排队的 follow-up 投进去
 * 只会 `turn/start` → 几毫秒后 `turn/end`，**连模型请求都不发**。
 * 所以归档的会话永远不可能在会议上开口，跟日志多大、硬盘多快都没关系。
 *
 * 权威状态在 $DSH_HOME/storages/workspace.json 的 global.archivedSessionIds。
 * **只读它，绝不写** —— 归档/解归档是用户在界面上的动作，我们不去碰。
 * 归档之后 DSH 会立刻落盘（实测：界面上点完，文件 mtime 同秒更新）。
 */
import { existsSync, readFileSync } from 'node:fs';

export function createArchiveReader(file, { ttlMs = 1000, now = () => Date.now() } = {}) {
  let cache = null;
  let stampedAt = 0;

  function ids() {
    const t = now();
    if (cache !== null && t - stampedAt < ttlMs) return cache;
    let list = [];
    try {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        const arr = raw?.global?.archivedSessionIds;
        if (Array.isArray(arr)) list = arr.filter((x) => typeof x === 'string' && x);
      }
    } catch {
      // 读不到 / 文件坏了，就当没人被归档 —— 绝不因为一份状态文件把会议功能拖垮
      list = [];
    }
    cache = list;
    stampedAt = t;
    return cache;
  }

  function has(sessionId) {
    const id = String(sessionId ?? '');
    return id !== '' && ids().includes(id);
  }

  function all() {
    return [...ids()];
  }

  function invalidate() {
    cache = null;
    stampedAt = 0;
  }

  return Object.freeze({ file, all, has, invalidate });
}
