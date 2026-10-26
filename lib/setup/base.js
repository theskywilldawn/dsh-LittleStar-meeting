/**
 * 星辰会议室 · 会议准备页 —— 骨架样式。
 *
 * 这里只写**结构**（布局、控件形状、间距），颜色一律走 CSS 变量，
 * 由各个主题文件覆盖。这样两套 UI（普通会议 / 狼人杀）共用一套 DOM，
 * 却看不出是同一个页面 —— 差的是皮，不是骨。
 *
 * 不引任何前端依赖：纯 CSS + 原生 JS，跟 `lib/live.js` 一个路子。
 */

export function baseCss() {
  return `
*,*::before,*::after{box-sizing:border-box}
html{font-size:calc(17px * var(--fs-scale,1))}
html,body{margin:0;padding:0;min-height:100%}
body{
  background:var(--bg);color:var(--text);
  font:1rem/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.page{max-width:960px;margin:0 auto;padding:32px 20px 80px;position:relative;z-index:1}

/* ── 顶部 ───────────────────────────────────────────── */
.head{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:28px}
.brand{font-size:1.4667rem;font-weight:700;letter-spacing:.02em;margin:0;display:flex;align-items:center;gap:10px}
.brand .mark{width:30px;height:30px;flex:none;display:block}
.head .spacer{flex:1}
.tag{font-size:0.8rem;padding:3px 10px;border-radius:999px;
  border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.tag.on{color:var(--accent);border-color:var(--accent-soft);background:var(--accent-wash)}

/* ── 步骤条 ─────────────────────────────────────────── */
.steps{display:flex;gap:8px;align-items:center;margin-bottom:24px;font-size:0.8667rem;color:var(--muted);flex-wrap:wrap}
.steps b{color:var(--accent);font-weight:600}
.steps .sep{opacity:.5}

/* ── 类型选择（第一步） ─────────────────────────────── */
.picker{display:grid;grid-template-columns:1fr 1fr;gap:18px}
@media (max-width:680px){.picker{grid-template-columns:1fr}}
.pick{
  text-align:left;cursor:pointer;padding:26px 22px;border-radius:var(--radius-lg);
  background:var(--surface);border:1.5px solid var(--line);color:inherit;font:inherit;
  transition:border-color .18s,transform .18s,box-shadow .18s;position:relative;overflow:hidden;
}
.pick:hover{border-color:var(--accent);transform:translateY(-2px)}
.pick .icon{font-size:2.2667rem;line-height:1;display:block;margin-bottom:12px}
.pick .name{font-size:1.2667rem;font-weight:600;margin:0 0 6px}
.pick .desc{font-size:0.9rem;color:var(--muted);margin:0}
.pick .go{font-size:0.8667rem;color:var(--accent);margin-top:14px;display:block;font-weight:600}

/* ── 面板 ───────────────────────────────────────────── */
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-lg);
  padding:22px;margin-bottom:18px}
.panel-title{font-size:1rem;font-weight:600;margin:0 0 4px;display:flex;align-items:center;gap:8px}
.panel-note{font-size:0.8333rem;color:var(--muted);margin:0 0 18px}

.field{margin-bottom:20px}
.field:last-child{margin-bottom:0}
.field-label{display:block;font-size:0.9rem;font-weight:600;margin-bottom:9px}
.field-label .opt{font-weight:400;color:var(--muted);font-size:0.8333rem;margin-left:6px}
.field-hint{font-size:0.8333rem;color:var(--muted);margin-top:7px}
/* 「我也参加」下面那个身份选择（勾了才出现） */
.myrole{margin-top:14px;padding-top:14px;border-top:1px dashed var(--line)}
.myrole select{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);
  background:var(--panel);color:var(--text);font:0.9333rem/1.4 inherit;outline:none;cursor:pointer}
.myrole select:focus{border-color:var(--accent)}

/* 步进器 */
.stepper{display:inline-flex;align-items:center;gap:0;border:1px solid var(--line);
  border-radius:10px;overflow:hidden;background:var(--surface-2)}
.stepper button{width:42px;height:42px;border:0;background:transparent;color:var(--text);
  font-size:1.3333rem;cursor:pointer;line-height:1;transition:background .15s}
.stepper button:hover:not(:disabled){background:var(--accent-wash);color:var(--accent)}
.stepper button:disabled{opacity:.3;cursor:not-allowed}
.stepper .val{min-width:56px;text-align:center;font:600 1.1333rem/1 ui-monospace,Consolas,monospace;
  padding:0 6px;font-variant-numeric:tabular-nums}

/* 滑块 */
.slider-row{display:flex;align-items:center;gap:14px}
input[type=range]{flex:1;-webkit-appearance:none;appearance:none;height:5px;border-radius:99px;
  background:var(--line);outline:none}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:19px;height:19px;border-radius:50%;
  background:var(--accent);cursor:pointer;border:3px solid var(--surface);box-shadow:0 0 0 1px var(--accent)}
input[type=range]::-moz-range-thumb{width:15px;height:15px;border-radius:50%;background:var(--accent);
  cursor:pointer;border:3px solid var(--surface)}
.slider-val{font:600 1rem/1 ui-monospace,Consolas,monospace;min-width:78px;text-align:right;
  font-variant-numeric:tabular-nums;color:var(--accent)}

/* 文本输入 */
.text-input{width:100%;padding:11px 13px;border-radius:10px;border:1px solid var(--line);
  background:var(--surface-2);color:var(--text);font:inherit;font-size:0.9667rem}
.text-input::placeholder{color:var(--muted);opacity:.75}
.text-input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-wash)}

/* 数字选择条（狼人杀人数用） */
.numbar{display:flex;gap:8px;flex-wrap:wrap}
.numbar button{min-width:44px;height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--line);
  background:var(--surface-2);color:var(--text);font:600 1rem/1 ui-monospace,Consolas,monospace;
  cursor:pointer;transition:all .15s}
.numbar button:hover{border-color:var(--accent)}
.numbar button[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}

/* ── 参会名单 ───────────────────────────────────────── */
.roster{display:flex;flex-direction:column;gap:8px;max-height:340px;overflow-y:auto;padding-right:4px}
.roster-item{display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:11px;
  border:1.5px solid var(--line);background:var(--surface-2);cursor:pointer;transition:all .15s}
.roster-item:hover{border-color:var(--accent)}
.roster-item.on{border-color:var(--accent);background:var(--accent-wash);
  box-shadow:inset 4px 0 0 var(--accent)}
.roster-item.blocked{opacity:.5;cursor:not-allowed;border-style:dashed}
.seat{width:34px;height:34px;flex:none;border-radius:10px;display:flex;align-items:center;justify-content:center;
  font:700 1.2rem/1 ui-monospace,Consolas,monospace;background:var(--chip);color:var(--muted);
  transition:transform .16s,box-shadow .16s,background .16s,color .16s}
/* 选中态：实心亮块 + 光环 + 轻微放大 —— 以前只是一个 26px 的小色块，扫一眼看不出选了谁 */
.roster-item.on .seat{background:var(--accent);color:var(--accent-ink);
  box-shadow:0 0 0 3px var(--accent-wash),0 4px 14px rgba(0,0,0,.22);transform:scale(1.06)}
.roster-main{min-width:0;flex:1}
.roster-name{font-size:0.9333rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roster-meta{font-size:0.8rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roster-flag{font-size:0.7667rem;padding:2px 8px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.roster-flag.host{color:var(--gold,#c9922a)}
.roster-flag.no{color:var(--danger)}
.radio-dot{width:18px;height:18px;flex:none;border-radius:50%;border:2px solid var(--line);position:relative}
.roster-item.hostpick .radio-dot{border-color:var(--gold,#c9922a)}
.roster-item.hostpick .radio-dot::after{content:"";position:absolute;inset:3px;border-radius:50%;background:var(--gold,#c9922a)}

/* ── 规则开关（卡牌式） ─────────────────────────────── */
.rules{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:10px}
.rule{position:relative;text-align:left;padding:14px;border-radius:12px;cursor:pointer;font:inherit;
  background:var(--surface-2);border:1.5px solid var(--line);color:inherit;transition:all .18s}
.rule:hover{border-color:var(--accent)}
.rule .r-ic{font-size:1.3333rem;line-height:1;display:block;margin-bottom:8px}
.rule .r-name{font-size:0.9rem;font-weight:600;display:block;margin-bottom:3px}
.rule .r-desc{font-size:0.7667rem;color:var(--muted);display:block;line-height:1.45}
.rule .r-state{position:absolute;top:12px;right:12px;font:600 0.7333rem/1 ui-monospace,Consolas,monospace;
  padding:3px 7px;border-radius:999px;background:var(--chip);color:var(--muted)}
/* ON / OFF 由 CSS 出，JS 只翻 aria-pressed —— 少一处状态要同步 */
.rule .r-state::after{content:"OFF"}
.rule[aria-pressed=true] .r-state::after{content:"ON"}
.rule[aria-pressed=true]{border-color:var(--accent);background:var(--accent-wash)}
.rule[aria-pressed=true] .r-state{background:var(--accent);color:var(--accent-ink)}

/* ── 底部动作 ───────────────────────────────────────── */
.actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:26px;
  padding-top:22px;border-top:1px solid var(--line)}
.actions .spacer{flex:1}
.btn{padding:12px 22px;border-radius:11px;border:1px solid var(--line);background:var(--surface-2);
  color:var(--text);font:600 0.9667rem/1 inherit;cursor:pointer;transition:all .16s;display:inline-flex;
  align-items:center;gap:8px}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn-primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);
  padding:13px 30px;font-size:1rem}
.btn-primary:hover{filter:brightness(1.08);color:var(--accent-ink)}
.btn:disabled{opacity:.45;cursor:not-allowed;filter:none}
.btn-ghost{background:transparent}

/* ── 结果 / 提示 ────────────────────────────────────── */
.result{display:none;margin-top:20px;padding:20px;border-radius:14px;
  border:1px solid var(--accent-soft);background:var(--accent-wash)}
.result.show{display:block}
.result h3{margin:0 0 8px;font-size:1.0667rem}
.result p{margin:0 0 6px;font-size:0.9rem;color:var(--muted);word-break:break-all}
.result .btn{margin-top:12px}
.toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%) translateY(20px);
  background:var(--surface);border:1px solid var(--danger);color:var(--danger);
  padding:11px 20px;border-radius:11px;font-size:0.9rem;opacity:0;pointer-events:none;
  transition:all .25s;z-index:50;max-width:90vw}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.hidden{display:none !important}
.empty{padding:26px;text-align:center;color:var(--muted);font-size:0.9rem}
`;
}
