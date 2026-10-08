/**
 * 零依赖 CDP 客户端。
 *
 * 只用 Node 22+ 的内置 `fetch` 与 `WebSocket`，不依赖 playwright / puppeteer，
 * 因此不需要下载 Chromium，也不需要 npm install。
 * 直接驱动系统已安装的 Chrome / Edge。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANDIDATES = [
  process.env.DSH_CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
    : null,
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** 找到可用的浏览器可执行文件。 */
export function findBrowser(explicit) {
  const list = explicit ? [explicit, ...CANDIDATES] : CANDIDATES;
  for (const p of list) if (p && fs.existsSync(p)) return p;
  throw new Error('找不到 Chrome/Edge，可在配置里设置 browser.chromePath');
}

/** 读取某个端口的 CDP 版本信息；没有在监听就返回 null。 */
export async function cdpVersion(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 极简 CDP 连接：请求/响应配对 + 事件收集。 */
export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${msg.method || 'cdp'}: ${msg.error.message || JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      }
    };
  }

  static async connect(wsUrl, { timeoutMs = 20000 } = {}) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), timeoutMs);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`CDP WebSocket 连接失败: ${e?.message || e}`)); };
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId, { timeoutMs = 60000 } = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/**
 * 确保有一个带调试端口的浏览器可用。
 * 已经有人在监听该端口就直接复用（支持「附加到我自己的调试 Chrome」）。
 */
export async function ensureBrowser({
  port = 9333,
  profileDir,
  headless = false,
  chromePath,
  timeoutMs = 40000,
} = {}) {
  const existing = await cdpVersion(port);
  if (existing) {
    const cdp = await Cdp.connect(existing.webSocketDebuggerUrl);
    return { launched: false, reused: true, child: null, version: existing, port, cdp };
  }

  const exe = findBrowser(chromePath);
  if (!profileDir) throw new Error('ensureBrowser 需要 profileDir');
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--remote-allow-origins=*',
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ];

  const child = spawn(exe, args, { stdio: 'ignore', windowsHide: false });
  child.on('error', () => { /* 由下面的轮询统一报错 */ });

  const deadline = Date.now() + timeoutMs;
  let version = null;
  while (Date.now() < deadline) {
    await sleep(300);
    version = await cdpVersion(port);
    if (version) break;
  }

  if (!version) {
    try { child.kill(); } catch { /* ignore */ }
    throw new Error(
      `浏览器没能在 ${timeoutMs}ms 内开放调试端口 ${port}。`
      + `\n常见原因：已有一个使用同一配置目录 (${profileDir}) 的 Chrome 在运行，`
      + '此时新进程只会去激活旧窗口而不会开启调试端口。'
      + '\n处理：完全退出该 Chrome（或换一个 browser.profileDir / port）后重试。',
    );
  }

  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  return { launched: true, reused: false, child, version, port, cdp };
}

/** 连接到一个已经确认可用的调试端口。 */
export async function connectBrowser(port) {
  const version = await cdpVersion(port);
  if (!version) throw new Error(`端口 ${port} 上没有可用的 CDP 服务`);
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  return { cdp, version };
}

/** 新开一个标签页并可选地导航到 url。 */
export async function openTab(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  if (url) await cdp.send('Page.navigate', { url }, sessionId);
  return { targetId, sessionId };
}

export async function closeTab(cdp, targetId) {
  try { await cdp.send('Target.closeTarget', { targetId }); } catch { /* ignore */ }
}

/** 在指定（或默认）执行上下文里求值，返回结构化结果。 */
export async function evalIn(cdp, sessionId, expression, contextId) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    ...(contextId !== undefined ? { contextId } : {}),
  }, sessionId);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description
      || r.exceptionDetails.text
      || JSON.stringify(r.exceptionDetails);
    throw new Error(`页面内执行失败: ${d}`);
  }
  return r.result ? r.result.value : undefined;
}

/** 等页面进入可交互状态，并额外留一点时间给前端框架渲染。 */
export async function waitForLoad(cdp, sessionId, { timeoutMs = 45000, settleMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await evalIn(cdp, sessionId, 'document.readyState');
      if (state === 'complete' || state === 'interactive') {
        await sleep(settleMs);
        return true;
      }
    } catch { /* 导航过程中会短暂失败 */ }
    await sleep(400);
  }
  return false;
}

/**
 * 按 URL 偏好重排 frame：命中 `preferUrl` 的排在最前，并标记 `preferred`。
 * 只做排序、不做过滤 —— 偏好写错（或页面改版）时仍会退回其余 frame，不会直接失效。
 */
function orderByPreference(contexts, preferUrl) {
  if (!preferUrl) return contexts;
  const hit = [];
  const rest = [];
  for (const c of contexts) {
    if ((c.frameUrl || '').includes(preferUrl)) hit.push({ ...c, preferred: true });
    else rest.push(c);
  }
  return [...hit, ...rest];
}

