/**
 * 端到端测试：用本地 HTML 夹具模拟两个真实页面，跑通 driver 的 read / fill。
 *
 * 验证点：
 *  - 浏览器启动、CDP 连接、frame 遍历、结构提取、截图
 *  - 「出勤天数」不会被「应出勤天数」抢走（精确匹配优先）
 *  - 当前月份行的选取 + 小数天数
 *  - 工时 = 出勤天数 × 8
 *  - Meego 侧按可见文字「工时」就近定位输入框并写入
 *  - 跨站 iframe（模拟飞书项目自定义插件页）：帧偏好、等待 iframe 出现、只写进目标帧
 *  - 提交按钮的文字兜底
 *  - 定位失败时的自诊断（interactables / labelProbe）
 *  - 插件契约：注册、参数 schema、渲染、摘要（宿主 defineTool 由语义等价的 stub 顶替）
 *
 * 用法：node test/run-tests.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DRIVER = path.join(ROOT, 'lib', 'driver.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-test-'));
const MARKER = '__DSH_WORKHOURS_RESULT__';

const now = new Date();
const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const cur = ym(now);
const prevD = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const prev = ym(prevD);

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` -> ${JSON.stringify(detail)}` : ''}`); }
};

/* ---------------------------------------------------------------- 夹具 */

// 故意包含「应出勤天数」列，用来验证精确匹配优先
const attendanceHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>我的月报</title></head>
<body>
  <h1>我的月报</h1>
  <div class="toolbar"><span>统计周期</span></div>
  <table id="monthly">
    <thead>
      <tr><th>月份</th><th>应出勤天数</th><th>出勤天数</th><th>请假天数</th><th>加班天数</th></tr>
    </thead>
    <tbody>
      <tr><td>${prev}</td><td>22</td><td>20</td><td>2</td><td>0</td></tr>
      <tr><td>${cur}</td><td>21</td><td>21.5</td><td>0</td><td>0.5</td></tr>
    </tbody>
  </table>
</body></html>`;

const meegoHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>工时填报</title></head>
<body>
  <div class="panel">
    <h2>工时填报</h2>
    <div class="field"><span class="lbl">项目</span><input type="text" id="proj" value="示例项目"></div>
    <div class="field"><span class="lbl">出勤天数</span><input type="text" id="days" value=""></div>
    <div class="field"><span class="lbl">工时</span><input type="number" id="hours" value=""></div>
    <button id="submit">提交</button>
    <div class="other"><span>备注</span><input type="text" id="note" value=""></div>
  </div>
</body></html>`;

const attFile = path.join(TMP, 'attendance.html');
const meegoFile = path.join(TMP, 'meego.html');
fs.writeFileSync(attFile, attendanceHtml, 'utf8');
fs.writeFileSync(meegoFile, meegoHtml, 'utf8');

const configFile = path.join(TMP, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({
  attendance: { url: pathToFileURL(attFile).href, label: '出勤天数', valueSelector: null, decimals: 1 },
  meego: { url: pathToFileURL(meegoFile).href, label: '工时', inputSelector: null, submit: false, settleMs: 400 },
  rule: { hoursPerDay: 8 },
  browser: { port: 9444, headless: true, profileDir: path.join(TMP, 'profile'), keepOpen: false },
  probe: { outDir: path.join(TMP, 'probe'), waitForEnter: false },
}, null, 2), 'utf8');

console.log(`fixtures -> ${TMP}`);
console.log(`current month = ${cur}, previous = ${prev}\n`);

/* ---------------------------------------------------------------- 运行 */

function runDriver(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DRIVER, ...args], {
      cwd: TMP,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      const idx = out.lastIndexOf(MARKER);
      if (idx < 0) { reject(new Error(`no result marker (exit ${code})\nstdout:\n${out}\nstderr:\n${err}`)); return; }
      const json = out.slice(idx + MARKER.length).trim();
      try { resolve({ result: JSON.parse(json), code, stderr: err }); }
      catch (e) { reject(new Error(`bad JSON: ${json.slice(0, 400)}\nstderr:\n${err}`)); }
    });
  });
}

