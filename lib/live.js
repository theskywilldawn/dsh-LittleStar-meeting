/**
 * 星辰会议室 —— 会场实况（网页版）。
 *
 * 为什么要这个：控制台窗口（cmd）能证明"程序在跑"，但排版是真的差 ——
 * 中文宽度算不准、长段落不分栏、没有时间轴、看不出谁是谁。用户 2026-10-14 说
 * "改为弹出 web，样式就弄像 QQ 群那种样子"。
 *
 * 于是这里生成一张**只读的群聊页面**：
 *   · 主持人 —— 专属头像（蓝紫渐变 + 虎鲸尾巴）+ 金色「主持」徽标；
 *   · 参会成员 —— 默认头像（灰底 + 名字首字）+ 灰色「成员」徽标；
 *   · 每条发言一个气泡，名字在气泡上方，时间在右边；
 *   · 轮次之间插一条居中的分隔线；
 *   · 每 2 秒拉一次 /api/room/<id>，增量比对后重渲染（在底部就自动跟随滚动）。
 *
 * 页面本身不写任何东西，只是一个观察窗口：数据和它走的是同一个 JSON 路由。
 * 不引任何前端依赖，纯 HTML + CSS + 原生 JS。
 */

/** HTML 转义（服务端拼接用）。 */
function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 把值嵌进 `<script>` 里当 JSON 用。
 *
 * `JSON.stringify` 不转义 `<`，所以字符串里一旦出现 `</script>` 就会提前把脚本块
 * 关掉 —— 虽然房间号在路由那层已经被白名单卡死了，但这里是生成 HTML 的最后一环，
 * 顺手堵上，省得以后有人把别的字段也塞进来。
 */
