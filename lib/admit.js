/**
 * 星辰会议室 —— 参会准入。
 *
 * 哥哥 2026-10-16 定的规矩：**禁止微信端和 QQ 群的小星辰进入会议室**，
 * 只有 `QQ私聊·1代小星辰` 是特例（她可以进）。
 *
 * 为什么必须挡（不是洁癖，是安全）：
 *   会议室会把**别人看不见的内容**投给成员 —— 狼人夜的私聊、身份牌、
 *   投票问询。微信端和 QQ 群是**给外人看的窗口**：那里的会话一旦坐进会场，
 *   它拿到的私密内容就可能被它自己说给群里、说给微信那头的人听。
 *   挡在入口，比事后叮嘱"别说出去"可靠得多。
 *
 * 判定顺序：**先白名单、后黑名单**。
 *   命中 allow 里任何一条 → 放行（哪怕同时也命中 deny）；
 *   否则命中 deny 里任何一条 → 拒绝；
 *   都不命中 → 放行（普通 Web 会话）。
 *
 * 规则是可配置的正则（`config.json` 的 `admit` 段），匹配 sessionId 或标题；
 * 写坏的正则**只让这一条失效**，不牵连其它规则，也绝不让插件崩掉。
 */

/**
 * 出厂规则：**任何 IM 通道都不放行** —— 微信端、QQ 群、QQ 私聊一律挡。
 *
 * 出厂值里**不写任何具体会话 id**：这个文件是公开仓库的一部分，
 * 把某位用户的 `onebot-private-<QQ号>` 写在这里等于把号码公开出去。
 *
 * 如果你确认某个 IM 会话可以进会场（比如自己专用的私聊机器人、你自己在桌边观战），
 * 在 `~/.dsh/xiaoxingchen-meeting/config.json` 里放行它，**别改这里**：
 *
 *     { "admit": { "allow": ["^onebot-private-<那个会话的 id>$"] } }
 *
 * 白名单优先于黑名单，所以写进 allow 的那条会盖过下面的 deny。
 */
export const DEFAULT_ADMIT_POLICY = Object.freeze({
  allow: Object.freeze([]),
  deny: Object.freeze([
    '^onebot-group-', // QQ 群
    '^onebot-private-', // QQ 私聊（要放行某一条，用 config 的 allow）
    '^微信\\s*[·・]', // 微信端（名册里它们都以「微信 ·」开头）
    '^wx_', // 预留：微信通道若改用 wx_ 前缀的会话 id
  ]),
});

/** 规则文案：给 UI 显示"为什么被挡"用，按上面的顺序一一对应。 */
const RULE_LABEL = [
  [/^onebot-group-/, 'QQ 群'],
  [/^onebot-private-/, 'QQ 私聊'],
  [/^微信\s*[·・]/, '微信端'],
  [/^wx_/, '微信端'],
];

/**
 * 把配置里的规则整理成可用的正则表。
 * 只保留字符串、能编译的条目；坏的一条丢掉，不影响其余。
 * @param {unknown} rules
 * @returns {RegExp[]}
 */
function compileRules(rules) {
  if (!Array.isArray(rules)) return [];
  const out = [];
  for (const raw of rules) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    try {
      out.push(new RegExp(raw));
    } catch {
      /* 写坏的正则只失效这一条 */
    }
  }
  return out;
}

/**
 * 兜底成一份完整策略。配置里只写一半也能用（另一半取出厂值）。
 * @param {{allow?: unknown, deny?: unknown}|null|undefined} raw
 */
export function normalizeAdmitPolicy(raw) {
  const hasAllow = Array.isArray(raw?.allow);
  const hasDeny = Array.isArray(raw?.deny);
  return {
    allow: compileRules(hasAllow ? raw.allow : DEFAULT_ADMIT_POLICY.allow),
    deny: compileRules(hasDeny ? raw.deny : DEFAULT_ADMIT_POLICY.deny),
    // 记录"哪几条是用户自定义的"，面板上要如实显示
    custom: { allow: hasAllow, deny: hasDeny },
  };
}

/** 一个成员身上可以被规则匹配的两个字段。 */
function targetsOf(member) {
  const sessionId = String(member?.sessionId ?? member?.id ?? '');
  const title = String(member?.title ?? '');
  return [sessionId, title].filter((s) => s !== '');
}

/** 猜这条 deny 规则是哪一类，只用于给用户一句人话。 */
function labelOf(pattern, targets) {
  for (const [re, label] of RULE_LABEL) {
    if (re.source === pattern.source && targets.some((t) => re.test(t))) return label;
  }
  return pattern.source;
}

/**
 * 判定一个人能不能进会场。
 * @param {{sessionId?: string, id?: string, title?: string}} member
 * @param {ReturnType<typeof normalizeAdmitPolicy>} policy
 * @returns {{ok: boolean, reason: string, rule: string|null}}
 */
export function judgeAdmit(member, policy) {
  const targets = targetsOf(member);
  if (targets.length === 0) {
    return { ok: false, reason: '这个会话没有 id，无法判定准入', rule: null };
  }

  for (const pattern of policy?.allow ?? []) {
    if (targets.some((t) => pattern.test(t))) {
      return { ok: true, reason: '在准入白名单里', rule: pattern.source };
    }
  }
  for (const pattern of policy?.deny ?? []) {
    if (targets.some((t) => pattern.test(t))) {
      const label = labelOf(pattern, targets);
      return { ok: false, reason: `${label}的会话不能进会议室`, rule: pattern.source };
    }
  }
  return { ok: true, reason: '普通会话', rule: null };
}

/**
 * 把一份名册切成「可邀请」与「被挡下」两堆。
 * 被挡的也要返回（带理由），UI 上要**显示出来**：用户看得见"谁被挡了、为什么"，
 * 才不会以为名单漏了人。
 * @param {Array<object>} members
 * @param {ReturnType<typeof normalizeAdmitPolicy>} policy
 */
export function splitRoster(members, policy) {
  const allowed = [];
  const blocked = [];
  for (const member of members ?? []) {
    const verdict = judgeAdmit(member, policy);
    if (verdict.ok) allowed.push({ ...member, admit: verdict });
    else blocked.push({ ...member, admit: verdict });
  }
  return { allowed, blocked };
}
