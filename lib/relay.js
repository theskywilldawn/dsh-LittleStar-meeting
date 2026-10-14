/**
 * 星辰会议室 —— 跨会话投递与发言收集（整个插件的地基）。
 *
 * 它解决一个问题：怎么让"另一个会话里的小星辰"开口说一段话，并且把他说的
 * 内容原样拿回来。
 *
 * 两条腿：
 *   1) 投递 —— 首选 `sessionController.resolveAgent()` 拿到目标 Agent，再用
 *      `agent.followup()` 投一条**自带 source 的 user 消息**；拿不到 Agent 时退回
 *      官方入口 `sessionController.prompt()`。
 *   2) 收集 —— 监听全局的 `session/event`，认出我们自己投进去的那条消息，然后把它
 *      之后的 `assistant/message` 文本块攒起来，直到 `turn/end`。
 *
 * 为什么要绕一下、不用现成的 prompt（2026-10-14 哥哥提的第 6 条）：
 *   `prompt()` 把 source 写死成 `{kind:'user', rpcId, clientTimeZone}`，于是这条消息在
 *   参会成员的会话界面里长成一个**完整的用户气泡**，一整段会议记录就那样铺在人家的
 *   对话流里。而 DSH 的 Chat 对 source 是分流的（`dsh-client-ui-chat` 的
 *   `contextProducer` / `messageDefinition`）：**kind 不是 'user' 的消息不算"人说的话"**，
 *   它渲染成 `context` 注入行、唤醒空闲会话时渲染成一张**折叠的 `turn-trigger` 卡片**
 *   （标题 + 时间，正文要点开才看，且限高 240px）—— 这正是我们要的效果：
 *   会议内容仍然完整进模型请求，但**不在成员的会话界面里铺开**。
 *
 * 怎么认出"那条是我的"：source 里带 `rpcId`（与 prompt 同款字段），所以按 rpcId
 * 精确匹配；正文里的随机令牌是第二道保险 —— 万一某个版本不带 rpcId，也能靠它认出来。
 *
 * 只读别人的会话日志，从不往别人的会话日志里直接写事件 —— 唯一的写入就是这次投递。
 */
import { randomUUID } from 'node:crypto';
import { newRequestId, textOfMessage } from './util.js';

/** 默认等待上限（毫秒）。等标记 vs 等发言，分开设，因为两者失败的含义不同。 */
export const DEFAULT_MARK_WAIT_MS = 3 * 60 * 1000;
export const DEFAULT_REPLY_WAIT_MS = 10 * 60 * 1000;

/** 投递消息在 Chat 里的 source 形态 —— 让它走"上下文注入"而不是"用户气泡"。 */
export const SOURCE_KIND = 'xiaoxingchen-meeting';

function describeError(error) {
  if (!error) return '未知错误';
  const code = error.code ? `${error.code}: ` : '';
  return `${code}${error.message ?? String(error)}`;
}

function reasonKind(reason) {
  if (!reason || typeof reason !== 'object') return null;
  return typeof reason.kind === 'string' ? reason.kind : null;
}

/**
 * 手搓一条 user 消息。
 *
 * 不 import `@deepseek-ai/dsh-llm` 的 `createUserMessage`：那个包在 DSH 自己的
 * node_modules 里，插件这边解析不到（本地插件是从 profile 的 node_modules 加载的）。
 * 而 createUserMessage 干的事就是 `{...input, role:'user', id: randomUUID()}`，
 * 我们照做即可 —— 事件落库时 Session 会自己快照并冻结。
 */
function buildUserMessage(text, source) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  };
}