const base = ['--config', configFile, '--workspace', TMP];

/* ---------------------------------------------------------------- 1. probe */

console.log('[1] probe');
{
  const { result } = await runDriver(['probe', ...base, '--no-wait']);
  check('probe ok', result.ok === true, result);
  const att = result.pages?.find((p) => p.name === 'attendance');
  check('attendance 抓到表格', (att?.frames || []).some((f) => f.tables >= 1), att?.frames);
  check('attendance 命中关键词', (att?.frames || []).some((f) => f.keywordHits >= 1), att?.frames);
  check('截图已生成', fs.existsSync(path.join(TMP, 'probe', 'attendance.png')));
  check('结构 JSON 已生成', fs.existsSync(path.join(TMP, 'probe', 'attendance.inventory.json')));
  check('HTML 已生成', fs.existsSync(path.join(TMP, 'probe', 'meego.html')));
}

/* ---------------------------------------------------------------- 2. read */

console.log('\n[2] read（应取当前月 21.5，而不是上月 20，也不是「应出勤天数」21）');
{
  const { result } = await runDriver(['read', ...base]);
  check('read ok', result.ok === true, result);
  check('days = 21.5', result.days === 21.5, result);
  check('hours = 172', result.hours === 172, result);
  check('选中当前月行', result.matchedRow === 'current-month', result);
  check('来源是表格', result.source === 'table', result);
  check('精确匹配生效', result.candidates?.length > 0 && result.candidates.every((c) => c.cellText !== '21'), result.candidates);
}

/* ---------------------------------------------------------------- 3. fill 预览 */

console.log('\n[3] fill 预览（默认不写）');
{
  const { result } = await runDriver(['fill', ...base]);
  check('fill 预览 ok', result.ok === true, result);
  check('mode = preview', result.mode === 'preview', result);
  check('wouldWrite.value = 172', result.wouldWrite?.value === 172, result);
}

/* ---------------------------------------------------------------- 4. fill 提交 */

console.log('\n[4] fill --commit（真正写入本地夹具）');
{
  const { result } = await runDriver(['fill', ...base, '--commit']);
  check('fill commit ok', result.ok === true, result);
  check('mode = commit', result.mode === 'commit', result);
  check('定位方式 = label-scope', result.wrote?.how === 'label-scope', result.wrote);
  check('写入后值 = 172', result.wrote?.after === '172', result.wrote);
  check('确认写入生效', result.wrote?.wrote === true, result.wrote);
  check('没写错到别的框', result.wrote?.path?.includes('hours') || result.wrote?.id === 'hours', result.wrote);
}

/* ------------------------------------------------- 5. 跨站 iframe + 帧偏好 + 提交兜底 */

console.log('\n[5] 跨站 iframe：只应写进偏好帧，且按文字点到提交');

const parentHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>工时（外层）</title></head>
<body>
  <div class="panel">
    <span class="lbl">工时</span><input type="number" id="decoy" value="">
  </div>
</body></html>`;

const pluginHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>工时插件页</title></head>
<body>
  <div class="panel">
    <h2>工时资源管理</h2>
    <div class="field"><span class="lbl">工时</span><input type="number" id="hours" value=""></div>
    <button id="submit">提交</button>
  </div>
</body></html>`;

const missHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>无目标页</title></head>
<body>
  <div class="panel">
    <span class="lbl">备注</span><input type="text" id="note" value="" placeholder="备注">
    <button id="submit">提交</button>
  </div>
