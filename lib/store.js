/**
 * 星辰会议室 —— 房间落盘。
 *
 * 目录布局（全部在 $DSH_HOME/xiaoxingchen-meeting 下）：
 *   rooms/<roomId>.json    房间状态 + 完整发言记录（唯一真相）
 *   minutes/<roomId>.md    会议纪要（主持人收会时生成）
 *
 * 为什么落盘而不是纯内存：一场会议会跨越好几个会话、持续好几分钟，中途可能
 * 有会话重启；而且哥哥要能事后翻记录。文件是唯一真相，内存里不留影子状态。
 *
 * 全部用同步 fs：房间文件只有几十 KB，而"读-改-写"必须在同一个 tick 里完成，
 * 否则并发发言会互相覆盖。同步写天然满足这一点，也省掉一层锁。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson, atomicWriteText } from './util.js';

/** 房间号白名单：只允许自家生成的形状，杜绝从路由传进来的路径穿越。 */
const ROOM_ID_RE = /^mtg-\d{8}-[0-9a-f]{6}$/;

export function isValidRoomId(id) {
  return typeof id === 'string' && ROOM_ID_RE.test(id);
}

export function createRoomStore(rootDir) {
  const roomsDir = join(rootDir, 'rooms');
  const minutesDir = join(rootDir, 'minutes');
  mkdirSync(roomsDir, { recursive: true });
  mkdirSync(minutesDir, { recursive: true });

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

  function read(id) {
    if (!isValidRoomId(id)) return null;
    const file = roomFile(id);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null; // 损坏的房间当不存在，别让它拖垮整场会议
    }
  }

  /** 原子落盘。返回写入字节数，方便调用方验证。 */
  function save(room) {
    if (!room || !isValidRoomId(room.id)) {
      throw new TypeError(`房间号非法，拒绝落盘: ${String(room?.id)}`);
    }
    room.updatedAt = Date.now();
    return atomicWriteJson(roomFile(room.id), room);
  }

  /** 全部房间，按最后活动时间倒序。 */
  function list() {
    const out = [];
    for (const id of roomIds()) {
      const room = read(id);
      if (room && room.id === id) out.push(room);
    }
    out.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
    return out;
  }

  function remove(id) {
    if (!isValidRoomId(id)) return false;
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
