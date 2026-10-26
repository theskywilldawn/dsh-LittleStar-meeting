/**
 * 星辰会议室 —— 找到"会场实况网页"该用哪个地址打开。
 *
 * 麻烦在哪：插件跑在 Host 进程里，Host 自己起了个 HTTP 服务供 GUI 用，但
 * `ctx.webServer` 只暴露"注册路由"，**不暴露端口**。而我们要 `cmd /c start <url>`
 * 把页面弹到浏览器里，就必须知道端口。
 *
 * 所以这里不猜、也不硬编码，而是**多路探测 + 实测确认**：
 *   1. 能拿到的服务对象上直接读（不同版本挂的位置不一样，都试一遍）；
 *   2. 环境变量 / 进程参数（DSH 自己启动时的 --port）；
 *   3. 配置里手填的端口（`webPort`，0 = 自动）；
 *   4. 最近一次到达本插件路由的请求的 Host 头（有人访问过页面就一定准）；
 *   5. 最后才用 19387 兜底。
 *
 * **每一路都要真的请求一次 `/api/config` 并确认返回 ok**，才认为这个端口是对的 ——
 * 宁可打不开窗口，也不能给用户弹一个错的页面出来。
 */
import { request } from 'node:http';

/** 从各种可能的位置读一个端口号。 */
function candidatePorts({ webServer, recentHost, configured }) {
  const out = [];
  const push = (value) => {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0 && n < 65536 && !out.includes(n)) out.push(n);
  };

  // 1) 服务对象自己（不同 DSH 版本挂在不同字段上，全都摸一遍）
  for (const holder of [webServer, webServer?.server, webServer?.httpServer, webServer?.app]) {
    if (!holder) continue;
    try {
      const addr = holder.address?.();
      if (addr && typeof addr === 'object') push(addr.port);
    } catch { /* 不是 server 对象，跳过 */ }
    push(holder.port);
  }

  // 2) 环境变量
  push(process.env.DSH_WEB_PORT);
  push(process.env.DSH_PORT);
  push(process.env.PORT);

  // 3) 进程参数：--port 19387 / --port=19387
  const argv = Array.isArray(process.argv) ? process.argv : [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    const eq = /^--(?:web-)?port=(\d+)$/.exec(arg);
    if (eq) { push(eq[1]); continue; }
    if (/^--(?:web-)?port$/.test(arg)) push(argv[i + 1]);
  }

  // 4) 请求里见过的 Host（最可信）
  if (recentHost) {
    const m = /:(\d{1,5})$/.exec(String(recentHost).trim());
    if (m) push(m[1]);
  }

  // 5) 配置里手填的
  push(configured);

  // 6) 最后兜底
  push(19387);
  return out;
}

/** 对一个端口发一次真实请求，确认它就是我们这个插件的 Host。 */
function probe(port, route, timeoutMs = 900) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    let req;
    try {
      req = request({
        host: '127.0.0.1',
        port,
        path: `${route}/api/ping`,
        method: 'GET',
        timeout: timeoutMs,
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; if (body.length > 4096) req.destroy(); });
        res.on('end', () => {
          try { finish(res.statusCode === 200 && JSON.parse(body)?.ok === true); }
          catch { finish(false); }
        });
      });
    } catch { finish(false); return; }
    req.on('timeout', () => { req.destroy(); finish(false); });
    req.on('error', () => finish(false));
    req.end();
  });
}

/**
 * 找出会场实况页面的完整地址；一个都不通就返回 null（调用方据此回退到控制台窗口）。
 * @returns {Promise<{url: string, port: number}|null>}
 */
export async function resolveLiveUrl({ webServer, route, roomId, recentHost, configured }) {
  for (const port of candidatePorts({ webServer, recentHost, configured })) {
    // eslint-disable-next-line no-await-in-loop -- 逐个端口试，本来就要串行
    if (await probe(port, route)) {
      return { url: `http://127.0.0.1:${port}${route}/live/${encodeURIComponent(roomId)}`, port };
    }
  }
  return null;
}