</body></html>`;

/** 极小静态服务器：绑到所有 IPv4 环回地址，便于用 127.0.0.1 / 127.0.0.2 造出跨站 iframe。 */
function startServer(routes) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let buf = '';
      sock.on('data', (d) => {
        buf += d;
        const line = buf.split('\r\n')[0] || '';
        const url = line.split(' ')[1] || '/';
        const body = routes[url];
        if (body === undefined) {
          sock.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
          return;
        }
        const bytes = Buffer.byteLength(body);
        sock.end(`HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${bytes}\r\nConnection: close\r\n\r\n${body}`);
      });
      sock.on('error', () => { /* 忽略客户端中断 */ });
    });
    srv.listen(0, '0.0.0.0', () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}

{
  const routes = {
    '/parent.html': parentHtml.replace('<div class="panel">',
      '<div class="panel"><iframe sandbox="allow-scripts allow-same-origin allow-forms" src="__PLUGIN__" style="width:600px;height:300px"></iframe>'),
    '/plugin.html': pluginHtml,
    '/miss.html': missHtml,
  };
  // 占位符要等拿到端口才能定，所以先起服务、再补上 iframe 地址
  const srv = await startServer(routes);
  routes['/parent.html'] = routes['/parent.html'].replace('__PLUGIN__', `http://127.0.0.2:${srv.port}/plugin.html`);

  const iframeConfig = path.join(TMP, 'config-iframe.json');
  fs.writeFileSync(iframeConfig, JSON.stringify({
    attendance: { url: pathToFileURL(attFile).href, label: '出勤天数', valueSelector: null, decimals: 1 },
    meego: {
      url: `http://127.0.0.1:${srv.port}/parent.html`,
      label: '工时',
      inputSelector: null,
      submitSelector: null,
      submit: true,
      settleMs: 400,
      frameUrlIncludes: '127.0.0.2',
      frameWaitMs: 8000,
    },
    rule: { hoursPerDay: 8 },
    browser: { port: 9445, headless: true, profileDir: path.join(TMP, 'profile2'), keepOpen: false },
    probe: { outDir: path.join(TMP, 'probe2'), waitForEnter: false },
  }, null, 2), 'utf8');

  const iframeBase = ['--config', iframeConfig, '--workspace', TMP];

  {
    const { result } = await runDriver(['fill', ...iframeBase, '--days', '20', '--commit']);
    check('跨站 iframe 写入成功', result.ok === true, result);
    check('等到了偏好帧', result.frameWait?.matched?.includes('127.0.0.2') === true, result.frameWait);
    check('写进了 iframe 而不是外层诱饵', result.wrote?.frameUrl?.includes('127.0.0.2') === true, result.wrote);
    check('目标元素是 iframe 里的 #hours', result.wrote?.path?.includes('hours') === true, result.wrote);
    check('外层诱饵未被写', result.wrote?.path?.includes('decoy') !== true, result.wrote);
    check('提交兜底按文字命中', result.wrote?.submitHow === 'text', result.wrote);
    check('提交按钮文字 = 提交', result.wrote?.submitText === '提交', result.wrote);
    check('submitted = true', result.wrote?.submitted === true, result.wrote);
  }

  {
    const missConfig = path.join(TMP, 'config-miss.json');
    fs.writeFileSync(missConfig, JSON.stringify({
      attendance: { url: pathToFileURL(attFile).href, label: '出勤天数', valueSelector: null, decimals: 1 },
      meego: {
        url: `http://127.0.0.1:${srv.port}/miss.html`,
        label: '工时', inputSelector: null, submitSelector: null, submit: false, settleMs: 400,
      },
      rule: { hoursPerDay: 8 },
      browser: { port: 9446, headless: true, profileDir: path.join(TMP, 'profile3'), keepOpen: false },
      probe: { outDir: path.join(TMP, 'probe3'), waitForEnter: false },
    }, null, 2), 'utf8');

    const { result } = await runDriver(['fill', '--config', missConfig, '--workspace', TMP, '--days', '20', '--commit']);
    check('定位失败时 ok = false', result.ok === false, result);
    check('失败时给出 interactables', Array.isArray(result.interactables) && result.interactables.length > 0, result.interactables);
    const frame = (result.interactables || []).find((f) => (f.editables || []).length > 0);
    check('interactables 列出可编辑元素', Boolean(frame), result.interactables);
    check('interactables 带 cssPath', frame?.editables?.[0]?.path?.includes('note') === true, frame?.editables);
    check('interactables 列出按钮', (frame?.buttons || []).some((b) => b.text === '提交'), frame?.buttons);
  }

  srv.close();
}

