/**
 * 星辰会议室 · 会议准备页 —— 「狼人杀」主题：暗夜 · 血月 · 金红。
 *
 * 跟普通会议那套共用骨架，只换皮。这一套要的是**进游戏的感觉**：
 * 深蓝黑的夜、一轮压在头顶的血月、远处村口的松林剪影；
 * 控件做成卡牌，开启的规则会"亮起来"（金边 + 外发光）。
 *
 * ⚠️ 作用域（2026-10-16 踩过的坑）：两套主题在同一个页面里同时存在，
 * 这一套**全部**挂在 `body[data-kind="werewolf"]` 下面 —— 变量、装饰、组件样式，
 * 一条都不能漏出去。选中「狼人杀」时客户端会给 body 加上这个属性，
 * 整页就"入夜"了；回到类型选择屏又变回蓝白。
 *
 * 可读性优先：装饰都在 `z-index:0` 的固定层里，正文永远在上层；月亮只压顶部、
 * 透明度压到不影响看字。
 */

/** 虎鲸尾巴标识（狼人杀版：暗金调，跟页面配色一致）。 */
export const BRAND_MARK = `<svg class="mark" viewBox="0 0 40 40" aria-hidden="true">
<defs><linearGradient id="bmw" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#d4af37"/><stop offset="1" stop-color="#8a1f16"/>
</linearGradient></defs>
<circle cx="20" cy="20" r="19" fill="url(#bmw)" stroke="rgba(212,175,55,.55)" stroke-width="1.5"/>
<path d="M11 24c3.2 0 5.6-1.6 7.4-3.6 1.5-1.7 3.4-3.4 6-3.9-.5 1.5-.4 3 .3 4.3 1 1.9 3 3 5.3 3.1-1.2 1.1-3 2.2-5.2 2.2-1.6 0-3-.5-4.2-1.3-1.7 1.9-4 3.2-7 3.2-.9 0-1.7-.1-2.4-.4.5-.5 1-1.1 1.3-1.7-.5-.6-.9-1.2-1.5-1.9Z" fill="#f3e5c0" opacity=".95"/>
<circle cx="26.5" cy="12.6" r="1.5" fill="#f3e5c0" opacity=".9"/>
</svg>`;

/** 松林剪影（村口那排树）。编码成 data URI 当背景平铺。 */
function forestUri(fill) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 100' preserveAspectRatio='none'>`
    + `<path d='M0,100 L0,72 L14,46 L28,72 L44,28 L62,72 L78,52 L94,72 L110,34 L130,72 L148,58 L166,72 `
    + `L184,22 L206,72 L226,48 L246,72 L264,38 L286,72 L304,56 L322,72 L342,30 L364,72 L384,50 L404,72 `
    + `L424,40 L446,72 L466,58 L486,72 L506,26 L530,72 L550,50 L570,72 L588,44 L600,66 L600,100 Z' `
    + `fill='${fill}'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** 这一套的全部作用域（狼人杀之外的页面永远不受影响）。 */
const S = 'body[data-kind="werewolf"]';

export function werewolfTheme() {
  return `
/* 整页入夜：变量换掉，配合 base.js 的 body{background:var(--bg)} 生效 */
${S}{
  --bg:#070a12; --surface:rgba(20,26,42,.82); --surface-2:rgba(32,40,62,.66);
  --line:rgba(212,175,55,.2); --text:#e9e4d8; --muted:#8b93a8; --chip:rgba(255,255,255,.08);
  --accent:#d4af37; --accent-ink:#1a1206;
  --accent-soft:rgba(212,175,55,.42); --accent-wash:rgba(212,175,55,.1);
  --danger:#d4574a; --gold:#d4af37;
  --radius:10px; --radius-lg:16px;
  color-scheme:dark;
}
/* 页面比视口高时 html 会露出来，一起压暗 */
html:has(${S}){background:#070a12}

/* ── 夜空：血月 + 散星（一层搞定，省 DOM） ── */
${S}::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
  background:
    radial-gradient(circle at 50% -150px,
      rgba(246,214,152,.55) 0px, rgba(214,158,66,.4) 90px,
      rgba(168,66,32,.28) 165px, rgba(120,30,18,.12) 235px, transparent 320px),
    radial-gradient(1.6px 1.6px at 11% 9%, rgba(255,255,255,.55), transparent),
    radial-gradient(1.2px 1.2px at 24% 16%, rgba(255,255,255,.4), transparent),
    radial-gradient(1.8px 1.8px at 68% 7%, rgba(255,255,255,.5), transparent),
    radial-gradient(1.1px 1.1px at 82% 19%, rgba(255,255,255,.35), transparent),
    radial-gradient(1.4px 1.4px at 91% 11%, rgba(255,255,255,.42), transparent),
    radial-gradient(1px 1px at 38% 5%, rgba(255,255,255,.3), transparent),
    radial-gradient(1.3px 1.3px at 55% 13%, rgba(255,255,255,.32), transparent);
  background-repeat:no-repeat}