function jsonForScript(value) {
  return (JSON.stringify(value) ?? 'null')
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** 主持人头像：内联 SVG，一只朝右的虎鲸尾巴 —— 一眼认得出是"星辰家"的主持人。 */
const HOST_AVATAR_SVG = `<svg viewBox="0 0 40 40" aria-hidden="true">
<defs><linearGradient id="hg" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#2f6df6"/><stop offset="1" stop-color="#7b5cf0"/>
</linearGradient></defs>
<circle cx="20" cy="20" r="20" fill="url(#hg)"/>
<path d="M11 24c3.2 0 5.6-1.6 7.4-3.6 1.5-1.7 3.4-3.4 6-3.9-.5 1.5-.4 3 .3 4.3 1 1.9 3 3 5.3 3.1-1.2 1.1-3 2.2-5.2 2.2-1.6 0-3-.5-4.2-1.3-1.7 1.9-4 3.2-7 3.2-.9 0-1.7-.1-2.4-.4.5-.5 1-1.1 1.3-1.7-.5-.6-.9-1.2-1.5-1.9Z" fill="#fff" opacity=".95"/>
<circle cx="26.5" cy="12.6" r="1.5" fill="#fff" opacity=".9"/>
<circle cx="31.5" cy="17.5" r="1" fill="#fff" opacity=".55"/>
<circle cx="30.5" cy="22.5" r=".8" fill="#fff" opacity=".4"/>
</svg>`;

export function renderLiveHtml({ route, roomId }) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>星辰会议室 · 会场实况</title><style>
  :root{
    color-scheme:light dark;
    --bg:#f2f3f5; --panel:#fff; --line:rgba(128,128,128,.22);
    --text:#1a1a1a; --muted:#8a8f99; --bubble:#fff; --bubble-host:#eaf1ff;
    --host:#2f6df6; --badge-host:#c9922a; --badge-member:#8a8f99;
  }
  @media (prefers-color-scheme:dark){
    :root{--bg:#16181d;--panel:#1e2128;--line:rgba(255,255,255,.12);--text:#e8eaee;
      --muted:#8b919b;--bubble:#242832;--bubble-host:#1d2a45;}
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--text);
    font:14px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;}
  .wrap{max-width:860px;margin:0 auto;height:100%;display:flex;flex-direction:column}
  header{position:sticky;top:0;z-index:5;background:var(--panel);border-bottom:1px solid var(--line);
    padding:12px 18px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  header h1{font-size:16px;margin:0;font-weight:600;flex:1;min-width:200px}
  .pill{font-size:12px;padding:2px 9px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
  .pill.live{color:#2e9e5b;border-color:rgba(46,158,91,.45)}
  .pill.closed{color:var(--muted)}
  .sub{font-size:12px;color:var(--muted);padding:8px 18px 0;display:flex;gap:10px;flex-wrap:wrap}
  #feed{flex:1;overflow-y:auto;padding:14px 18px 40px;scroll-behavior:auto}
  .msg{display:flex;gap:10px;margin:14px 0;align-items:flex-start}
  .avatar{width:40px;height:40px;flex:none;border-radius:50%;overflow:hidden;
    display:flex;align-items:center;justify-content:center;font-weight:600;font-size:16px;
    color:#fff;background:linear-gradient(135deg,#9aa3b2,#7c8494);user-select:none}
  .avatar svg{width:100%;height:100%;display:block}
  .body{min-width:0;flex:1}
  .line{display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap}
  .name{font-size:13px;color:var(--muted);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .badge{font-size:11px;line-height:16px;padding:0 6px;border-radius:4px;
    border:1px solid currentColor;font-weight:500}
  .badge.host{color:var(--badge-host)}
  .badge.member{color:var(--badge-member)}
  .time{font-size:11px;color:var(--muted);margin-left:auto;flex:none}
  .bubble{background:var(--bubble);border:1px solid var(--line);border-radius:4px 12px 12px 12px;
    padding:9px 13px;white-space:pre-wrap;word-break:break-word;max-width:100%}
  .msg.host .bubble{background:var(--bubble-host)}
  .flag{font-size:12px;color:#c0392b;margin-left:6px}
  .sys{text-align:center;margin:22px 0 10px}
  .sys span{font-size:12px;color:var(--muted);background:var(--panel);
    border:1px solid var(--line);border-radius:999px;padding:2px 12px}
  .empty{color:var(--muted);text-align:center;padding:60px 0}
  footer{font-size:12px;color:var(--muted);text-align:center;padding:10px 18px 18px}
</style></head><body>
<div class="wrap">
  <header>
    <h1 id="topic">星辰会议室</h1>
    <span class="pill" id="status">加载中…</span>
    <span class="pill" id="round">—</span>
  </header>
  <div class="sub" id="sub"></div>
  <div id="feed"><div class="empty">加载中…</div></div>
  <footer>只读页面 · 每 2 秒自动刷新</footer>
</div>
<script>
const ROUTE=${jsonForScript(route)};
const ROOM=${jsonForScript(roomId)};
const ZONE='Asia/Shanghai';
const HOST_SVG=${jsonForScript(HOST_AVATAR_SVG)};
const STATUS={open:'已开房',live:'进行中',closed:'已结束'};

function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function fmt(t){try{return new Date(t).toLocaleTimeString('zh-CN',
  {timeZone:ZONE,hour12:false,hour:'2-digit',minute:'2-digit'})}catch(e){return ''}}
function initials(name){
  const s=String(name||'?').trim();
  return s.length>0?s.slice(0,1):'?';
}

let lastKey='';

function render(room){
  const feed=document.getElementById('feed');
  document.getElementById('topic').textContent=room.topic||'（无议题）';
  const st=document.getElementById('status');
  st.textContent=STATUS[room.status]||room.status;
  st.className='pill'+(room.status==='live'?' live':(room.status==='closed'?' closed':''));
  document.getElementById('round').textContent=
    '第 '+room.round+' 轮 / 共 '+room.roundLimit+' 轮（已完成 '+room.completedRounds+'）';

  const hostName=room.host&&(room.host.title||room.host.sessionId)||'主持人';
  const members=(room.members||[]).map(function(m){return (m.title||m.sessionId)+'（第'+m.order+'位）'});
  document.getElementById('sub').textContent=
    '房间 '+room.id+' · 主持人 '+hostName+' · 成员 '+members.join('、');

  const items=room.transcript||[];
  // 内容指纹：只有真的变了才重画，避免每 2 秒把阅读位置抖掉
  const key=items.length+'|'+room.round+'|'+room.status+'|'+
    (items.length?items[items.length-1].at:0);
  if(key===lastKey) return;
  const atBottom=feed.scrollHeight-feed.scrollTop-feed.clientHeight<80;
  lastKey=key;

  if(items.length===0){feed.innerHTML='<div class="empty">还没有人发言。</div>';return;}

  let html='';
  let shownRound=null;
  items.forEach(function(t){
    if(shownRound===null||t.round!==shownRound){
      shownRound=t.round;
      html+='<div class="sys"><span>第 '+t.round+' 轮</span></div>';
    }
    const isHost=t.kind==='host';
    const name=isHost?hostName:(t.name||'成员');
    const badge=isHost?'<span class="badge host">主持</span>'
                      :'<span class="badge member">成员</span>';
    const avatar=isHost?'<div class="avatar">'+HOST_SVG+'</div>'
                       :'<div class="avatar">'+esc(initials(name))+'</div>';
    const flag=t.timedOut?'<span class="flag">超时，只收到部分</span>'
               :(t.error?'<span class="flag">异常：'+esc(t.error)+'</span>':'');
    const who=isHost?'':(' · 第 '+t.seat+' 位');
    html+='<div class="msg'+(isHost?' host':'')+'">'+avatar
      +'<div class="body"><div class="line"><span class="name">'+esc(name)+'</span>'
      +badge+flag+'<span class="time">'+fmt(t.at)+who+'</span></div>'
      +'<div class="bubble">'+esc(t.text||'（无内容）')+'</div></div></div>';
  });
  if(room.status==='closed'){
    html+='<div class="sys"><span>会议已结束</span></div>';
  }
  feed.innerHTML=html;
  if(atBottom||feed.scrollTop===0) feed.scrollTop=feed.scrollHeight;
}

async function tick(){
  try{
    const res=await fetch(ROUTE+'/api/room/'+encodeURIComponent(ROOM),{cache:'no-store'})
      .then(function(r){return r.json()});
    if(res&&res.ok&&res.room) render(res.room);
    else document.getElementById('status').textContent='读取失败';
  }catch(e){
    document.getElementById('status').textContent='连接中断，重试中…';
  }
}
tick();
setInterval(tick,2000);
</script>
</body></html>`;
}