/* ------------------------------------------------- 6. 插件契约冒烟（宿主 defineTool 由 stub 顶替） */

console.log('\n[6] 插件契约：注册 / 参数 schema / 渲染 / 摘要');
{
  const dest = path.join(TMP, 'host-contract', 'feishu-workhours');
  fs.cpSync(ROOT, dest, {
    recursive: true,
    filter: (src) => !/(^|[\\/])(node_modules|\.dsh-workhours)([\\/]|$)/.test(src),
  });

  // 宿主在真实运行时里会把 @deepseek-ai/dsh-tools 路由到 runtime 包（见 package.json 的 peerDependencies）。
  // 这里放一个语义等价的最小实现，用来离线校验插件的契约用法。
  const stubDir = path.join(dest, 'node_modules', '@deepseek-ai', 'dsh-tools');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-tools', version: '0.2.0-rc.2', type: 'module', main: 'index.js',
  }, null, 2));
  fs.writeFileSync(path.join(stubDir, 'index.js'), `
export function defineTool(options) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(options.parameters || {})) {
    properties[key] = {
      type: spec.type,
      ...(spec.enum ? { enum: spec.enum } : {}),
      ...(spec.description ? { description: spec.description } : {}),
    };
    if (spec.required === true) required.push(key);
  }
  const parameters = { type: 'object', properties, ...(required.length ? { required } : {}) };
  const validate = (args) => {
    const out = [];
    for (const key of required) if (args?.[key] === undefined) out.push('/' + key + ': required');
    for (const [key, spec] of Object.entries(properties)) {
      const value = args?.[key];
      if (value === undefined) continue;
      if (spec.type === 'string' && typeof value !== 'string') out.push('/' + key + ': expected string');
      if (spec.type === 'number' && typeof value !== 'number') out.push('/' + key + ': expected number');
      if (spec.type === 'boolean' && typeof value !== 'boolean') out.push('/' + key + ': expected boolean');
      if (spec.enum && !spec.enum.includes(value)) out.push('/' + key + ': not in enum');
    }
    return out;
  };
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: { schema: options.output.schema, render: options.output.render },
    presentCall: options.presentCall,
    __validate: validate,
    async execute(args, exec) {
      const violations = validate(args);
      if (violations.length > 0) throw new Error('invalid arguments: ' + violations.join('; '));
      return options.execute(args, exec);
    },
  };
}
`, 'utf8');

  const mod = await import(pathToFileURL(path.join(dest, 'index.js')).href);
  check('导出 name', mod.name === 'feishu-workhours', mod.name);
  check('导出 inject = [tools]', JSON.stringify(mod.inject) === '["tools"]', mod.inject);
  check('导出 apply', typeof mod.apply === 'function');

  let registered = null;
  let command = null;
  let commandDeps = null;
  mod.apply({
    tools: { register: (def) => { registered = def; } },
    inject: (deps, callback) => {
      commandDeps = deps;
      callback({ commands: { register: (def) => { command = def; } } });
    },
  });
  check('注册且仅注册 workhours', registered?.name === 'workhours', registered?.name);
  check('commands 走可选注入', JSON.stringify(commandDeps) === '["commands"]', commandDeps);
  check('注册 /workhours 命令', command?.name === 'workhours', command?.name);
  check('命令声明 input hint',
    typeof command?.input?.hint === 'string' && command.input.hint.includes('commit'), command?.input);
  check('命令描述非空', typeof command?.description === 'string' && command.description.length > 0, command?.description);
  check('命令 handler 是函数', typeof command?.handler === 'function');

  check('无输入默认 read', mod.parseCommandInput('').action === 'read', mod.parseCommandInput(''));
  check('解析 commit/submit/days',
    JSON.stringify(mod.parseCommandInput(' fill commit submit days=21.5 ')) ===
      JSON.stringify({ action: 'fill', commit: true, submit: true, days: 21.5 }),
    mod.parseCommandInput(' fill commit submit days=21.5 '));
  check('未知动作被拒', typeof mod.parseCommandInput('bogus').error === 'string', mod.parseCommandInput('bogus'));

  // 命令 handler 的接线：非法动作必须在启动 driver 之前就被挡下（这里不会 spawn node）。
  const rejected = await command.handler({
    agent: { session: { header: { cwd: TMP } } },
    rawInput: 'bogus',
  });
  check('命令 handler 拒绝未知动作',
    rejected?.kind === 'error' && rejected.text.includes('未知动作'), rejected);
  check('action 必填', JSON.stringify(registered?.parameters?.required) === '["action"]', registered?.parameters);
  check('action 枚举正确', JSON.stringify(registered?.parameters?.properties?.action?.enum) === '["probe","read","fill"]', registered?.parameters?.properties?.action);
  check('参数根是 object', registered?.parameters?.type === 'object', registered?.parameters?.type);
  check('输出 schema 必填 ok/action/summary',
    JSON.stringify(registered?.output?.schema?.properties && Object.keys(registered.output.schema.properties)) === '["ok","action","summary","detail"]',
    registered?.output?.schema);

  check('非法 action 被拒', (registered?.__validate({ action: 'bogus' }) || []).length > 0);
  check('合法 action 通过', (registered?.__validate({ action: 'read' }) || []).length === 0);
  check('缺 action 被拒', (registered?.__validate({}) || []).length > 0);

  const rendered = registered?.output?.render({ action: 'read' }, { ok: true, action: 'read', summary: '摘要正文' });
  check('render 返回文本块', rendered?.[0]?.type === 'text' && rendered[0].text.includes('摘要正文'), rendered);

  // 摘要里必须带上可直接抄进配置的 cssPath
  const missSummary = mod.summarize('fill', {
    ok: false,
    mode: 'commit',
    hint: '没能在 Meego 页面定位到工时输入框。',
    interactables: [{
      frameUrl: 'https://projectplg.feishupkg.com/x', preferred: true,
      editables: [{ path: 'div > input#hours', tag: 'input', type: 'number', scopeText: '工时' }],
      buttons: [{ path: 'div > button#submit', tag: 'button', text: '提交' }],
    }],
  });
  check('失败摘要含 cssPath', missSummary.includes('div > input#hours'), missSummary);
  check('失败摘要含按钮', missSummary.includes('提交'), missSummary);
  check('失败摘要标注偏好帧', missSummary.includes('[偏好]'), missSummary);

  const readMiss = mod.summarize('read', {
    ok: false,
    hint: '没找到「出勤天数」。',
    probes: [{ frameUrl: 'https://www.italent.cn/x', hits: [{ exact: true, text: '出勤天数', path: 'table > th.col' }] }],
  });
  check('read 失败摘要含标签候选', readMiss.includes('table > th.col'), readMiss);

  const okSummary = mod.summarize('fill', {
    ok: true, mode: 'commit', days: 21.5, hours: 172, hoursPerDay: 8,
    wrote: { how: 'label-scope', after: '172', submitted: true, submitHow: 'text', submitText: '提交' },
    frameWait: { waited: true, matched: 'https://projectplg.feishupkg.com/x' },
  });
  check('成功摘要含提交方式', okSummary.includes('按文字点中「提交」'), okSummary);
  check('成功摘要含帧定位', okSummary.includes('帧定位'), okSummary);
}