/* ── 前景：村口松林 + 底部雾气 ── */
${S}::after{content:"";position:fixed;left:0;right:0;bottom:0;height:170px;z-index:0;
  pointer-events:none;opacity:.85;
  background-image:${forestUri('#0b1020')},linear-gradient(to top,rgba(8,12,22,.92),transparent);
  background-size:900px 100%,100% 100%;
  background-repeat:repeat-x,no-repeat;
  background-position:bottom,bottom}

/* 卡片：暗玻璃 + 金边 —— 有"羊皮纸压在夜里"的那点质感 */
${S} .panel{backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);
  box-shadow:0 18px 44px -26px rgba(0,0,0,.9),inset 0 1px 0 rgba(255,255,255,.045)}
${S} .panel-title::before{content:"";width:3px;height:15px;border-radius:2px;background:var(--accent);flex:none;
  box-shadow:0 0 10px rgba(212,175,55,.8)}

/* 标题：衬线 + 金色微光，整页的"仪式感"就在这一处 */
${S} .brand{font-family:Georgia,"Songti SC","Times New Roman",serif;letter-spacing:.06em;
  color:#ecdcae;text-shadow:0 0 26px rgba(212,175,55,.4),0 2px 4px rgba(0,0,0,.6)}
${S} .tag.on{background:rgba(212,175,55,.12)}

/* 类型卡：悬停时像被月光扫过 */
${S} .pick{backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
${S} .pick:hover{border-color:var(--accent);box-shadow:0 18px 40px -20px rgba(212,175,55,.45)}
${S} .pick.primary::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  background:radial-gradient(circle at 84% 12%,rgba(212,175,55,.14),transparent 60%)}

/* 规则卡：开启 = 亮起来。这是这一页最关键的一处交互反馈 */
${S} .rule{backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
${S} .rule[aria-pressed=true]{
  border-color:var(--accent);
  background:linear-gradient(158deg,rgba(212,175,55,.17),rgba(212,175,55,.04));
  box-shadow:0 0 0 1px rgba(212,175,55,.45),0 0 22px -6px rgba(212,175,55,.6)}
${S} .rule[aria-pressed=true] .r-name{color:#f2e2b4}
${S} .rule .r-state{border:1px solid transparent}
${S} .rule[aria-pressed=true] .r-state{background:rgba(212,175,55,.9);color:#1a1206;
  box-shadow:0 0 12px -2px rgba(212,175,55,.9)}

/* 名额卡：选中时金边，被挡下的名额保持灰暗 */
${S} .roster-item{backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
${S} .roster-item.on{border-color:var(--accent);background:rgba(212,175,55,.12);
  box-shadow:inset 0 0 22px -10px rgba(212,175,55,.7)}

/* 开始按钮：血色 + 金边，整页唯一一处红 */
${S} .btn-primary{background:linear-gradient(140deg,#b3271c,#8e1a14 60%,#6d1310);
  border-color:rgba(212,175,55,.55);color:#f7e9c9;
  box-shadow:0 0 26px -8px rgba(192,57,43,.85),inset 0 1px 0 rgba(255,255,255,.12);
  font-family:Georgia,"Songti SC",serif;letter-spacing:.08em}
${S} .btn-primary:hover{filter:brightness(1.14);color:#fff3d8;
  box-shadow:0 0 34px -6px rgba(212,175,55,.7)}

/* 步进器 / 滑块：金色轨迹 */
${S} input[type=range]::-webkit-slider-thumb{box-shadow:0 0 0 1px var(--accent),0 0 14px rgba(212,175,55,.75)}
${S} .slider-val{color:#e8cf8a}
${S} .seat{background:rgba(255,255,255,.07)}
${S} .roster-item.on .seat{background:var(--accent);color:#1a1206}

/* 结果块：羊皮纸味道的一点暖 */
${S} .result{background:linear-gradient(160deg,rgba(212,175,55,.13),rgba(212,175,55,.04));
  border-color:rgba(212,175,55,.4)}
${S} .result h3{font-family:Georgia,"Songti SC",serif;color:#f0dfae;letter-spacing:.04em}
`;
}