export function createRelay(ctx, logger = console) {
  const sessionController = ctx.sessionController;

  /**
   * 拿到目标会话的 Agent。冷会话会被自动 resume —— 这正是我们要的：
   * 一场会议里的成员大多数时候是睡着的。
   */
  async function resolveMemberAgent(sessionId) {
    if (sessionController && typeof sessionController.resolveAgent === 'function') {
      const resolved = await sessionController.resolveAgent(sessionId);
      const agent = resolved?.agent ?? resolved;
      if (agent && typeof agent.followup === 'function') return agent;
    }
    const agents = ctx.get?.('agents') ?? ctx.agents;
    const agent = agents?.get?.(sessionId);
    return agent && typeof agent.followup === 'function' ? agent : null;
  }

  /**
   * 投递一条消息。返回实际走的通道，便于在工具返回值里如实报告。
   *
   * 走"直接 followup"是为了自定义 source（界面渲染）；走不通就退回官方 prompt。
   * **两层都包了 try** —— 一场会议不能因为一个花哨的 source 就开不下去：
   * 拿不到 Agent、或 followup 被拒绝，都自动降级，最多是这条在界面上显示成用户气泡。
   * @returns {Promise<{via: 'followup'|'prompt', note?: string}>}
   */
  async function deliver(sessionId, text, { requestId, source }, signal) {
    const viaPrompt = async (note) => {
      await sessionController.prompt({
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: resolveTimeZone(),
      }, signal);
      return note === undefined ? { via: 'prompt' } : { via: 'prompt', note };
    };

    let agent = null;
    try {
      agent = await resolveMemberAgent(sessionId);
    } catch (error) {
      return viaPrompt(`拿不到目标 Agent（${describeError(error)}）`);
    }
    if (!agent) return viaPrompt('拿不到目标 Agent');

    try {
      agent.followup(buildUserMessage(text, source));
      return { via: 'followup' };
    } catch (error) {
      return viaPrompt(`直接投递被拒（${describeError(error)}）`);
    }
  }

  /**
   * 把 text 投给 sessionId 对应的小星辰，等他这一轮说完，返回他说的内容。
   *
   * @param {object} options
   * @param {string} options.sessionId  目标会话
   * @param {string} options.text       投递的正文（里面必须包含 options.token）
   * @param {string} options.token      识别用的随机令牌
   * @param {object} [options.source]   额外的 source 字段（会与 kind/form/rpcId 合并）
   * @param {number} [options.markWaitMs]  等"消息被受理"的上限
   * @param {number} [options.replyWaitMs] 等"这一轮说完"的上限
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{ok: boolean, phase: string, text: string, chunks: string[],
   *   endReason: string|null, ms: number, via: string|null, error?: string}>}
   */
  async function relay(options) {
    const {
      sessionId,
      text,
      token,
      source: sourceExtra = null,
      markWaitMs = DEFAULT_MARK_WAIT_MS,
      replyWaitMs = DEFAULT_REPLY_WAIT_MS,
      signal,
    } = options ?? {};

    const started = Date.now();
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, phase: 'error', text: '', chunks: [], endReason: null, ms: 0, via: null, error: '缺少目标会话' };
    }
    if (typeof token !== 'string' || !token) {
      return { ok: false, phase: 'error', text: '', chunks: [], endReason: null, ms: 0, via: null, error: '缺少识别令牌' };
    }
    if (!sessionController || typeof sessionController.prompt !== 'function') {
      return {
        ok: false, phase: 'error', text: '', chunks: [], endReason: null, ms: 0, via: null,
        error: 'sessionController.prompt 不可用（宿主未提供该服务）',
      };
    }
    if (signal?.aborted) {
      return { ok: false, phase: 'aborted', text: '', chunks: [], endReason: null, ms: 0, via: null, error: '已取消' };
    }

    const chunks = [];
    let markSeen = false;
    let endReason = null;
    let via = null;
    const requestId = newRequestId();
    // 投递身份：kind 决定了它在对方界面里是"上下文注入"而不是"用户气泡"，
    // rpcId 决定我们能不能在事件流里认出它。两者缺一不可。
    //
    // 自定义字段**放在前面**：这样调用方顶不掉这三个受控字段（否则一条带 rpcId 的
    // extra 就能让这次投递永远认不回来，会议干等到超时）。
    const source = {
      ...(sourceExtra && typeof sourceExtra === 'object' ? sourceExtra : {}),
      kind: SOURCE_KIND,
      form: 'notice',
      rpcId: requestId,
      clientTimeZone: resolveTimeZone(),
    };
    let settle;
    const finished = new Promise((resolve) => { settle = resolve; });

    let timer = null;
    const arm = (ms, outcome) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => settle(outcome), Math.max(1000, ms));
    };

    const onEvent = (session, event) => {
      // 只关心目标会话；其他会话的事件一律无视（这是全局监听，事件量很大）
      if (!session || String(session.id) !== String(sessionId)) return;
      if (!event || typeof event.type !== 'string') return;

      if (!markSeen) {
        // 受理之前什么都不收集：目标可能本来就在跑一轮，那一段不是我们的发言
        if (event.type !== 'user/message') return;
        const rpcId = event.data?.source?.rpcId;
        const byRpcId = typeof rpcId === 'string' && rpcId === requestId;
        const byToken = !byRpcId && textOfMessage(event.data).includes(token);
        if (byRpcId || byToken) {
          markSeen = true;
          arm(replyWaitMs, 'timeout-reply');
        }
        return;
      }

      if (event.type === 'assistant/message') {
        const said = textOfMessage(event.data?.message);
        if (said) chunks.push(said);
        return;
      }
      if (event.type === 'turn/end') {
        endReason = reasonKind(event.data?.reason);
        settle('done');
      }
    };

    const onAbort = () => settle('aborted');
    let off = null;
    try {
      off = ctx.on('session/event', onEvent, { global: true });
    } catch (error) {
      return {
        ok: false, phase: 'error', text: '', chunks, endReason: null, ms: Date.now() - started, via: null,
        error: `无法监听会话事件: ${describeError(error)}`,
      };
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    arm(markWaitMs, 'timeout-mark');

    let outcome;
    try {
      const sent = await deliver(sessionId, text, { requestId, source }, signal);
      via = sent.note === undefined ? sent.via : `${sent.via}（${sent.note}）`;
      outcome = await finished;
    } catch (error) {
      return {
        ok: false, phase: 'error', text: '', chunks, endReason: null, ms: Date.now() - started, via,
        error: describeError(error),
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { off?.(); } catch { /* 注销失败不该覆盖真正的结果 */ }
    }

    const body = chunks.join('\n\n').trim();
    if (outcome === 'aborted') {
      return { ok: false, phase: 'aborted', text: body, chunks, endReason, ms: Date.now() - started, via, error: '已取消' };
    }
    if (outcome === 'timeout-mark') {
      return {
        ok: false, phase: 'timeout-mark', text: body, chunks, endReason: null, ms: Date.now() - started, via,
        error: '对方迟迟没有受理这次发言（可能正忙，或该会话不接受投递）',
      };
    }
    if (outcome === 'timeout-reply') {
      // 已经开口了，只是没等到收尾 —— 把拿到的部分当发言用，但标出来
      return {
        ok: body.length > 0, phase: 'timeout-reply', text: body, chunks, endReason, ms: Date.now() - started, via,
        error: body.length > 0 ? null : '等对方说完超时，且没有收到任何文字',
      };
    }
    return { ok: true, phase: 'done', text: body, chunks, endReason, ms: Date.now() - started, via };
  }

  return Object.freeze({ relay });
}

function resolveTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}