/* ------------------------------------------------- 7. 客户端 bundle 契约（左栏条目 + 主面板） */

console.log('\n[7] 客户端 bundle：左栏 sidebar.panellist / main 面板 / 字典 / 按钮命令');
{
  const clientSource = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');

  // 浏览器 bundle 只依赖 `window.__ModuleLoader__.load` 与 `require('react')`，
  // 这里把两者都顶替掉，就能在 Node 里跑它的注册逻辑。
  let entry = null;
  new Function('window', clientSource)({
    __ModuleLoader__: { load: (registered) => { entry = registered; } },
  });
  check('bundle id = 包名', entry?.id === '@local/feishu-workhours', entry?.id);
  check('bundle 只注册工厂', typeof entry?.factory === 'function');

  const fakeReact = {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props || {}), children: children.length > 1 ? children : children[0] },
    }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  };
  const exports_ = entry.factory((id) => {
    if (id === 'react') return fakeReact;
    throw new Error(`unexpected require: ${id}`);
  });

  check('client inject 含 slots/locale',
    JSON.stringify(exports_.inject) === '["slots","locale"]', exports_.inject);

  const dictionaries = new Map();
  const registrations = [];
  const applied = [];
  const injectDeps = [];
  const injectCallbacks = [];
  const fakeCtx = {
    effect: (fn, label) => { applied.push(label); return fn(); },
    locale: {
      register: (ns, dict) => { dictionaries.set(ns, dict); },
      bind: (ns) => (key) => (dictionaries.get(ns)?.zh ?? {})[key] ?? key,
    },
    slots: {
      inject: (owner, callback) => { registrations.push({ owner, callback }); },
      register: (options, component) => ({ options, component }),
    },
    get: () => undefined,
    inject: (deps, callback) => { injectDeps.push(deps); injectCallbacks.push(callback); },
  };
  exports_.apply(fakeCtx);

  // `remote.commands` 必须按需注入才允许访问（静态 inject 里放它会连条目一起消失）。
  check('按需注入 remote / remote.commands',
    JSON.stringify(injectDeps) === JSON.stringify([['remote', 'remote.commands']]), injectDeps);

  const dict = dictionaries.get('feishuWorkhours');
  const zhKeys = Object.keys(dict?.zh ?? {}).sort();
  check('注册 feishuWorkhours 字典', dict !== undefined && zhKeys.length > 0, zhKeys.length);
  check('en 键集与 zh 一致',
    JSON.stringify(Object.keys(dict?.en ?? {}).sort()) === JSON.stringify(zhKeys));

  const panelList = registrations.find((r) => r.owner === 'sidebar.panellist')?.callback();
  const mainPanel = registrations.find((r) => r.owner === 'main')?.callback();
  check('注册左栏 sidebar.panellist', panelList?.options?.name === 'sidebar.panellist', panelList?.options);
  check('左栏条目 id = feishu-workhours', panelList?.options?.id === 'feishu-workhours', panelList?.options?.id);
  check('左栏条目 label 走字典', panelList?.options?.label() === '工时填报', panelList?.options?.label());
  check('左栏条目有 order', typeof panelList?.options?.order === 'number', panelList?.options?.order);
  check('注册 main 主面板', mainPanel?.options?.name === 'main', mainPanel?.options);
  check('主面板 key 与左栏 id 相同（同一 id 寻址）',
    mainPanel?.options?.key === panelList?.options?.id, mainPanel?.options?.key);

  const icon = panelList.component({ size: 16, active: false });
  check('图标组件可渲染', icon?.type === 'svg' && icon.props.width === 16, icon?.type);

  const injected = mainPanel.options.inject();
  check('main 注入份额齐全',
    typeof injected.executeLine === 'function'
    && typeof injected.getSessionSource === 'function'
    && typeof injected.startSession === 'function',
    Object.keys(injected));

  // 真实的 executeLine：通道缺席时给人话，通道就绪后把命令行原样交给 remote.commands。
  const noChannel = await injected.executeLine('/workhours read', 'session-1');
  check('通道缺席时给出可读提示', noChannel.ok === false && noChannel.text.length > 0, noChannel);

  const channelCalls = [];
  const dispose = injectCallbacks[0]({
    remote: {
      commands: {
        execute: (sessionId, line, attachments) => {
          channelCalls.push({ sessionId, line, attachments });
          return Promise.resolve({ ok: true, value: { result: { kind: 'success', text: `ran ${line}` } } });
        },
      },
    },
  });
  const ran = await injected.executeLine('/workhours read', 'session-1');
  check('executeLine 走 remote.commands.execute',
    JSON.stringify(channelCalls) === JSON.stringify([
      { sessionId: 'session-1', line: '/workhours read', attachments: [] },
    ]), channelCalls);
  check('executeLine 展开 success 结果', ran.ok === true && ran.text === 'ran /workhours read', ran);

  const withoutSession = await injected.executeLine('/workhours read', undefined);
  check('executeLine 无会话时不发命令',
    withoutSession.ok === false && channelCalls.length === 1, withoutSession);

  if (typeof dispose === 'function') {
    dispose();
    const afterDispose = await injected.executeLine('/workhours read', 'session-1');
    check('通道释放后退化回提示',
      afterDispose.ok === false && channelCalls.length === 1, afterDispose);
  }

  const buttonsOf = (node) => {
    const out = [];
    const walk = (current) => {
      if (current === null || current === undefined || typeof current !== 'object') return;
      if (Array.isArray(current)) { for (const child of current) walk(child); return; }
      if (current.type === 'button') out.push(current);
      walk(current.props?.children);
    };
    walk(node);
    return out;
  };
  const inputOf = (node) => {
    let found;
    const walk = (current) => {
      if (found !== undefined || current === null || current === undefined || typeof current !== 'object') return;
      if (Array.isArray(current)) { for (const child of current) walk(child); return; }
      if (current.type === 'input') { found = current; return; }
      walk(current.props?.children);
    };
    walk(node);
    return found;
  };
  const labelOf = (button) => button.props.children;
  const findByLabel = (buttons, label) => buttons.find((b) => labelOf(b) === label);

  // 面板：把 slot 注入的份额换成可观察的桩（桩放在后面，覆盖真实注入），
  // 然后点按钮看它到底发出了哪条命令。
  const lines = [];
  const stubs = {
    t: (key) => dict.zh[key] ?? key,
    executeLine: (line, sessionId) => { lines.push([line, sessionId]); return Promise.resolve({ ok: true, text: 'ok' }); },
    getSessionSource: () => ({ getSnapshot: () => ({ key: 'session-1' }), subscribe: () => () => {} }),
    startSession: () => {},
  };
  const page = mainPanel.component({ ...injected, ...stubs });
  check('面板可渲染', page?.type === 'div' && page.props.className === 'fwh-page', page?.type);

  const buttons = buttonsOf(page);
  check('面板有 4 个动作按钮（有会话时）', buttons.length === 4, buttons.map(labelOf));
  const commitButton = findByLabel(buttons, '确认填报（写入 Meego）');
  const checkbox = inputOf(page);
  check('写入必须显式勾选确认', commitButton?.props?.disabled === true, commitButton?.props?.disabled);
  check('确认框是可绑定的 checkbox',
    checkbox?.props?.type === 'checkbox' && typeof checkbox.props.onChange === 'function', checkbox?.props?.type);

  for (const label of ['读取出勤天数', '预览填报（不写入）', '抓取页面结构']) {
    findByLabel(buttons, label)?.props?.onClick();
  }
  check('按钮发出只读/预览命令',
    JSON.stringify(lines) === JSON.stringify([
      ['/workhours read', 'session-1'],
      ['/workhours fill', 'session-1'],
      ['/workhours probe', 'session-1'],
    ]), lines);

  // 没有会话时：给出「新建会话」出口，并且写入保持禁用。
  const noSession = mainPanel.component({ ...injected, ...stubs, getSessionSource: () => undefined });
  const noSessionButtons = buttonsOf(noSession);
  check('无会话时给出新建会话出口',
    findByLabel(noSessionButtons, '新建会话') !== undefined, noSessionButtons.map(labelOf));
  check('无会话时写入保持禁用',
    findByLabel(noSessionButtons, '确认填报（写入 Meego）')?.props?.disabled === true);
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} CHECK(S) FAILED`}`);
console.log(`artifacts: ${TMP}`);
process.exit(failures === 0 ? 0 : 1);