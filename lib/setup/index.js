/**
 * 星辰会议室 · 会议准备页 —— 页面组装。
 *
 * 哥哥 2026-10-16 要的流程：
 *   在输入框打 `/meeting` → **直接弹出浏览器窗口** → 这里选：
 *     ① 普通会议 还是 狼人杀
 *     ② 人数 / 发言长度（软上限）/ 主题 / 轮次（狼人杀换成规则开关）
 *     ③ 挑参会 AI + 定主持人（+ 自己要不要也参加）
 *   → 点开始，房间就开好了。
 *
 * 两块 UI 分得很开：普通会议走蓝白科技简约（`theme-meeting.js`），
 * 狼人杀走暗夜血月（`theme-werewolf.js`）—— 同一套骨架，两身皮。
 *
 * 这里只管**画页面**，不碰任何业务：开局由 `POST /api/setup/start` 接。
 */

import { baseCss } from './base.js';
import { meetingTheme, BRAND_MARK as MARK_MEETING } from './theme-meeting.js';
import { werewolfTheme, BRAND_MARK as MARK_WOLF } from './theme-werewolf.js';
import { clientScript } from './client.js';

/** HTML 转义（服务端拼接用）。 */
function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 把值嵌进 `<script>` 当 JSON 用（`JSON.stringify` 不转义 `<`）。 */
function jsonForScript(value) {
  return (JSON.stringify(value) ?? 'null')
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * 狼人杀的规则开关（按钮式）。
 *
 * `on` 是**出厂默认**，页面上的开关只影响这一局怎么判 —— 规则本身写在
 * 《法官手册》`WEREWOLF.md` 里，插件不实现任何一条，只把这份口径交给法官。
 */
export const WOLF_RULES = Object.freeze([
  { key: 'sheriff', on: true, ic: '🔮', name: '警长竞选', desc: '首日上警 → 上警发言 → 退水 → 警下投票' },
  { key: 'badge', on: true, ic: '🎖️', name: '警徽传递', desc: '警长死亡时可移交警徽，也可撕掉' },
  { key: 'lastNight1', on: true, ic: '⚰️', name: '首夜遗言', desc: '第一夜死者留遗言' },
  { key: 'lastVote', on: true, ic: '🕯️', name: '放逐遗言', desc: '白天被票出局者留遗言' },
  { key: 'boom', on: true, ic: '💥', name: '狼人自爆', desc: '发言环节可自爆，当场转入黑夜' },
  { key: 'boomEat', on: true, ic: '🌑', name: '自爆吞警徽', desc: '警上自爆 → 警徽流失，本局无警长' },
  { key: 'sameSaveDie', on: true, ic: '⚖️', name: '同守同救仍死', desc: '被守卫守住又被女巫救，依然出局' },
  { key: 'hunterPoison', on: true, ic: '🔫', name: '被毒不能开枪', desc: '猎人被女巫毒杀时无法开枪' },
  { key: 'witchSelfSave', on: false, ic: '🧪', name: '女巫首夜可自救', desc: '默认首夜不可自救' },
  { key: 'guardRepeat', on: false, ic: '🛡️', name: '守卫可连守', desc: '默认不可连守同一人（可守自己）' },
  // 2026-10-19 哥哥补的两条：都是"公开到什么程度"，法官照着口径宣布
  { key: 'revealDeathCause', on: true, ic: '💀', name: '公布死因', desc: '天亮时是否说明夜里出局的人怎么死的（被刀 / 被毒 / 被带走）' },
  { key: 'revealVotes', on: true, ic: '🗳️', name: '投票来源显示', desc: '放逐投票后是否公布「谁投了谁」的明细，关掉就只报总票数' },
]);

/**
 * 渲染整个准备页。
 * @param {object} options
 * @param {string} options.route 插件路由前缀（如 `/xiaoxingchen-meeting`）
 * @param {Array} options.members 可邀请的会话（**已经过准入过滤**）
 * @param {Array} options.blocked 被准入规则挡下的会话（只用于显示一句提示）
 * @param {string} options.dshVersion 显示用
 */
export function renderSetupHtml({
  route, members = [], blocked = [], roomCount = 0, archivedCount = 0, humanWaitSeconds = 600,
  fontScale = 1,
}) {
  const memberPayload = members.map((m) => ({
    sessionId: String(m.sessionId ?? ''),
    title: String(m.title ?? ''),
    cwd: String(m.cwd ?? ''),
    weight: String(m.weight ?? ''),
  }));

  const blockedNote = blocked.length === 0
    ? ''
    : `<p class="panel-note" style="margin:14px 0 0">ℹ️ 另有 <b>${blocked.length}</b> 个会话被准入规则挡在门外（`
      + `${esc(summarizeBlocked(blocked))}）—— 微信端与 QQ 群不会进入会场。</p>`;
  // 已封存（归档）的会话不列进名单 —— 投递会被归档门挡下，选了也白选
  // （2026-10-19 哥哥在准备页还能看到封存的小星辰）
  const archivedNote = archivedCount > 0
    ? `<p class="panel-note" style="margin:10px 0 0">🔒 另有 <b>${archivedCount}</b> 位已经封存（归档）—— 投递不进去，`
      + '所以这里不列出。</p>'
    : '';

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>星辰会议室 · 准备开局</title>
<style>:root{--fs-scale:${fontScale}}${baseCss()}${meetingTheme()}${werewolfTheme()}</style>
</head><body data-kind="">
<div class="page">

  <header class="head">
    <span id="mark-meeting">${MARK_MEETING}</span>
    <span id="mark-wolf" class="hidden">${MARK_WOLF}</span>
    <h1 class="brand">星辰会议室</h1>
    <span class="spacer"></span>
    <span class="tag" id="tag-kind">未选择</span>
  </header>

  <!-- ── 第一步：选类型 ─────────────────────────────── -->
  <section id="step-pick">
    <div class="steps"><b>第 1 步</b><span class="sep">/</span>共 2 步<span class="sep">·</span>先决定这一场是什么</div>
    <div class="picker">
      <button class="pick primary" data-kind="meeting" type="button">
        <span class="icon">📋</span>
        <p class="name">普通会议</p>
        <p class="desc">定主题、定轮次，让小星辰们依次发言。<br>适合议事、讨论、多视角过一遍问题。</p>
        <span class="go">选它 →</span>
      </button>
      <button class="pick" data-kind="werewolf" type="button">
        <span class="icon">🐺</span>
        <p class="name">狼人杀</p>
        <p class="desc">法官主持，身份随机，白天发言夜里行动。<br>开局前可以逐条开关规则。</p>
        <span class="go">选它 →</span>
      </button>
    </div>
    ${blockedNote}
    ${archivedNote}
  </section>

  <!-- ── 第二步：配置 ───────────────────────────────── -->
  <section id="step-config" class="hidden">
    <div class="steps"><b>第 2 步</b><span class="sep">/</span>共 2 步<span class="sep">·</span>设定这一场怎么跑</div>
    <h2 class="brand" id="cfg-title" style="font-size:1.2667rem;margin:0 0 18px"></h2>

    <!-- 普通会议专属 -->
    <div class="panel hidden" id="only-meeting">
      <p class="panel-title">会议内容</p>
      <p class="panel-note">主题决定大家聊什么；轮次是每人依次发言一遍算一轮。</p>
      <div class="field">
        <label class="field-label" for="topic">会议主题</label>
        <input class="text-input" id="topic" type="text" placeholder="例如：给这只股票把把脉 / 复盘今天这局"
               autocomplete="off" spellcheck="false">
        <p class="field-hint">留空也行 —— 主持人会自己拟一个。</p>
      </div>
      <div class="field">
        <span class="field-label">会议轮次</span>
        <span class="stepper">
          <button type="button" data-field="rounds" data-delta="-1" data-min="1" data-max="20" aria-label="减一轮">−</button>
          <span class="val" id="val-rounds">3</span>
          <button type="button" data-field="rounds" data-delta="1" data-min="1" data-max="20" aria-label="加一轮">+</button>
        </span>
        <p class="field-hint">1–20 轮。轮次用完了随时可以再加。</p>
      </div>
    </div>

    <!-- 人数 + 发言长度 -->
    <div class="panel">
      <p class="panel-title">基本设置</p>
      <p class="panel-note" id="size-note">参会人数包含你自己（如果勾了"我也参加"）。</p>

      <div class="field" id="size-stepper">
        <span class="field-label">参会人数</span>
        <span class="stepper">
          <button type="button" data-field="size" data-delta="-1" data-min="2" data-max="18" aria-label="减一人">−</button>
          <span class="val" id="val-size">6</span>
          <button type="button" data-field="size" data-delta="1" data-min="2" data-max="18" aria-label="加一人">+</button>
        </span>
      </div>

      <div class="field hidden" id="size-numbar">
        <span class="field-label">本局人数</span>
        <div class="numbar">
          ${[4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `<button type="button" data-n="${n}" aria-pressed="false">${n}</button>`).join('')}
        </div>
        <p class="field-hint">人数决定板子（几狼几神几民），法官手册里有对照表。</p>
      </div>

      <div class="field">
        <label class="field-label" for="speak">发言长度软上限<span class="opt">超了不拦，只提醒</span></label>
        <div class="slider-row">
          <input type="range" id="speak" min="100" max="2000" step="50" value="500">
          <span class="slider-val" id="val-speak">500 字</span>
        </div>
        <p class="field-hint">${
  '这是"软上限"：法官会在投递里带上它，让发言别太啰嗦；但真有话要说，超了也照收。'
}</p>
      </div>
    </div>

    <!-- 狼人杀专属：规则开关 -->
    <div class="panel hidden" id="only-werewolf">
      <p class="panel-title">规则开关</p>
      <p class="panel-note">点亮 = 这一局启用。开关只影响本局口径，规则本身写在《法官手册》里。</p>
      <div class="rules">
        ${WOLF_RULES.map((r) => `<button class="rule" type="button" data-key="${esc(r.key)}" aria-pressed="${r.on ? 'true' : 'false'}">
          <span class="r-ic">${r.ic}</span>
          <span class="r-name">${esc(r.name)}</span>
          <span class="r-desc">${esc(r.desc)}</span>
          <span class="r-state"></span>
        </button>`).join('')}
      </div>
    </div>

    <!-- 参会 AI -->
    <div class="panel">
      <p class="panel-title">参会 AI<span class="spacer" style="flex:1"></span></p>
      <p class="panel-note">
        点名字＝选进本局，<b>选的先后就是发言顺序</b>；点右边的圆点＝设为<b>主持人（法官）</b>。
        主持人自己也占一个名额，且他会负责推进整场。
      </p>
      <div class="field" style="margin:0 0 12px">
        <label class="field-label" for="seatOrder">座位顺序<span class="opt">号位 = 默认发言顺序</span></label>
        <select id="seatOrder">
          <option value="pick">按我点选的先后</option>
          <option value="random">随机打乱（当场洗牌）</option>
        </select>
        <p class="field-hint">狼人杀里座位号会写进发言顺序、警徽流、「刀 N 号」，所以它本身也是信息。想公平一点就选随机。</p>
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span class="tag" id="pick-progress">已选 0 / 需要 0</span>
      </div>
      <div class="roster" id="roster"><div class="empty">加载中…</div></div>
    </div>

    <!-- 我也参加 -->
    <div class="panel">
      <label class="roster-item" style="cursor:pointer">
        <input type="checkbox" id="joinSelf" style="width:19px;height:19px;accent-color:var(--accent);flex:none">
        <span class="roster-main">
          <span class="roster-name">我也参加</span>
          <span class="roster-meta">你会占一个参会名额；<b>在轮转里</b> —— 轮到你时会场页高亮并倒数 <b>${humanWaitSeconds} 秒</b>（按你自己读+想+打字的速度算，可在设置里调），在页面下方说完大家才继续；没轮到时也能随时插话</span>
        </span>
      </label>
      <div id="myrole-wrap" class="myrole hidden">
        <div style="display:flex;gap:14px;flex-wrap:wrap">
          <div style="flex:1;min-width:150px">
            <label class="field-label" for="myRole">我想当</label>
            <select id="myRole">
              <option value="">随机（跟其他人一样）</option>
              <option value="村民">村民</option>
              <option value="预言家">预言家</option>
              <option value="女巫">女巫</option>
              <option value="猎人">猎人</option>
              <option value="守卫">守卫</option>
              <option value="狼人">狼人</option>
            </select>
          </div>
          <div style="flex:1;min-width:150px">
            <label class="field-label" for="mySeat">我坐第几号</label>
            <select id="mySeat"><option value="">随机</option></select>
          </div>
        </div>
        <p class="field-hint">「我想当」只是告诉法官你想拿哪张牌，凑不出这个板子时他会按实际人数调整并告诉你。「我坐第几号」不填就随机。</p>
      </div>
    </div>

    <div class="actions">
      <button class="btn btn-ghost" id="back" type="button">← 换一种</button>
      <span class="spacer"></span>
      <span class="field-hint" id="start-why" style="margin:0"></span>
      <button class="btn btn-primary" id="start" type="button" disabled>开始</button>
    </div>

    <div class="result" id="result"></div>
  </section>

</div>
<div class="toast" id="toast"></div>
<script>
window.__MTG_ROUTE__=${jsonForScript(route)};
window.__MTG_MEMBERS__=${jsonForScript(memberPayload)};
window.__MTG_RULES__=${jsonForScript(WOLF_RULES.map((r) => ({ key: r.key, on: r.on })))};
${clientScript()}
</script>
</body></html>`;
}

/** 把被挡下的会话按原因归一句人话。 */
function summarizeBlocked(blocked) {
  const tally = new Map();
  for (const item of blocked) {
    const label = String(item?.admit?.reason ?? '被规则挡下').replace(/的会话不能进会议室$/, '');
    tally.set(label, (tally.get(label) ?? 0) + 1);
  }
  return [...tally.entries()].map(([label, n]) => `${label} ${n} 个`).join('、');
}

/**
 * 狼人杀的人数 → 板子对照（法官手册里也有一份，这里只用于页面提示与开局元数据）。
 * 返回 `{ wolves, gods, villagers, godList }`；没有对照表的人数给 null。
 */
export const WOLF_BOARDS = Object.freeze({
  4: { wolves: 1, gods: 1, villagers: 2, godList: ['预言家'] },
  5: { wolves: 1, gods: 2, villagers: 2, godList: ['预言家', '女巫'] },
  6: { wolves: 2, gods: 2, villagers: 2, godList: ['预言家', '女巫'] },
  7: { wolves: 2, gods: 2, villagers: 3, godList: ['预言家', '女巫'] },
  8: { wolves: 2, gods: 3, villagers: 3, godList: ['预言家', '女巫', '猎人'] },
  9: { wolves: 3, gods: 3, villagers: 3, godList: ['预言家', '女巫', '猎人'] },
  10: { wolves: 3, gods: 3, villagers: 4, godList: ['预言家', '女巫', '猎人'] },
  11: { wolves: 3, gods: 4, villagers: 4, godList: ['预言家', '女巫', '猎人', '守卫'] },
  12: { wolves: 4, gods: 4, villagers: 4, godList: ['预言家', '女巫', '猎人', '守卫'] },
});
