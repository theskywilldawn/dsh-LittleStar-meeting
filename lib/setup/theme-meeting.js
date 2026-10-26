/**
 * 星辰会议室 · 会议准备页 —— 「普通会议」主题：蓝白科技简约。
 *
 * **这是默认主题**：类型选择屏、以及选了「普通会议」之后的配置屏，都走它。
 *
 * ⚠️ 关键约定（2026-10-16 踩过的坑，别再犯）：两套主题会在**同一个页面**里
 * 同时注入，所以每一套的**变量与装饰都必须限定作用域** ——
 *   · 这一套：`:root` 出变量 + `body:not([data-kind="werewolf"])` 出装饰与组件；
 *   · 狼人杀那套：`body[data-kind="werewolf"]`。
 * 早先两边都写裸的 `:root`，后注入的狼人杀把蓝白整个覆盖掉了 ——
 * 结果"普通会议"页也是暗的。作用域就是这两套皮唯一的边界。
 *
 * 取向：会议室是干活的，所以留白多、边框细、颜色冷、没有多余动效；
 * 唯一的"科技感"来自那层几乎看不见的网格和顶栏渐变。
 */

/** 虎鲸尾巴标识 —— 跟会场实况页的主持人头像同一只，一眼认得出是星辰家。 */
export const BRAND_MARK = `<svg class="mark" viewBox="0 0 40 40" aria-hidden="true">
<defs><linearGradient id="bm" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#2563eb"/><stop offset="1" stop-color="#22d3ee"/>
</linearGradient></defs>
<circle cx="20" cy="20" r="20" fill="url(#bm)"/>
<path d="M11 24c3.2 0 5.6-1.6 7.4-3.6 1.5-1.7 3.4-3.4 6-3.9-.5 1.5-.4 3 .3 4.3 1 1.9 3 3 5.3 3.1-1.2 1.1-3 2.2-5.2 2.2-1.6 0-3-.5-4.2-1.3-1.7 1.9-4 3.2-7 3.2-.9 0-1.7-.1-2.4-.4.5-.5 1-1.1 1.3-1.7-.5-.6-.9-1.2-1.5-1.9Z" fill="#fff" opacity=".95"/>
<circle cx="26.5" cy="12.6" r="1.5" fill="#fff" opacity=".9"/>
<circle cx="31.5" cy="17.5" r="1" fill="#fff" opacity=".55"/>
</svg>`;

/** 这一套作用域的选择器（狼人杀那套是 `body[data-kind="werewolf"]`）。 */
const S = 'body:not([data-kind="werewolf"])';

export function meetingTheme() {
  return `
:root{
  --bg:#eff4fb; --surface:#ffffff; --surface-2:#f6f9fd; --line:#dae3f1;
  --text:#0e1c2e; --muted:#6a7d95; --chip:#e7eefa;
  --accent:#2563eb; --accent-ink:#ffffff;
  --accent-soft:rgba(37,99,235,.36); --accent-wash:rgba(37,99,235,.075);
  --danger:#d64545; --gold:#c9922a;
  --radius:10px; --radius-lg:16px;
  color-scheme:light;
}

/* 顶部渐变线：整页唯一的高饱和色块 */
${S}::after{content:"";position:fixed;top:0;left:0;right:0;height:3px;z-index:10;
  background:linear-gradient(90deg,#2563eb,#4f8ef7 45%,#22d3ee)}

/* 极细网格：只在页面上半部分显形，往下淡出 —— 有"图纸"的味道，但不抢内容 */
${S}::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
  background-image:
    linear-gradient(rgba(37,99,235,.05) 1px,transparent 1px),
    linear-gradient(90deg,rgba(37,99,235,.05) 1px,transparent 1px);
  background-size:36px 36px;
  -webkit-mask-image:radial-gradient(ellipse 95% 62% at 50% 0%,#000 25%,transparent 100%);
  mask-image:radial-gradient(ellipse 95% 62% at 50% 0%,#000 25%,transparent 100%)}

${S} .panel{box-shadow:0 1px 2px rgba(16,40,80,.04),0 10px 28px -16px rgba(16,40,80,.18)}
${S} .pick{box-shadow:0 1px 2px rgba(16,40,80,.04)}
${S} .pick:hover{box-shadow:0 12px 30px -14px rgba(37,99,235,.4)}
${S} .pick.primary::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  background:linear-gradient(135deg,rgba(37,99,235,.06),transparent 55%)}

/* 数字一律等宽 + 表格数字，行列对得齐 */
${S} .brand{letter-spacing:-.01em}
${S} .stepper .val,${S} .slider-val,${S} .numbar button{font-variant-numeric:tabular-nums}
${S} .btn-primary{box-shadow:0 8px 20px -10px rgba(37,99,235,.75)}
${S} .btn-primary:hover{box-shadow:0 10px 26px -10px rgba(37,99,235,.85)}
${S} .panel-title::before{content:"";width:3px;height:15px;border-radius:2px;background:var(--accent);flex:none}
`;
}