/**
 * 列出页面自身与所有 iframe 的可执行上下文。
 * 飞书项目 (Meego) 的插件页和北森 iTalent 都大量使用 iframe，所以这一步是必须的。
 *
 * - `frameTree` 覆盖同进程 iframe，用 isolated world 拿 universal access 绕过同源限制；
 * - `oopif` 覆盖独立进程 iframe（在 CDP 里表现为单独 target）。
 *
 * @param options.preferUrl 命中的 frame 优先尝试（仅排序，不过滤）。
 */
export async function frameContexts(cdp, sessionId, { preferUrl } = {}) {
  const out = [];

  try {
    const { frameTree } = await cdp.send('Page.getFrameTree', {}, sessionId);
    const frames = [];
    const walk = (node) => {
      frames.push(node.frame);
      (node.childFrames || []).forEach(walk);
    };
    walk(frameTree);

    for (const frame of frames) {
      let contextId;
      try {
        const world = await cdp.send('Page.createIsolatedWorld', {
          frameId: frame.id,
          worldName: 'dsh-workhours',
          // 注意：CDP 协议里这个字段名确实是拼错的 "Univeral"
          grantUniveralAccess: true,
        }, sessionId);
        contextId = world.executionContextId;
      } catch { /* frame 可能在导航中销毁 */ }
      out.push({ via: 'frameTree', frameUrl: frame.url, sessionId, contextId });
    }
  } catch { /* getFrameTree 不可用时忽略 */ }

  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    for (const t of targetInfos.filter((x) => x.type === 'iframe')) {
      try {
        const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        await cdp.send('Runtime.enable', {}, sid);
        out.push({ via: 'oopif', frameUrl: t.url, sessionId: sid, contextId: undefined });
      } catch { /* 忽略无法附加的 iframe */ }
    }
  } catch { /* getTargets 不可用时忽略 */ }

  return orderByPreference(out, preferUrl);
}

/**
 * 等某个 URL 命中的 frame 出现。
 * 飞书项目 (Meego) 的自定义插件页跑在跨域 iframe 里（projectplg.feishupkg.com），
 * 由宿主异步挂载，晚于外层 readyState=complete，所以写入前必须先等它出现。
 *
 * @returns `{ waited, matched, timedOut?, seen? }`；`matched` 为命中的 frame URL。
 */
export async function waitForFrame(cdp, sessionId, urlIncludes, { timeoutMs = 15000, pollMs = 500 } = {}) {
  if (!urlIncludes) return { waited: false, matched: null };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let contexts = [];
    try { contexts = await frameContexts(cdp, sessionId); } catch { contexts = []; }
    const hit = contexts.find((c) => (c.frameUrl || '').includes(urlIncludes));
    if (hit) return { waited: true, matched: hit.frameUrl };
    if (Date.now() >= deadline) {
      return {
        waited: true,
        matched: null,
        timedOut: true,
        seen: contexts.map((c) => c.frameUrl).filter(Boolean).slice(0, 10),
      };
    }
    await sleep(pollMs);
  }
}

/** 在页面与所有 iframe 里跑同一个表达式，收集每帧的结果。 */
export async function collectFrames(cdp, sessionId, expression, options = {}) {
  const contexts = await frameContexts(cdp, sessionId, options);
  const results = [];
  for (const ctx of contexts) {
    try {
      const value = await evalIn(cdp, ctx.sessionId, expression, ctx.contextId);
      results.push({ via: ctx.via, frameUrl: ctx.frameUrl, preferred: ctx.preferred === true, value });
    } catch (e) {
      results.push({ via: ctx.via, frameUrl: ctx.frameUrl, preferred: ctx.preferred === true, error: String(e?.message || e) });
    }
  }
  return results;
}

/**
 * 依次在每个 frame 里执行 `expression`，返回第一个「命中」的结果。
 * 表达式需返回 null/undefined 表示未命中，返回对象表示命中。
 * 用于「在哪个 iframe 里找到并操作了目标元素」这类动作。
 */
export async function actInFrames(cdp, sessionId, expression, options = {}) {
  const contexts = await frameContexts(cdp, sessionId, options);
  const attempts = [];
  for (const ctx of contexts) {
    let value;
    try {
      value = await evalIn(cdp, ctx.sessionId, expression, ctx.contextId);
    } catch (e) {
      attempts.push({ frameUrl: ctx.frameUrl, via: ctx.via, preferred: ctx.preferred === true, error: String(e?.message || e) });
      continue;
    }
    if (value !== null && value !== undefined) {
      return { hit: true, frameUrl: ctx.frameUrl, via: ctx.via, preferred: ctx.preferred === true, value, attempts };
    }
    attempts.push({ frameUrl: ctx.frameUrl, via: ctx.via, preferred: ctx.preferred === true, missed: true });
  }
  return { hit: false, attempts };
}

/** 截图存盘。 */
export async function screenshot(cdp, sessionId, filePath) {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  }, sessionId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
  return filePath;
}