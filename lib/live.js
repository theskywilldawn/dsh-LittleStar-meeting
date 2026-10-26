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

export function renderLiveHtml({ route, roomId, fontScale = 1 }) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>星辰会议室 · 会场实况</title><style>
  html{font-size:calc(16px * ${fontScale});}
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
    font:1rem/1.65 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;}
  .wrap{max-width:860px;margin:0 auto;height:100%;display:flex;flex-direction:column}
  header{position:sticky;top:0;z-index:5;background:var(--panel);border-bottom:1px solid var(--line);
    padding:12px 18px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  header h1{font-size:1.1429rem;margin:0;font-weight:600;flex:1;min-width:200px}
  .pill{font-size:0.8571rem;padding:2px 9px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
  .pill.live{color:#2e9e5b;border-color:rgba(46,158,91,.45)}
  .pill.closed{color:var(--muted)}
  .sub{font-size:0.8571rem;color:var(--muted);padding:8px 18px 0;display:flex;gap:10px;flex-wrap:wrap}
  #feed{flex:1;overflow-y:auto;padding:14px 18px 40px;scroll-behavior:auto}
  .msg{display:flex;gap:10px;margin:14px 0;align-items:flex-start}
  .avatar{width:40px;height:40px;flex:none;border-radius:50%;overflow:hidden;
    display:flex;align-items:center;justify-content:center;font-weight:600;font-size:1.1429rem;
    color:#fff;background:linear-gradient(135deg,#9aa3b2,#7c8494);user-select:none}
  .avatar svg{width:100%;height:100%;display:block}
  .body{min-width:0;flex:1}
  .line{display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap}
  .name{font-size:0.9286rem;color:var(--muted);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .badge{font-size:0.7857rem;line-height:16px;padding:0 6px;border-radius:4px;
    border:1px solid currentColor;font-weight:500}
  .badge.host{color:var(--badge-host)}
  .badge.member{color:var(--badge-member)}
  .time{font-size:0.7857rem;color:var(--muted);margin-left:auto;flex:none}
  .bubble{background:var(--bubble);border:1px solid var(--line);border-radius:4px 12px 12px 12px;
    font-size:1.0625rem;line-height:1.7;
    padding:9px 13px;white-space:pre-wrap;word-break:break-word;max-width:100%}
  .msg.host .bubble{background:var(--bubble-host)}
  .flag{font-size:0.8571rem;color:#c0392b;margin-left:6px}
  .sys{text-align:center;margin:22px 0 10px}
  .sys span{font-size:0.8571rem;color:var(--muted);background:var(--panel);
    border:1px solid var(--line);border-radius:999px;padding:2px 12px}
  .empty{color:var(--muted);text-align:center;padding:60px 0}
  footer{font-size:0.8571rem;color:var(--muted);padding:10px 18px 18px}
  .note{text-align:center}
  .hidden{display:none !important}
  /* 人类席位的发言框 —— 只有这一局有"你"的时候才出现 */
  .saybar{display:flex;gap:8px;align-items:flex-end;margin-bottom:10px}
  /* 「这条给谁看」—— 全场 or 只发主持人（2026-10-19 哥哥要求） */
  .saybar select{height:46px;border-radius:10px;border:1px solid var(--line);background:var(--panel);
    color:var(--text);font:0.9286rem/1 inherit;padding:0 8px;outline:none;cursor:pointer;flex:none}
  .saybar select:focus{border-color:var(--host)}
  .saybar select:disabled{opacity:.5;cursor:not-allowed}
  .saybar textarea{flex:1;min-height:46px;max-height:130px;resize:vertical;padding:10px 12px;
    border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--text);
    font:1rem/1.5 inherit;outline:none}
  .saybar textarea:focus{border-color:var(--host);box-shadow:0 0 0 3px rgba(47,109,246,.16)}
  .saybar button{padding:0 20px;height:46px;border-radius:10px;border:0;background:var(--host);color:#fff;
    font:600 1rem/1 inherit;cursor:pointer;white-space:nowrap}
  .saybar button:disabled{opacity:.5;cursor:not-allowed}
  /* 人类席位的说明条 —— 必须把"你不用等轮次"写在明面上。
     2026-10-17 那次就是没说清：他在等轮次，而人类席位永远不在轮转里，
     局两分钟跑完，他的感觉是"我还没说，会就结束了"。 */
  .sayhint{font-size:0.8929rem;line-height:1.65;color:var(--text);margin-bottom:10px;padding:9px 12px;
    border-radius:9px;background:rgba(47,109,246,.08);border:1px solid rgba(47,109,246,.22)}
  .sayhint b{color:var(--host);font-size:0.9286rem}
  .sayhint.done{background:rgba(128,128,128,.08);border-color:rgba(128,128,128,.22);color:var(--muted)}
  /* 轮到你发言 —— 要一眼看得见，不然又变成"我是不是漏了什么" */
  .sayhint.myturn{background:rgba(255,184,77,.12);border-color:rgba(255,184,77,.55);animation:pulse 1.8s ease-in-out infinite}
  .sayhint.myturn b{color:#ffb84d}
  @keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,184,77,.28)}50%{box-shadow:0 0 0 5px rgba(255,184,77,0)}}
  /* 私聊标记：跟公开发言必须一眼分得开（2026-10-19 哥哥说分不清哪句是全场都能看到的） */
  .badge.priv{background:rgba(255,184,77,.16);color:#ffb84d;border:1px solid rgba(255,184,77,.45)}
  .msg.priv .bubble{border-color:rgba(255,184,77,.42);background:rgba(255,184,77,.05)}
  /* 你自己说的话：靠右一点、浅蓝底，一眼分得出 */
  .msg.mine{flex-direction:row-reverse}
  .msg.mine .bubble{background:var(--bubble-host)}
  .msg.mine .line{flex-direction:row-reverse}
  .msg.mine .name{color:var(--host)}
</style></head><body>
<div class="wrap">
  <header>
    <h1 id="topic">星辰会议室</h1>
    <span class="pill" id="status">加载中…</span>
    <span class="pill" id="round">—</span>
  </header>
  <div class="sub" id="sub"></div>
  <div id="feed"><div class="empty">加载中…</div></div>
  <footer>
    <div class="sayhint hidden" id="sayhint">你是场上的第 <b id="sayseat">?</b> 位 —— <b>随时说话都算数</b></div>
    <div class="saybar hidden" id="saybar">
      <select id="sayto" title="这条给谁看">
        <option value="public">全场</option>
        <option value="host">只发主持人</option>
      </select>
      <textarea id="saytext" placeholder="轮到你就说，没轮到也能插话 —— 主持人下一次投递会带上。Ctrl+Enter 发送"></textarea>
      <button id="saybtn" type="button">说</button>
    </div>
    <div class="note">会场实况 · 每 2 秒自动刷新</div>
  </footer>
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

  // 人类席位：发言框**常显**，会结束了也只是变灰说明，不"悄悄收起来"。
  // 上次就是这么翻车的 —— 框跟着会一起消失，看起来像页面坏了。
  const humanSeat=(room.members||[]).find(function(m){return m.human===true});
  const closed=room.status==='closed';
  const bar=document.getElementById('saybar');
  const hint=document.getElementById('sayhint');
  if(bar) bar.classList.toggle('hidden', !humanSeat);
  if(hint) hint.classList.toggle('hidden', !humanSeat);
  if(humanSeat){
    const box=document.getElementById('saytext');
    const sbtn=document.getElementById('saybtn');
    const sel=document.getElementById('sayto');
    const seatEl=document.getElementById('sayseat');
    if(seatEl && seatEl.id==='sayseat') seatEl.textContent=humanSeat.order;
    // 主持人正在等这位真人开口（room.waitingFor 由 speakAsHuman 挂上）
    const myTurn=!closed && room.waitingFor && room.waitingFor.seat===humanSeat.order;
    if(box){
      box.disabled=closed;
      box.placeholder=closed?'这一场已经结束了'
        :(myTurn?'轮到你发言了 —— 说完大家就往下走'
                :'轮到你时就说，没轮到也能插话。Ctrl+Enter 发送');
    }
    if(sbtn) sbtn.disabled=closed;
    if(sel) sel.disabled=closed;
    if(hint){
      const want=closed?'closed':(myTurn?'turn':'idle');
      // 倒计时每 2 秒会变，所以 turn 状态下每次都要重画
      if(hint.dataset.mode!==want || want==='turn'){
        hint.dataset.mode=want;
        hint.classList.toggle('done', want==='closed');
        hint.classList.toggle('myturn', want==='turn');
        if(want==='closed'){
          hint.textContent='会议已经结束 —— 这一局你的发言位到此为止';
        }else if(want==='turn'){
          const wf=room.waitingFor||{};
          const left=wf.until?Math.max(0,Math.round((wf.until-Date.now())/1000)):0;
          const isWhisper=wf.kind==='whisper';
          hint.innerHTML='🎯 <b>'+(isWhisper?'主持人在等你回话':'现在轮到你')+'</b> · 还剩 <b>'+left+'</b> 秒'
            +(isWhisper?'（选「只发主持人」再发）':'，说完大家就继续');
        }else{
          hint.innerHTML='你是场上的第 <b>'+humanSeat.order+'</b> 位 —— '
            +'<b>随时说话都算数</b>，轮到你时会提醒你';
        }
      }
    }
  }

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
    // 系统消息（出局 / 角色 / 中止）单独一行居中 —— 别让它冒充"某个成员在说话"
    if(t.kind==='system'){
      html+='<div class="sys"><span>'+esc(t.text||'')+'</span></div>';
      return;
    }
    const isHost=t.kind==='host';
    const isMine=t.kind==='user';
    // 私聊：法官单独发给你、或者你「只发主持人」说的那些。
    // 必须在气泡上标出来 —— 2026-10-19 哥哥就是分不清哪句是全场都能看到的。
    const isPriv=t.channel==='private'||t.humanPrivate===true;
    // 上警发言这种「一个人说、全场听」的记录，channel 也是 private（走的是 whisper + audience），
    // 但 audience 不止一个人 —— 别给它贴「只给你看」，那会让人以为这话只有自己听见
    // （2026-10-19 哥哥对着满屏「🔒 私聊 · 只给你看」以为整局没听见别人说话）。
    const forAll=isPriv&&Array.isArray(t.audience)&&t.audience.length>1;
    const name=isHost?hostName:(t.name||'成员');
    const badge=isHost?(isPriv?(forAll?'<span class="badge host">📢 全场可见</span>'
                                          :'<span class="badge host priv">🔒 私聊 · 只给你看</span>')
                             :'<span class="badge host">主持</span>')
                :(isMine?(isPriv?'<span class="badge member priv">🔒 只发给了主持人</span>'
                               :'<span class="badge member">你</span>')
                        :'<span class="badge member">成员</span>');
    const avatar=isHost?'<div class="avatar">'+HOST_SVG+'</div>'
                       :'<div class="avatar">'+esc(initials(name))+'</div>';
    const flag=t.timedOut?'<span class="flag">超时，只收到部分</span>'
               :(t.error?'<span class="flag">异常：'+esc(t.error)+'</span>':'');
    // 私聊回答这类记录的 seat 是 null —— 别印成「第 null 位」
    const who=(isHost||t.seat==null)?'':(' · 第 '+t.seat+' 位');
    html+='<div class="msg'+(isHost?' host':'')+(isMine?' mine':'')+(isPriv?' priv':'')+'">'+avatar
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
// 说话：POST 到 /api/room/<id>/say。
//   · 默认对**全场**说（kind:'user'）。正好轮到你时，后台会把它记成这一轮的发言并推进轮次。
//   · 选「只发主持人」时是悄悄话（2026-10-19 加）—— 别的席位看不到，主持人下一轮会看到。
async function say(){
  const box=document.getElementById('saytext');
  const btn=document.getElementById('saybtn');
  const sel=document.getElementById('sayto');
  const text=(box.value||'').trim();
  if(!text) return;
  btn.disabled=true;
  try{
    const res=await fetch(ROUTE+'/api/room/'+encodeURIComponent(ROOM)+'/say',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text:text,to:(sel&&sel.value)||'public'})
    }).then(function(r){return r.json()});
    if(res&&res.ok){ box.value=''; lastKey=''; await tick(); }
    else alert((res&&res.error)||'发送失败');
  }catch(e){
    alert('发送失败：'+(e&&e.message?e.message:String(e)));
  }finally{
    btn.disabled=false;
  }
}
(function bindSay(){
  const btn=document.getElementById('saybtn');
  const box=document.getElementById('saytext');
  if(!btn||!box) return;
  btn.addEventListener('click',say);
  box.addEventListener('keydown',function(e){
    if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){ e.preventDefault(); say(); }
  });
})();

tick();
setInterval(tick,2000);
</script>
</body></html>`;
}
