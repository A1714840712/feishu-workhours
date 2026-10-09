#!/usr/bin/env node
/**
 * 工时自动化驱动（零依赖，Node 22+）。
 *
 * 三个子命令：
 *   probe  打开两个页面，把 DOM 结构 / 截图落盘，用于确定选择器（首次必做）
 *   read   读取 iTalent「我的月报」里的出勤天数
 *   fill   读取出勤天数 → 换算工时 → 写入 Meego（默认只预览，--commit 才真写）
 *
 * 设计要点：
 * - 复用同一个人浏览器配置目录（profileDir），登录一次后 Cookie 长期有效，
 *   所以**不存储任何账号密码**。
 * - 进度信息写 stderr，最终结果以 __DSH_WORKHOURS_RESULT__ 标记写 stdout，
 *   便于插件端稳定解析。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  ensureBrowser, openTab, closeTab, findTab, waitForLoad, screenshot,
  collectFrames, waitForFrame, sleep, evalIn, clickAt, frameContexts,
} from './cdp.mjs';
import { INVENTORY_EXPR, HTML_EXPR, labelProbeExpr } from './extract.mjs';

const RESULT_MARKER = '__DSH_WORKHOURS_RESULT__';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const log = (...a) => process.stderr.write(`${a.join(' ')}\n`);

/* ------------------------------------------------------------------ 参数与配置 */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(a);
  }
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function loadConfig(configPath, workspace) {
  const defaults = readJson(path.join(HERE, '..', 'config.default.json')) || {};
  // 配置查找顺序：显式 --config → <workspace>/.dsh-workhours/config.json → <workspace>/config.json
  const candidates = [
    configPath,
    path.join(workspace, '.dsh-workhours', 'config.json'),
    path.join(workspace, 'config.json'),
  ].filter(Boolean);
  let user = null;
  let configFrom = null;
  for (const c of candidates) {
    const j = readJson(c);
    if (j) { user = j; configFrom = c; break; }
  }
  const merged = {
    ...defaults,
    ...(user || {}),
    attendance: { ...defaults.attendance, ...(user?.attendance || {}) },
    meego: {
      ...defaults.meego,
      ...(user?.meego || {}),
      // batch 是嵌套的，单独再并一层，否则用户只改一个键就会把默认值整块顶掉
      batch: { ...(defaults.meego?.batch || {}), ...(user?.meego?.batch || {}) },
    },
    rule: { ...defaults.rule, ...(user?.rule || {}) },
    browser: { ...defaults.browser, ...(user?.browser || {}) },
    probe: { ...defaults.probe, ...(user?.probe || {}) },
  };
  merged.browser.profileDir = merged.browser.profileDir || path.join(workspace, '.dsh-workhours', 'chrome-profile');
  merged.probe.outDir = merged.probe.outDir || path.join(workspace, '.dsh-workhours', 'probe');
  // 去掉纯注释字段
  delete merged._comment;
  merged._configFrom = configFrom;
  return merged;
}

/**
 * 出厂占位符检测。config.default.json 里 `meego.url` 是 `REPLACE-ME`，必须由用户填成
 * 自己的看板地址；命中时提前返回，免得先打开一个无效地址、再抛难以理解的导航错误。
 */
function isPlaceholderUrl(url) {
  if (typeof url !== 'string') return true;
  const v = url.trim();
  return v === '' || /REPLACE-ME/i.test(v) || /^<.+>$/.test(v);
}

/** 占位符 / 空值的统一报错：说清是哪个键、该写进哪个文件、看哪一节。 */
function placeholderResult(command, key, workspace) {
  return {
    ok: false,
    command,
    stage: 'config',
    error: `配置里的 ${key} 还是占位符，没有填成你自己的地址。`,
    hint: `把 config.default.json 复制成 ${path.join(workspace, '.dsh-workhours', 'config.json')}，`
      + `再把 ${key} 改成你自己的地址（README §6）。`
      + (key === 'meego.url' ? ' 只想看工时换算的话，read 不需要 meego 配置。' : ''),
  };
}

/** 当前月份的几种常见写法，用于在月报里定位「本月」那一行。 */
function monthTokens(d = new Date()) {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const mm = String(m).padStart(2, '0');
  return [`${y}-${mm}`, `${y}/${mm}`, `${y}年${m}月`, `${y}年${mm}月`, `${y}.${mm}`, `${m}月`, `${mm}月`];
}

/** 判断这次抓取是不是被重定向到了登录页（登录态失效的典型表现）。 */
function looksLikeLogin(frames) {
  return frames.some((f) => /login|signin|sign-in|sso|passport|accounts\.|oauth/i.test(f.frameUrl || ''));
}

/* -------------------------------------------- 页面内执行的函数（必须自包含） */

/** 在月报页里找出「出勤天数」对应的数值。 */
function attendanceLookup(label, matchMode, tokens, valueSelector, decimals) {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const textOf = (el) => norm(el && (el.innerText || el.textContent));
  const toNum = (s) => {
    const m = String(s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const v = Number(m[0]);
    return Number.isFinite(v) ? v : null;
  };
  const round = (v) => {
    const f = Math.pow(10, decimals);
    return Math.round(v * f) / f;
  };
  // 0) 配置里写死了选择器，优先用它
  if (valueSelector) {
    try {
      const el = document.querySelector(valueSelector);
      if (el) {
        const raw = el.value !== undefined && el.value !== '' ? el.value : textOf(el);
        const v = toNum(raw);
        if (v !== null) {
          return {
            found: true, days: round(v), source: 'valueSelector', raw: norm(raw),
            candidates: [], labelElementCount: 0, matchedExactly: null,
            matchedBy: 'valueSelector', matchedLabel: valueSelector, headerTexts: [], attendanceTexts: [],
          };
        }
      }
    } catch { /* 选择器非法，继续走启发式 */ }
  }

  const candidates = [];
  // 精确匹配优先：「出勤天数」绝不能被子串「应出勤天数」抢走
  const exactEls = [];
  const looseEls = [];
  // 这两个纯粹是诊断用：失败时能一眼看出页面到底把这一列叫什么
  const headerTexts = [];
  const attendanceTexts = [];
  for (const el of document.querySelectorAll('th,td,div,span,label,dt,dd,p,a')) {
    if (el.children.length > 0) continue;
    const t = textOf(el);
    if (!t || t.length > 30) continue;
    if (t.includes('出勤天数') && attendanceTexts.length < 20 && !attendanceTexts.includes(t)) attendanceTexts.push(t);
    if (t === label) exactEls.push(el);
    else if (matchMode !== 'exact' && t.includes(label)) {
      looseEls.push(el);
      if (headerTexts.length < 12 && !headerTexts.includes(t)) headerTexts.push(t);
    }
  }
  const labelEls = exactEls.length ? exactEls : looseEls;
  const matchedExactly = exactEls.length > 0;
  const matchedBy = matchedExactly ? 'exact' : (looseEls.length ? 'includes' : 'none');
  const matchedLabel = matchedExactly ? label : (looseEls.length ? headerTexts[0] : null);

  // 1) 表头列定位：含 label 的表头格 → 同列数据行取值
  for (const le of labelEls) {
    const cell = le.closest('th,td');
    const row = cell && cell.closest('tr');
    const table = cell && cell.closest('table');
    if (!cell || !row || !table) continue;
    const col = Array.from(row.children).indexOf(cell);
    if (col < 0) continue;
    // 所有非表头行，排除表头自己（tbody 行只遍历一次，避免候选重复）
    const rows = Array.from(table.querySelectorAll('tr'))
      .filter((tr) => tr !== row && !tr.closest('thead'));
    for (const tr of rows) {
      const tds = Array.from(tr.children);
      const target = tds[col];
      if (!target) continue;
      const v = toNum(textOf(target));
      if (v === null) continue;
      candidates.push({ via: 'table', rowText: textOf(tr).slice(0, 200), cellText: norm(textOf(target)), days: round(v), col });
    }
    if (candidates.length) break;
  }

  // 1.5) div 网格表格：北森月报用的是 fixedDataTable（整张表没有 table/tr/td），
  //      表头行与数据行都是「行容器 + 一串格子」，所以按展平后的列序号取值。
  if (!candidates.length) {
    const cellSel = '[class*="fixedDataTableCell_main"], td, th';
    const rowSel = '[class*="rowWrapper"], [role="row"], tr, [class*="bodyRow"]';
    const cellsOf = (row) => Array.from(row.querySelectorAll(cellSel));
    for (const le of labelEls) {
      const headerRow = le.closest(rowSel);
      const labelCell = le.closest(cellSel) || le;
      if (!headerRow || !headerRow.contains(labelCell)) continue;
      const headerCells = cellsOf(headerRow);
      const idx = headerCells.indexOf(labelCell);
      if (idx < 0) continue;
      // 只看与表头列数一致的行，避免串到同一页别的表格上
      const rows = Array.from(document.querySelectorAll(rowSel)).filter((r) => (
        r !== headerRow
        && !r.contains(headerRow)
        && !headerRow.contains(r)
        && !labelCell.contains(r)
        && cellsOf(r).length === headerCells.length
      ));
      for (const r of rows) {
        const target = cellsOf(r)[idx];
        if (!target) continue;
        const raw = target.value !== undefined && target.value !== '' ? target.value : textOf(target);
        const v = toNum(raw);
        if (v === null) continue;
        candidates.push({ via: 'grid', rowText: textOf(r).slice(0, 200), cellText: norm(raw), days: round(v), col: idx });
      }
      if (candidates.length) break;
    }
  }

  // 2) 非表格：label 的兄弟 / 父级邻近节点里的数字
  if (!candidates.length) {
    for (const le of labelEls) {
      const parent = le.parentElement;
      if (!parent) continue;
      const siblings = [le.nextElementSibling, le.previousElementSibling].filter(Boolean);
      for (const s of siblings) {
        const v = toNum(s.value !== undefined && s.value !== '' ? s.value : textOf(s));
        if (v !== null) candidates.push({ via: 'sibling', rowText: textOf(parent).slice(0, 200), cellText: norm(textOf(s)), days: round(v) });
      }
      const parentText = textOf(parent);
      if (!candidates.length && parentText.length < 80) {
        const cleaned = parentText.split(label).join(' ');
        const v = toNum(cleaned);
        if (v !== null) candidates.push({ via: 'parentText', rowText: parentText, cellText: norm(cleaned), days: round(v) });
      }
    }
  }

  if (!candidates.length) {
    return {
      found: false, days: null, labelElementCount: labelEls.length, matchedExactly, matchedMonth: null,
      matchedBy, candidates, headerTexts, attendanceTexts,
    };
  }

  // 3) 选行：优先含当前月份的行，否则取第一条
  const byMonth = candidates.find((c) => c.rowText && tokens.some((t) => c.rowText.includes(t)));
  const chosen = byMonth || candidates[0];
  return {
    found: true,
    days: chosen.days,
    source: chosen.via,
    matchedRow: byMonth ? 'current-month' : 'first-candidate',
    matchedMonth: (String(chosen.rowText || '').match(/\d{4}-\d{2}/) || [null])[0],
    candidates,
    labelElementCount: labelEls.length,
    matchedExactly,
    matchedBy,
    matchedLabel,
    headerTexts,
    attendanceTexts,
  };
}

/**
 * 页面内：按可见文字找一个可点元素，返回其中心坐标。
 * Meego 的「工时登记」是个下拉按钮，真正可点的是最小的那个 <button>：
 * 外层还套着 resource-top / ant-space 等容器，取错了就点不动（实测点了没反应）。
 */
function meegoFindClickable(text) {
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const hits = [];
  const sel = 'button,[role="button"],[role="menuitem"],li,[class*="ant-dropdown-menu-item"],span,div,a';
  for (const el of document.querySelectorAll(sel)) {
    if (!visible(el)) continue;
    if (clean(el.innerText || el.textContent) !== text) continue;
    const r = el.getBoundingClientRect();
    hits.push({
      tag: el.tagName.toLowerCase(),
      buttonish: el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' ? 1 : 0,
      w: Math.round(r.width),
      h: Math.round(r.height),
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
    });
  }
  // 真按钮优先，其次面积最小（最深、最贴近文字的那个）
  hits.sort((a, b) => (b.buttonish - a.buttonish) || (a.w * a.h - b.w * b.h));
  const best = hits[0];
  if (!best) return null;
  // 命中测试：中心点上最上层是不是它（或它的子孙/祖先）。
  // 页面还在加载时会被 ant-spin 之类的遮罩盖住，这时点了没反应 —— 交给调用方等一等再点。
  const top = document.elementFromPoint(best.x, best.y);
  let covers = false;
  if (top) {
    for (const el of document.querySelectorAll(sel)) {
      if (!visible(el)) continue;
      if (clean(el.innerText || el.textContent) !== text) continue;
      if (el.contains(top) || top.contains(el)) { covers = true; break; }
    }
  }
  best.hitTest = covers;
  best.coveredBy = top ? `${top.tagName.toLowerCase()}.${String(top.className || '').slice(0, 60)}` : null;
  return best;
}

/**
 * 页面内：把弹窗里的「登记工时」填成 value。
 * 输入框由 React/antd 托管，直接赋值不生效，必须走原生 setter + 派发事件。
 * 工作日期是可选项，且 antd 日期框即使值被改写也未必被内部状态接受，只算尽力而为。
 */
function meegoSetValue(inputSelector, value, dateSelector, dateValue) {
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const setNative = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const out = {
    selector: inputSelector,
    dateSelector: dateSelector || null,
    hoursBefore: null,
    hoursAfter: null,
    hoursFilled: false,
    dateFilled: false,
    note: null,
  };

  let el = null;
  if (inputSelector) { try { el = document.querySelector(inputSelector); } catch { el = null; } }
  if (!el || !visible(el)) {
    out.note = '没在弹窗里找到工时输入框，请核对 meego.hoursInputSelector';
    return out;
  }
  out.hoursBefore = el.value;
  setNative(el, String(value));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  out.hoursAfter = el.value;
  out.hoursFilled = String(el.value) === String(value);

  if (dateSelector && dateValue) {
    let d = null;
    try { d = document.querySelector(dateSelector); } catch { d = null; }
    if (d && visible(d)) {
      setNative(d, String(dateValue));
      for (const type of ['keydown', 'keyup']) {
        d.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }
      out.dateFilled = String(d.value) === String(dateValue);
    }
  }
  out.frameUrl = location.href;
  return out;
}

/* ------------------------------------------------------------------ 子命令 */

async function withBrowser(config, fn) {
  const { port, profileDir, headless, chromePath } = config.browser;
  const started = await ensureBrowser({ port, profileDir, headless, chromePath });
  const { cdp, version } = started;
  log(`[browser] ${version.Browser}  端口=${port}  profile=${profileDir}  ${started.launched ? '(新启动)' : '(复用已有)'}`);
  try {
    return await fn(cdp);
  } finally {
    if (config.browser.keepOpen) {
      log('[browser] keepOpen=true，浏览器保持运行');
    } else if (started.launched) {
      try { await cdp.send('Browser.close'); } catch { /* 忽略 */ }
    } else {
      log('[browser] 复用已有浏览器，保持运行');
    }
  }
}

async function cmdProbe(args, config, workspace) {
  const outDir = args.out || config.probe.outDir;
  const only = args.only || 'both';
  const waitForEnter = args['no-wait'] ? false : config.probe.waitForEnter;
  const wantsAttendance = only === 'both' || only === 'attendance';
  const wantsMeego = only === 'both' || only === 'meego';
  if (wantsAttendance && isPlaceholderUrl(config.attendance.url)) return placeholderResult('probe', 'attendance.url', workspace);
  if (wantsMeego && isPlaceholderUrl(config.meego.url)) return placeholderResult('probe', 'meego.url', workspace);
  fs.mkdirSync(outDir, { recursive: true });

  return withBrowser(config, async (cdp) => {
    const jobs = [];
    if (wantsAttendance) jobs.push(['attendance', config.attendance.url]);
    if (wantsMeego) jobs.push(['meego', config.meego.url]);

    const tabs = [];
    for (const [name, url] of jobs) {
      log(`[probe] 打开 ${name}: ${url}`);
      const tab = await openTab(cdp, url);
      await waitForLoad(cdp, tab.sessionId);
      tabs.push({ name, ...tab, url });
    }

    if (waitForEnter && process.stdin.isTTY) {
      log('');
      log('=========================================================');
      log(' 浏览器已打开。请在里面完成登录，并翻到要读取/填写的页面。');
      log(' 完成后回到这个终端按【回车】开始抓取结构。');
      log('=========================================================');
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      await new Promise((r) => rl.question('', r));
      rl.close();
    } else if (waitForEnter) {
      log('[probe] stdin 不是终端，等待 8 秒后自动抓取');
      await sleep(8000);
    }

    const report = { outDir, generatedAt: new Date().toISOString(), pages: [] };

    for (const tab of tabs) {
      log(`[probe] 抓取 ${tab.name} 的 DOM 结构…`);
      await waitForLoad(cdp, tab.sessionId, { settleMs: 1500 });

      const inventories = await collectFrames(cdp, tab.sessionId, INVENTORY_EXPR);
      const htmls = await collectFrames(cdp, tab.sessionId, HTML_EXPR);

      const invFile = path.join(outDir, `${tab.name}.inventory.json`);
      const htmlFile = path.join(outDir, `${tab.name}.html`);
      const pngFile = path.join(outDir, `${tab.name}.png`);

      fs.writeFileSync(invFile, JSON.stringify(inventories, null, 2), 'utf8');
      fs.writeFileSync(
        htmlFile,
        htmls.map((h) => `\n\n<!-- ===== ${h.via} :: ${h.frameUrl} ===== -->\n${h.value || `<!-- error: ${h.error} -->`}`).join(''),
        'utf8',
      );
      try { await screenshot(cdp, tab.sessionId, pngFile); } catch (e) { log(`[probe] 截图失败: ${e.message}`); }

      const frames = inventories.map((f) => ({
        via: f.via,
        frameUrl: f.frameUrl,
        error: f.error,
        title: f.value?.title,
        inputs: f.value?.inputs?.length ?? 0,
        tables: f.value?.tables?.length ?? 0,
        keywordHits: f.value?.keywordHits?.length ?? 0,
        iframes: f.value?.iframes?.length ?? 0,
      }));
      report.pages.push({ name: tab.name, url: tab.url, inventoryFile: invFile, htmlFile, pngFile, frames });
      for (const f of frames) {
        log(`[probe]   ${f.via} ${f.frameUrl?.slice(0, 90)} → inputs=${f.inputs} tables=${f.tables} 关键词命中=${f.keywordHits}${f.error ? ` 错误=${f.error}` : ''}`);
      }
      await closeTab(cdp, tab.targetId);
    }

    return { ok: true, command: 'probe', ...report };
  });
}

/**
 * 轮询直到某一帧命中，或超时。
 * iTalent 月报的表格是异步渲染的：页面 readyState 到 complete 时表格往往还没出现，
 * 只抓一次会稳定失败（而且看起来像「页面上没有这个字段」），所以必须轮询等待。
 */
async function pollFrames(cdp, sessionId, expr, preferUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let results = [];
  for (;;) {
    results = await collectFrames(cdp, sessionId, expr, { preferUrl });
    if (results.some((r) => r.value && r.value.found)) return results;
    if (Date.now() >= deadline) return results;
    await sleep(1500);
  }
}

/** 在（偏好优先的）各 frame 里跑同一个表达式，返回第一个非空结果所在的 frame。 */
async function findInFrames(cdp, sessionId, expr, preferUrl) {
  const contexts = await frameContexts(cdp, sessionId, { preferUrl });
  for (const ctx of contexts) {
    try {
      const point = await evalIn(cdp, ctx.sessionId, expr, ctx.contextId);
      if (point) return { ctx, point };
    } catch { /* 这个 frame 里没跑通，继续下一个 */ }
  }
  return null;
}

/**
 * 页面内：点开月报里的月份后，把当前渲染出来的日报行按坐标还原成「日期 + 出勤统计天数 + 日出勤时长」。
 * 日报也是 fixedDataTable：没有 table/tr/td，只能用 y 聚行、x 排序。
 */
function dailyRowsExpr() {
  return `(() => {
    const clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
    const cells = [];
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      const t = clean(el.innerText || el.textContent);
      if (!t || t.length > 60) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      cells.push({ t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y) });
    }
    const rows = [];
    for (const c of cells) {
      const row = rows.find((r) => Math.abs(r.y - c.y) <= 7);
      if (row) row.cells.push(c); else rows.push({ y: c.y, cells: [c] });
    }
    for (const r of rows) r.cells.sort((a, b) => a.x - b.x);

    // ⚠️ 取值必须**按表头列名**，不能按「第几个数字」——用户可以在「高级筛选」里增删字段，
    // 位置一变就会串列（实测把「出勤统计天数」读成了别的列，整月少算 7 小时）。
    const header = rows.find((r) => r.cells.some((c) => c.t === '考勤日期'));
    if (!header) return { rows: [], rendered: 0, error: '没找到含「考勤日期」的表头行' };
    const cols = header.cells.map((c) => ({ label: c.t, x: c.x }));
    // 列边界 = 相邻表头中心的中点，这样左右对齐不同也能正确归属
    const bounds = cols.map((c, i) => ({
      label: c.label,
      x: c.x,
      left: i === 0 ? -Infinity : Math.round((cols[i - 1].x + c.x) / 2),
      right: i === cols.length - 1 ? Infinity : Math.round((c.x + cols[i + 1].x) / 2),
    }));
    const colOf = (name) => bounds.find((b) => b.label === name) || bounds.find((b) => b.label.includes(name));
    const want = {
      date: colOf('考勤日期'),
      shift: colOf('班次'),
      statDays: colOf('出勤统计天数'),
      status: colOf('考勤状态'),
      schedDays: colOf('排班天数'),
      // 这一列是 iTalent 自己算好的「当天该算多少工时」（常规班 8、半天 7.5、假日 0），优先用它
      hours: colOf('实际出勤工时') || colOf('日出勤时长'),
      realDays: colOf('实际出勤天数'),
    };
    const num = (s) => { const m = String(s == null ? '' : s).replace(/,/g, '').match(/-?\\d+(?:\\.\\d+)?/); return m ? Number(m[0]) : null; };
    const out = [];
    for (const r of rows) {
      if (r === header) continue;
      const textIn = (col) => { if (!col) return null; const c = r.cells.find((x) => x.x > col.left && x.x <= col.right); return c ? c.t : null; };
      const dateRaw = textIn(want.date);
      if (!dateRaw || !/^\\d{4}-\\d{2}-\\d{2}/.test(dateRaw)) continue;
      out.push({
        date: dateRaw.slice(0, 10),
        weekday: dateRaw.slice(11),
        shift: textIn(want.shift),
        statDays: num(textIn(want.statDays)),
        schedDays: num(textIn(want.schedDays)),
        hours: num(textIn(want.hours)),
        realDays: num(textIn(want.realDays)),
        status: textIn(want.status),
      });
    }
    return { rows: out, rendered: out.length, columns: bounds.map((b) => b.label), hoursColumn: want.hours ? want.hours.label : null };
  })()`;
}

/** 页面内：按可见文字找一个可点元素（带命中测试，避免点到被遮挡的副本）。 */
function textFinderExpr(text) {
  return `(() => {
    const clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.01;
    };
    const out = [];
    for (const el of document.querySelectorAll('a,span,div,button,li,i,em,label,p,b,strong')) {
      if (!visible(el)) continue;
      if (clean(el.innerText || el.textContent) !== ${JSON.stringify(text)}) continue;
      const r = el.getBoundingClientRect();
      const cx = Math.round(r.x + r.width / 2);
      const cy = Math.round(r.y + r.height / 2);
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
      const top = document.elementFromPoint(cx, cy);
      const hit = Boolean(top) && (top === el || el.contains(top) || top.contains(el));
      out.push({ x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height), tag: el.tagName, hit });
    }
    out.sort((a, b) => (b.hit - a.hit) || (a.w * a.h - b.w * b.h));
    return out[0] || null;
  })()`;
}

/**
 * 读「日报」：点开月报里的月份 → 逐屏收集每天的『出勤统计天数』。
 *
 * 为什么值得走这一趟：月报只给整月一个数（如 21.875 天），按它平摊会把工时填到**节假日**上、
 * 又漏掉**调休上班的周末**。日报是逐日的，`出勤统计天数 × 每天工时` 才是每一天该填的数，
 * 而且逐日相加正好等于月报那个总数（实测 20×1.0 + 2×0.9375 = 21.875）。
 *
 * ⚠️ 页面滚动很慢：fixedDataTable 没有可用的 scrollTop（scrollHeight === clientHeight），
 * 只能发滚轮事件，而页面是**阻塞式加载**数据的，单次滚轮可能 20~30 秒才返回。所以这里刻意
 * 用长超时 + 轮次上限，并把每一屏合并去重，最后点「返回」把月报视图还原。
 */
async function readDailyDetail(cdp, sessionId, month, { maxRounds = 34, log: logFn = log } = {}) {
  // 先确保在「月报汇总」视图：日报视图里有个「返回」按钮，页面有可能被上一次操作留在那儿。
  // 不还原就找不到真正的月份链接（日报视图里那些「2026-09」是别的东西，点了没反应）。
  for (const c of await frameContexts(cdp, sessionId, { preferUrl: 'italent.cn' })) {
    let back = null;
    try { back = await evalIn(cdp, c.sessionId, textFinderExpr('返回'), c.contextId, { timeoutMs: 8000 }); } catch { continue; }
    if (back && back.hit) {
      await clickAt(cdp, c.sessionId, back.x, back.y, { timeoutMs: 10000 });
      logFn('[daily] 页面之前在日报视图，先点「返回」回到月报汇总');
      await sleep(3500);
      break;
    }
  }

  let ctx = null;
  let link = null;
  // 月份链接可能还在渲染，给几次机会
  for (let i = 0; i < 6 && !link; i += 1) {
    for (const c of await frameContexts(cdp, sessionId, { preferUrl: 'italent.cn' })) {
      let found = null;
      try { found = await evalIn(cdp, c.sessionId, textFinderExpr(month), c.contextId, { timeoutMs: 10000 }); } catch { continue; }
      if (found && found.hit) { ctx = c; link = found; break; }
    }
    if (!link) await sleep(2000);
  }
  if (!link) return { ok: false, error: `没找到可点的月份「${month}」`, days: [] };

  await clickAt(cdp, ctx.sessionId, link.x, link.y, { timeoutMs: 10000 });
  logFn(`[daily] 已点开月份 ${month}，等日报表格…`);

  // 等日报出现（出现形如「2026-09-30 星期三」的叶子文字）
  const deadline = Date.now() + 30000;
  let appeared = false;
  while (Date.now() < deadline) {
    try {
      const r = await evalIn(cdp, ctx.sessionId, dailyRowsExpr(), ctx.contextId, { timeoutMs: 15000 });
      if (r && r.rows && r.rows.length) { appeared = true; break; }
    } catch { /* 页面切换中，继续等 */ }
    await sleep(1200);
  }
  if (!appeared) return { ok: false, error: '点了月份但日报表格没渲染出来', days: [] };

  // 等表格稳定：刚切过来时还在异步加载，这时候滚轮会被吞掉（实测滚不动）。
  let stable = 0;
  let lastSig = '';
  for (let i = 0; i < 20; i += 1) {
    let r = null;
    try { r = await evalIn(cdp, ctx.sessionId, dailyRowsExpr(), ctx.contextId, { timeoutMs: 15000 }); } catch { /* 继续等 */ }
    const sig = r && r.rows ? r.rows.map((x) => `${x.date}:${x.statDays}:${x.hours}`).join(',') : '';
    if (sig && sig === lastSig) { stable += 1; if (stable >= 2) break; } else stable = 0;
    lastSig = sig;
    await sleep(1500);
  }
  logFn('[daily] 表格已稳定，开始逐屏收集');

  // 滚轮坐标每轮重算：固定坐标在表格跳动之后会落到表格外面，滚轮就再也滚不动了。
  const wheelPoint = async () => {
    try {
      const p = await evalIn(cdp, ctx.sessionId, `(() => {
        const clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
        let leaf = null;
        for (const el of document.querySelectorAll('*')) {
          if (el.children.length > 0) continue;
          if (/^\\d{4}-\\d{2}-\\d{2} 星期/.test(clean(el.innerText || el.textContent))) { leaf = el; break; }
        }
        if (!leaf) return null;
        let box = leaf;
        for (let i = 0; i < 10 && box.parentElement; i += 1) {
          box = box.parentElement;
          if (/rowsContainer|pps-virtual-table/.test(String(box.className || ''))) break;
        }
        const r = box.getBoundingClientRect();
        if (r.width < 50 || r.height < 50) return null;
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`, ctx.contextId, { timeoutMs: 10000 });
      return p && p.y > 0 ? p : { x: 700, y: 600 };
    } catch { return { x: 700, y: 600 }; }
  };

  const collected = new Map();
  let hoursColumn = null;
  let columns = null;
  // ⚠️ 合并规则：**别用不完整的行覆盖完整的行**。
  // 虚拟滚动重渲染时，某一屏里某一行可能只渲染出「考勤日期」一格（其余全 null），
  // 直接 set 覆盖就会把已经读到的 8 小时抹成 0（实测整月因此少算 8 小时）。
  const score = (x) => (x.status ? 1 : 0) + (x.shift ? 1 : 0)
    + (x.statDays != null ? 1 : 0) + (x.hours != null ? 1 : 0) + (x.schedDays != null ? 1 : 0);
  const snapshot = async (tag) => {
    let r;
    try { r = await evalIn(cdp, ctx.sessionId, dailyRowsExpr(), ctx.contextId, { timeoutMs: 20000 }); } catch (e) {
      logFn(`[daily] ${tag} 取行失败：${String(e.message).slice(0, 60)}`);
      return { rows: [], rendered: 0 };
    }
    if (r.columns) columns = r.columns;
    if (r.hoursColumn) hoursColumn = r.hoursColumn;
    for (const row of r.rows || []) {
      const prev = collected.get(row.date);
      if (!prev || score(row) >= score(prev)) collected.set(row.date, row);
    }
    return r;
  };

  // 先尽量滚回顶部，保证从 1 号开始
  for (let i = 0; i < 10; i += 1) {
    try {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 600, deltaX: 0, deltaY: -600, modifiers: 0 }, ctx.sessionId, { timeoutMs: 35000 });
    } catch { /* 忽略超时，继续 */ }
    await sleep(500);
  }
  const first = await snapshot('顶部');
  logFn(`[daily] 顶部本屏 ${first.rendered} 行，累计 ${collected.size} 天`);

  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  let stale = 0;
  let nudge = false;
  for (let round = 0; round < maxRounds; round += 1) {
    if (collected.size >= daysInMonth) break;
    // ⚠️ 每屏固定渲染 11 行，「行数没变」不等于没滚动 —— 只能看「有没有新增日期」。
    // ⚠️ 别在一次里连发两个滚轮：表格正在加载数据时会被卡住（实测直接停在 22/30 不动）。
    //    一次一个 deltaY≈300，页面阻塞式加载时这一发要 20~30 秒才返回，要等得起。
    const dy = nudge ? -300 : 300;
    nudge = false;
    const pt = await wheelPoint();
    try {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', buttons: 0 }, ctx.sessionId, { timeoutMs: 8000 });
    } catch { /* 忽略 */ }
    try {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY: dy, modifiers: 0 }, ctx.sessionId, { timeoutMs: 35000 });
    } catch { /* 忽略超时 */ }
    await sleep(1400);
    const before = collected.size;
    const now = await snapshot(`第 ${round + 1} 屏`);
    logFn(`[daily] 第 ${round + 1} 屏 ${now.rendered} 行，累计 ${collected.size}/${daysInMonth} 天`);
    if (collected.size === before) {
      stale += 1;
      // 卡住时先往回退一点再往下，通常能把懒加载唤醒
      if (stale === 3) nudge = true;
      if (stale >= 8) break;
    } else stale = 0;
  }

  // 还原月报视图
  try {
    const back = await evalIn(cdp, ctx.sessionId, textFinderExpr('返回'), ctx.contextId, { timeoutMs: 10000 });
    if (back && back.hit) { await clickAt(cdp, ctx.sessionId, back.x, back.y, { timeoutMs: 10000 }); await sleep(2500); }
  } catch { /* 还原失败不影响数据 */ }

  const days = [...collected.values()].sort((a, b) => a.date.localeCompare(b.date));
  // 只保留真正有值的行：全 null 的行说明那一次渲染只出了日期格
  const filled = days.filter((d) => d.statDays != null || d.hours != null || d.shift);
  const missing = days.filter((d) => !filled.includes(d)).map((d) => d.date);
  return { ok: filled.length > 0, days: filled, daysInMonth, complete: filled.length >= daysInMonth, missing, columns, hoursColumn };
}

/**
 * 等登记弹窗出现。
 * 关键：弹窗不是在看看板那个 frame 里渲染的，而是**另一个** page-web 目标，
 * 所以要跨 frame 找「含目标输入框且可见」的那个 frame。
 */
async function waitForModal(cdp, sessionId, selector, timeoutMs, preferUrl) {
  const expr = `(() => {
    let el = null;
    try { el = document.querySelector(${JSON.stringify(selector)}); } catch { return null; }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 ? { ok: true, frameUrl: location.href } : null;
  })()`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const contexts = await frameContexts(cdp, sessionId, { preferUrl });
    for (const ctx of contexts) {
      try {
        const v = await evalIn(cdp, ctx.sessionId, expr, ctx.contextId);
        if (v) return { ctx, value: v, timedOut: false };
      } catch { /* 忽略无法求值的 frame */ }
    }
    if (Date.now() >= deadline) return { ctx: null, timedOut: true };
    await sleep(1000);
  }
}

async function cmdRead(args, config, workspace) {
  if (isPlaceholderUrl(config.attendance.url)) return placeholderResult('read', 'attendance.url', workspace);
  const expr = `(${attendanceLookup.toString()})(${JSON.stringify(config.attendance.label)}, ${JSON.stringify(config.attendance.labelMatch)}, ${JSON.stringify(monthTokens())}, ${JSON.stringify(config.attendance.valueSelector)}, ${JSON.stringify(config.attendance.decimals)})`;

  return withBrowser(config, async (cdp) => {
    const preferUrl = config.attendance.frameUrlIncludes;
    // 优先复用用户自己打开的月报标签页：正文所在的 widget iframe 在新标签页里往往是空的
    let tab = null;
    if (config.attendance.reuseTab !== false) {
      tab = await findTab(cdp, ['attendance', preferUrl || 'italent.cn']);
      if (tab) log(`[read] 复用已打开的标签页：${String(tab.url).slice(0, 90)}`);
    }
    const openedHere = !tab;
    if (!tab) {
      tab = await openTab(cdp, config.attendance.url);
      await waitForLoad(cdp, tab.sessionId, { settleMs: 2500 });
    }
    const frameWait = await waitForFrame(cdp, tab.sessionId, preferUrl, {
      timeoutMs: config.attendance.frameWaitMs ?? 15000,
    });
    const results = await pollFrames(cdp, tab.sessionId, expr, preferUrl, config.attendance.renderWaitMs ?? 30000);

    const hits = results.filter((r) => r.value && r.value.found);
    const best = hits[0];
    const hours = best ? Math.round(best.value.days * config.rule.hoursPerDay * 100) / 100 : null;

    // 没找到时顺手做一次标签侦察，直接给出可以写进配置的选择器候选
    let probes = null;
    if (!best) {
      const raw = await collectFrames(cdp, tab.sessionId, labelProbeExpr(config.attendance.label), { preferUrl });
      probes = raw
        .filter((r) => r.value && Array.isArray(r.value.hits) && r.value.hits.length > 0)
        .map((r) => ({ frameUrl: r.frameUrl, preferred: r.preferred === true, hits: r.value.hits.slice(0, 8) }));
      if (probes.length === 0) probes = [];
    }

    // 逐日明细（可选）：--daily 或 attendance.dailyDetail
    let daily = null;
    if (best && (args.daily === true || config.attendance.dailyDetail === true) && best.value.matchedMonth) {
      log(`[read] 读 ${best.value.matchedMonth} 的日报逐日明细（页面滚动很慢，可能要几分钟）…`);
      const d = await readDailyDetail(cdp, tab.sessionId, best.value.matchedMonth);
      if (d.ok) {
        const perDay = {};
        for (const row of d.days) {
          // 优先用页面自己算好的「实际出勤工时」；没有这一列时退回 出勤统计天数 × 每天工时
          const h = row.hours != null && row.hours > 0
            ? Math.round(row.hours * 100) / 100
            : (row.statDays > 0 ? Math.round(row.statDays * config.rule.hoursPerDay * 100) / 100 : 0);
          if (h > 0) perDay[row.date] = h;
        }
        daily = {
          ok: true,
          complete: d.complete,
          days: d.days,
          hoursColumn: d.hoursColumn ?? null,
          missing: d.missing ?? [],
          planDates: d.days.length,
          sumStatDays: Math.round(d.days.reduce((a, x) => a + (x.statDays || 0), 0) * 10000) / 10000,
          sumRealDays: Math.round(d.days.reduce((a, x) => a + (x.realDays || 0), 0) * 10000) / 10000,
          perDayHours: perDay,
          sumHours: Math.round(Object.values(perDay).reduce((a, x) => a + x, 0) * 100) / 100,
        };
        log(`[read] 日报逐日：${d.days.length} 天，逐日工时合计 ${daily.sumHours}h（月报口径 ${hours}h，差 ${Math.round((daily.sumHours - hours) * 100) / 100}h）`);
      } else {
        daily = { ok: false, error: d.error };
        log(`[read] 日报逐日没读成：${d.error}`);
      }
    }
    if (openedHere) await closeTab(cdp, tab.targetId);

    return {
      ok: Boolean(best),
      command: 'read',
      days: best ? best.value.days : null,
      hours,
      hoursPerDay: config.rule.hoursPerDay,
      source: best ? best.value.source : null,
      matchedRow: best ? best.value.matchedRow : null,
      matchedMonth: best ? best.value.matchedMonth : null,
      matchedBy: best ? best.value.matchedBy : null,
      matchedLabel: best ? best.value.matchedLabel : null,
      frameUrl: best ? best.frameUrl : null,
      attendanceTab: { reused: !openedHere, url: tab.url },
      daily,
      frameWait,
      candidates: best ? best.value.candidates : [],
      probes,
      frames: results.map((r) => ({
        via: r.via,
        frameUrl: r.frameUrl,
        preferred: r.preferred === true,
        error: r.error,
        found: Boolean(r.value && r.value.found),
        labelElementCount: r.value?.labelElementCount,
        // 诊断：这个 frame 里「出勤天数」相关的表头文字到底长什么样
        attendanceTexts: r.value?.attendanceTexts,
        headerTexts: r.value?.headerTexts,
        matchedBy: r.value?.matchedBy,
      })),
      hint: best
        ? null
        : (looksLikeLogin(results)
          ? '页面被重定向到了登录页 —— 浏览器里的登录态已失效。请先运行 probe 重新登录一次。'
          : (openedHere
            ? '没找到「出勤天数」。注意：driver 这次是**自己新开**的标签页，'
              + '而月报正文所在的 widget iframe 在新标签页里经常是空的。'
              + '请在浏览器里点开「我的假勤 → 我的月报」，让它渲染出来，再重跑一次'
              + '（driver 会复用你那个标签页；这条路实测才有内容）。'
            : '没找到「出勤天数」。先看 frames[].attendanceTexts —— 那是这个页面里所有含「出勤天数」的表头文字，'
              + '照着它把 attendance.label 改对（默认是「本月实际出勤天数」）；如果文字本来就对，'
              + '再用 probes 里的 cssPath 填 attendance.valueSelector。')),
    };
  });
}

/* ------------------------------------------------ 批量登记（按天填格） ---- */

/**
 * 读批量登记弹窗的网格结构。
 * 批量网格里**格子里没有 input**，数字是格子文本；点格子才会弹出带 `#realActWorkHour`
 * 的 ant-popover。所以「哪一格是哪个日期」只能靠表头文字与行内 cellRects 对应。
 */
function batchReadGrid() {
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden';
  };
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };

  const seenDate = new Set();
  const days = [];
  for (const el of document.querySelectorAll('td,th,[class*="cell"],[class*="Cell"]')) {
    const t = clean(el.innerText);
    const m = t.match(/^周[一二三四五六日]\s*(\d{4}-\d{2}-\d{2})$/);
    if (!m || seenDate.has(m[1]) || !vis(el)) continue;
    seenDate.add(m[1]);
    days.push({ date: m[1], rect: rect(el) });
  }

  const rows = [];
  for (const tr of [...document.querySelectorAll('tr')].filter(vis)) {
    const cells = [...tr.children];
    const texts = cells.map((c) => clean(c.innerText));
    const first = texts[0] || '';
    if (!first || /^周[一二三四五六日]/.test(first) || first === '登记对象' || first === '暂无数据') continue;
    rows.push({
      name: first.slice(0, 40),
      schedule: texts[1] || '',
      hours: texts[2] || '',
      total: texts[3] || '',
      rect: rect(tr),
      cellRects: cells.map(rect),
      // 前 4 列固定：登记对象 / 成员排期 / 预估工时 / 合计，之后逐日
      dayTexts: texts.slice(4),
    });
  }

  const pops = [...document.querySelectorAll('.ant-popover')]
    .filter((e) => vis(e) && !/leave/.test(String(e.className)) && /登记日期/.test(String(e.innerText)));
  const editor = document.querySelector('#realActWorkHour');
  const bodyText = clean(document.body ? document.body.innerText : '');
  const remaining = bodyText.match(/剩余可登记工时\s*([\d.]+)\s*小时/);
  const pending = bodyText.match(/当前拟提交工时\s*(-|[\d.]+)\s*小时/);

  return {
    days,
    rows: rows.slice(0, 40),
    editor: editor && vis(editor) ? { value: String(editor.value ?? '') } : null,
    popover: pops.length
      ? {
        date: (clean(pops[0].innerText).match(/(\d{4}-\d{2}-\d{2})/) || [null])[0],
        text: clean(pops[0].innerText).slice(0, 140),
        rect: rect(pops[0]),
      }
      : null,
    remainingHours: remaining ? remaining[1] : null,
    pendingHours: pending ? pending[1] : null,
    view: { w: window.innerWidth, h: window.innerHeight },
  };
}

/** 按文字在**指定 frame** 里点一下。 */
async function clickTextIn(cdp, ctx, text) {
  const pt = await evalIn(cdp, ctx.sessionId, `(${meegoFindClickable.toString()})(${JSON.stringify(text)})`, ctx.contextId);
  if (!pt) return null;
  await clickAt(cdp, ctx.sessionId, pt.x, pt.y);
  return pt;
}

/** 批量弹窗里那些 antd select 的「点开 → 选项」定位。 */
function batchSelectFinder(kind) {
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden';
  };
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('[class*="ant-select-selector"]')) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    const key = `${Math.round(r.x)},${Math.round(r.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let p = el;
    let around = '';
    for (let i = 0; i < 8 && p; i += 1) {
      p = p.parentElement;
      if (!p) break;
      const t = clean(p.innerText);
      if (t) { around = t.slice(0, 90); break; }
    }
    out.push({
      own: clean(el.innerText).slice(0, 50),
      around,
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
    });
  }
  if (kind === 'type') return out.find((s) => /选择工作项类型/.test(s.around) || /选择工作项类型/.test(s.own)) || null;
  return out.find((s) => /请搜索选择工作项实例|工作项实例/.test(s.own))
    || out.find((s) => /请搜索选择工作项实例|工作项实例/.test(s.around))
    || null;
}

/** 只取「没被 antd 隐藏」的下拉选项（关闭的下拉会留在 DOM 里，是最容易踩的坑）。 */
function batchVisibleOptions() {
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const out = [];
  for (const el of document.querySelectorAll('[class*="ant-select-item-option"],[role="option"]')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    const dd = el.closest('[class*="ant-select-dropdown"],[class*="ant-dropdown"]');
    if (dd && /hidden/.test(String(dd.className))) continue;
    out.push({ text: clean(el.innerText).slice(0, 50), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  }
  const seen = new Set();
  return out.filter((o) => { const k = `${o.text}|${o.y}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 30);
}

/** 原生 setter 写 #realActWorkHour（antd 受控组件，直接赋 value 不生效）。 */
function batchSetHour(value) {
  const el = document.querySelector('#realActWorkHour');
  if (!el) return { ok: false, err: '弹窗里没有 #realActWorkHour' };
  const before = String(el.value ?? '');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, String(value));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, before, after: String(el.value ?? '') };
}

/** 把某一列横向滚进视野（整月 30 列，远超视口宽度）。 */
function batchScrollToDate(date) {
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const want = new RegExp(`^周[一二三四五六日]\\s*${date}$`);
  let head = null;
  for (const el of document.querySelectorAll('td,th,[class*="cell"],[class*="Cell"]')) {
    if (want.test(clean(el.innerText))) { head = el; break; }
  }
  if (!head) return { ok: false, err: `表头里没有 ${date} 这一列` };
  let p = head.parentElement;
  let wrap = null;
  while (p && p !== document.body) {
    const st = getComputedStyle(p);
    if (/(auto|scroll)/.test(st.overflowX) && p.scrollWidth > p.clientWidth + 20) { wrap = p; break; }
    p = p.parentElement;
  }
  if (!wrap) return { ok: false, err: '没找到横向滚动容器' };
  const tr = head.getBoundingClientRect();
  const wr = wrap.getBoundingClientRect();
  if (tr.left < wr.left + 2 || tr.right > wr.right - 2) {
    wrap.scrollLeft += (tr.left - wr.left) - Math.round(wr.width / 3);
  }
  return { ok: true, scrollLeft: Math.round(wrap.scrollLeft) };
}

/**
 * 按天把总工时摊到「工作日」上：每个工作日 8h，余数落在最后一个工作日，总和精确相等。
 *
 * `perDayMap` 给了「日期 → 该填小时」时走**逐日精确**这条路（来自日报的『出勤统计天数』）：
 * 只填有出勤的天，每天按 `出勤统计天数 × 每天工时`，没有出勤（请假/节假日/未打卡）的天不填。
 * 这样不会把工时填到节假日上、也不会漏掉调休上班的周末。
 */
function buildBatchPlan(totalHours, dayDates, workdaysOnly, perDay, perDayMap) {
  const isWeekend = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    const w = new Date(y, m - 1, d).getDay();
    return w === 0 || w === 6;
  };
  if (perDayMap && Object.keys(perDayMap).length) {
    const limit = Array.isArray(dayDates) && dayDates.length ? new Set(dayDates) : null;
    const plan = Object.keys(perDayMap)
      .filter((d) => Number(perDayMap[d]) > 0)
      // dayDates 只是弹窗里出现的日期范围；逐日数据本身就来自考勤，不拿它硬筛，
      // 但如果给了范围且这天不在范围里，就不填（避免填到看不到的格子上）
      .filter((d) => !limit || limit.has(d))
      .sort()
      .map((date) => ({ date, hours: Math.round(Number(perDayMap[date]) * 10000) / 10000 }));
    const sum = Math.round(plan.reduce((a, p) => a + p.hours, 0) * 10000) / 10000;
    return plan.map((p) => ({ ...p, planSource: 'daily', planSum: sum }));
  }
  const pool = (workdaysOnly ? dayDates.filter((d) => !isWeekend(d)) : dayDates.slice()).sort();
  if (!pool.length) return [];
  const per = perDay > 0 ? perDay : 8;
  const full = Math.floor(totalHours / per + 1e-6);
  const rest = Math.round((totalHours - full * per) * 10000) / 10000;
  const need = full + (rest > 0.0001 ? 1 : 0);
  if (need <= pool.length) {
    const plan = [];
    for (let i = 0; i < full; i += 1) plan.push({ date: pool[i], hours: per });
    if (rest > 0.0001) plan.push({ date: pool[full], hours: rest });
    return plan.map((p) => ({ ...p, planSource: 'spread' }));
  }
  // 天数不够装：均摊到所有工作日，余数补在最后一天
  const each = Math.round((totalHours / pool.length) * 10000) / 10000;
  const plan = pool.map((date) => ({ date, hours: each }));
  const drift = Math.round((totalHours - each * pool.length) * 10000) / 10000;
  if (Math.abs(drift) > 0.0001) plan[plan.length - 1].hours = Math.round((each + drift) * 10000) / 10000;
  return plan.map((p) => ({ ...p, planSource: 'spread' }));
}

/**
 * 批量登记主流程：工时登记 → 批量登记 → 选类型/实例 → 定范围 → 逐格填 → （可选）提交。
 * 弹窗刻意不关，方便人工核对。
 */
async function runBatchFill({ cdp, config, hours, readInfo, submit, preferUrl, steps, clickByText, meegoSessionId, perDayMap }) {
  const batch = config.meego.batch || {};
  const days = readInfo && readInfo.matchedMonth ? String(readInfo.matchedMonth) : null;
  const rowIndex = 0;
  // 计时日志：批量这条路步骤多，出问题时要能一眼看出停在哪一步
  const t0 = Date.now();
  const mark = (m) => log(`[fill][batch +${String(Date.now() - t0).padStart(6)}ms] ${m}`);

  const result = {
    mode: 'batch',
    rowIndex,
    rowName: null,
    instance: null,
    range: null,
    plan: [],
    cells: [],
    fillErrors: [],
  };

  // 进入批量弹窗
  const okMode = await clickByText(config.meego.batchModeText ?? '批量登记', 'click-register-mode');
  if (!okMode) {
    result.fatal = '没点开「批量登记」';
    return result;
  }
  await sleep(3500);

  // 弹窗在另一个 oopif 里。判据是「能定位到可见的『选择工作项类型』下拉」，而不是
  // 「哪个 frame 的文字里有这几个字」—— 后者会命中外层 frame 里那份隐藏的弹窗 DOM。
  const typeHit = await pollFrameWithValue(cdp, meegoSessionId, `(${batchSelectFinder.toString()})('type')`, {
    timeoutMs: batch.selectWaitMs || 25000,
    preferUrl,
  });
  if (!typeHit) {
    result.fatal = '没找到「选择工作项类型」下拉（弹窗没打开，或页面结构变了）';
    // 失败时把每个 frame 的实况带回去，省得再猜
    result.diag = [];
    for (const c of await frameContexts(cdp, meegoSessionId, { preferUrl })) {
      const row = { via: c.via, url: String(c.frameUrl || '').slice(0, 70) };
      try {
        const d = await evalIn(cdp, c.sessionId, `(() => {
          const t = document.body ? document.body.innerText : '';
          return {
            selects: document.querySelectorAll('[class*="ant-select-selector"]').length,
            visibleSelects: [...document.querySelectorAll('[class*="ant-select-selector"]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; }).length,
            hasTypeLabel: t.includes('选择工作项类型'),
            hasBatchWord: t.includes('批量登记'),
            hasNoData: t.includes('暂无数据'),
          };
        })()`, c.contextId);
        Object.assign(row, d);
      } catch (e) { row.err = String(e?.message || e).slice(0, 70); }
      result.diag.push(row);
    }
    return result;
  }
  mark('找到类型下拉');
  const ctx = typeHit.ctx;
  const typeSel = typeHit.value;
  result.frameUrl = ctx.frameUrl;

  // 1) 选工作项类型
  await clickAt(cdp, ctx.sessionId, typeSel.x, typeSel.y);
  await sleep(2000);
  let opts = await evalIn(cdp, ctx.sessionId, `(${batchVisibleOptions.toString()})()`, ctx.contextId);
  const wantType = batch.workItemType ? new RegExp(batch.workItemType) : null;
  let pick = wantType ? opts.find((o) => wantType.test(o.text)) : opts[0];
  if (!pick) {
    result.fatal = `工作项类型里没有匹配 ${JSON.stringify(batch.workItemType)} 的选项；实际看到：${JSON.stringify(opts.map((o) => o.text))}`;
    return result;
  }
  await clickAt(cdp, ctx.sessionId, pick.x, pick.y);
  result.workItemType = pick.text;
  steps.push({ step: 'pick-work-item-type', text: pick.text, ok: true });
  await sleep(3000);

  // 2) 搜索并选工作项实例（这个下拉是要输入的）
  let instSel = null;
  for (let i = 0; i < 12 && !instSel; i += 1) {
    instSel = await evalIn(cdp, ctx.sessionId, `(${batchSelectFinder.toString()})('instance')`, ctx.contextId);
    if (!instSel) await sleep(700);
  }
  if (!instSel) {
    result.fatal = '没找到「工作项实例」下拉';
    return result;
  }
  await clickAt(cdp, ctx.sessionId, instSel.x, instSel.y);
  await sleep(1000);
  const query = batch.workItemInstance || batch.workItemQuery || '';
  if (query) {
    await cdp.send('Input.insertText', { text: String(query) }, ctx.sessionId);
    await sleep(2500);
  }
  opts = await evalIn(cdp, ctx.sessionId, `(${batchVisibleOptions.toString()})()`, ctx.contextId);
  const wantInst = batch.workItemInstance ? new RegExp(batch.workItemInstance) : null;
  pick = (wantInst ? opts.find((o) => wantInst.test(o.text)) : opts[0]);
  if (!pick) {
    result.fatal = `工作项实例里没有可选项（搜索词 ${JSON.stringify(query)}）；实际看到：${JSON.stringify(opts.map((o) => o.text))}`;
    return result;
  }
  await clickAt(cdp, ctx.sessionId, pick.x, pick.y);
  result.instance = pick.text;
  mark('实例已选：' + pick.text);
  steps.push({ step: 'pick-work-item-instance', text: pick.text, ok: true });
  await sleep(4000);

  // 3) 定范围：先点范围按钮，覆盖不到目标月再手打日期
  const rangeLabel = batch.range || '上个月';
  const rangeClick = await clickTextIn(cdp, ctx, rangeLabel);
  steps.push({ step: 'set-range', text: rangeLabel, ok: Boolean(rangeClick) });
  await sleep(3500);

  let grid = await evalIn(cdp, ctx.sessionId, `(${batchReadGrid.toString()})()`, ctx.contextId);
  const coversMonth = (g, month) => {
    if (!month) return g.days.length > 0;
    const inMonth = g.days.filter((d) => d.date.startsWith(month)).map((d) => d.date);
    if (!inMonth.length) return false;
    return inMonth[0].endsWith('-01');
  };
  if (!coversMonth(grid, days)) {
    // 手打一个月的起止日期
    const monthStart = days ? `${days}-01` : null;
    let monthEnd = null;
    if (days) {
      const [y, m] = days.split('-').map(Number);
      monthEnd = `${days}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
    }
    if (monthStart && monthEnd) {
      const inputs = await evalIn(cdp, ctx.sessionId, `(() => {
        const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
        const s = [...document.querySelectorAll('input[placeholder="开始日期"]')].filter(vis)[0];
        const e = [...document.querySelectorAll('input[placeholder="结束日期"]')].filter(vis)[0];
        const c = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), value: String(el.value ?? '') }; };
        return { start: s ? c(s) : null, end: e ? c(e) : null };
      })()`, ctx.contextId);
      const typeDate = async (pt, text) => {
        if (!pt) return false;
        await clickAt(cdp, ctx.sessionId, pt.x, pt.y);
        await sleep(400);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }, ctx.sessionId);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }, ctx.sessionId);
        await sleep(200);
        await cdp.send('Input.insertText', { text }, ctx.sessionId);
        await sleep(600);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, ctx.sessionId);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, ctx.sessionId);
        await sleep(1200);
        return true;
      };
      await typeDate(inputs.start, monthStart);
      await typeDate(inputs.end, monthEnd);
      // 点一下弹窗标题区收起日期面板（**千万别点「取消」**，那会把整个批量弹窗关掉）
      const neutral = await evalIn(cdp, ctx.sessionId, `(() => {
        const d = [...document.querySelectorAll('[role="dialog"],[class*="ant-modal"]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 200 && r.height > 200; })[0];
        if (!d) return null;
        const r = d.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 28) };
      })()`, ctx.contextId);
      if (neutral) await clickAt(cdp, ctx.sessionId, neutral.x, neutral.y);
      steps.push({ step: 'type-range', text: `${monthStart}~${monthEnd}`, ok: true });
      await sleep(2500);
      grid = await evalIn(cdp, ctx.sessionId, `(${batchReadGrid.toString()})()`, ctx.contextId);
    }
  }
  result.range = { label: rangeLabel, days: grid.days.map((d) => d.date), coversTarget: coversMonth(grid, days) };

  // 4) 行与填值计划
  if (!grid.rows.length) {
    result.fatal = `网格里没有数据行（范围 ${rangeLabel}）。批量登记的数据行来自「添加已有工作实例/节点/任务」，取决于你本人的排期。`;
    return result;
  }
  const wantRow = batch.rowMatch ? new RegExp(batch.rowMatch) : null;
  const row = wantRow ? (grid.rows.find((r) => wantRow.test(r.name)) || grid.rows[0]) : grid.rows[0];
  result.rowName = row.name;

  const targetDates = days ? grid.days.map((d) => d.date).filter((d) => d.date.startsWith(days)) : grid.days.map((d) => d.date);
  let usePerDay = perDayMap;
  if (usePerDay && Object.keys(usePerDay).length) {
    const sum = Math.round(Object.values(usePerDay).reduce((a, x) => a + x, 0) * 100) / 100;
    const drift = Math.round((sum - hours) * 100) / 100;
    // 逐日相加必须等于月报口径。不等就说明日报没读全（页面是虚拟滚动，少一屏就少几天），
    // 这时候**绝不能**拿残缺的方案去填 —— 宁可按工作日平摊，也不能漏填。
    if (Math.abs(drift) > 0.01) {
      log(`[fill] 逐日合计 ${sum}h 与月报口径 ${hours}h 差 ${drift}h，说明日报没读全，改回按工作日平摊`);
      result.dailyRejected = { sum, expected: hours, drift };
      usePerDay = null;
    }
  }
  const plan = buildBatchPlan(hours, targetDates, batch.workdaysOnly !== false, config.rule.hoursPerDay, usePerDay);
  result.plan = plan;
  result.planSource = plan.length ? plan[0].planSource : null;
  if (plan.length && plan[0].planSource === 'daily') {
    result.planSum = plan[0].planSum;
    // 逐日相加必须等于月报口径，否则说明日报没读全，得如实报出来
    result.planDrift = Math.round((plan[0].planSum - hours) * 10000) / 10000;
    mark(`逐日方案：${plan.length} 格，合计 ${plan[0].planSum}h（月报口径 ${hours}h，差 ${result.planDrift}h）`);
  }

  // 5) 逐格填：点格子 → 等 popover 并核对「登记日期」→ 写 #realActWorkHour → 失焦
  mark('开始逐格填，共 ' + plan.length + ' 格');
  for (const item of plan) {
    const step = { date: item.date, hours: item.hours };
    let g = await evalIn(cdp, ctx.sessionId, `(${batchReadGrid.toString()})()`, ctx.contextId);
    let dayIdx = g.days.findIndex((d) => d.date === item.date);
    if (dayIdx < 0) { step.ok = false; step.error = '表头里没有这一天'; result.cells.push(step); continue; }

    if (dayIdx >= 8 || dayIdx + 4 >= g.rows[rowIndex].cellRects.length) {
      const sc = await evalIn(cdp, ctx.sessionId, `(${batchScrollToDate.toString()})(${JSON.stringify(item.date)})`, ctx.contextId);
      step.scroll = sc;
      await sleep(900);
      g = await evalIn(cdp, ctx.sessionId, `(${batchReadGrid.toString()})()`, ctx.contextId);
      dayIdx = g.days.findIndex((d) => d.date === item.date);
    }

    const cell = g.rows[rowIndex].cellRects[dayIdx + 4];
    if (!cell) { step.ok = false; step.error = '拿不到该格坐标'; result.cells.push(step); continue; }
    const cx = cell.x + Math.round(cell.w / 2);
    const cy = cell.y + Math.round(cell.h / 2);
    step.point = { x: cx, y: cy };
    step.cellBefore = g.rows[rowIndex].dayTexts[dayIdx] ?? null;

    mark('点格子 ' + item.date + ' at(' + cx + ',' + cy + ')');
    await clickAt(cdp, ctx.sessionId, cx, cy);
    // 等一个「稳定且已绑定目标日期」的 popover —— 关闭中的旧 popover 会把值写到别的格子
    let bound = null;
    for (let i = 0; i < 12; i += 1) {
      await sleep(400);
      const gg = await evalIn(cdp, ctx.sessionId, `(${batchReadGrid.toString()})()`, ctx.contextId);
      if (gg.editor && gg.popover && gg.popover.date === item.date) { bound = gg.popover; break; }
    }
    if (!bound) {
      step.ok = false;
      step.error = '点开格子后没能确认 popover 绑定到目标日期';
      result.cells.push(step);
      continue;
    }
    const setRes = await evalIn(cdp, ctx.sessionId, `(${batchSetHour.toString()})(${item.hours})`, ctx.contextId);
    step.set = setRes;
    await sleep(300);
    // 失焦确认：先真的点一下弹窗标题区（人工就是这个动作）
    const dialog = await evalIn(cdp, ctx.sessionId, `(() => {
      const d = [...document.querySelectorAll('[role="dialog"],[class*="ant-modal"]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 200 && r.height > 200; })[0];
      if (!d) return null;
      const r = d.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 28) };
    })()`, ctx.contextId);
    if (dialog) await clickAt(cdp, ctx.sessionId, dialog.x, dialog.y);
    await sleep(1300);

    const after = await evalIn(cdp, ctx.sessionId, `(${batchReadGrid.toString()})()`, ctx.contextId);
    const cellAfter = after.rows[rowIndex] ? (after.rows[rowIndex].dayTexts[dayIdx] ?? null) : null;
    step.cellAfter = cellAfter;
    step.totalAfter = after.rows[rowIndex] ? after.rows[rowIndex].total : null;
    step.ok = cellAfter !== null && Math.abs(Number(cellAfter) - item.hours) < 0.0001;
    if (!step.ok) step.error = `格子里现在是 ${JSON.stringify(cellAfter)}，期望 ${item.hours}`;
    result.cells.push(step);
  }

  result.filledCount = result.cells.filter((c) => c.ok).length;
  result.filledHours = Math.round(result.cells.filter((c) => c.ok).reduce((s, c) => s + c.hours, 0) * 10000) / 10000;
  result.fillErrors = result.cells.filter((c) => !c.ok).map((c) => ({ date: c.date, error: c.error }));

  const lastGrid = await evalIn(cdp, ctx.sessionId, `(${batchReadGrid.toString()})()`, ctx.contextId);
  result.pendingHours = lastGrid.pendingHours;
  result.remainingHours = lastGrid.remainingHours;

  if (submit) {
    result.submitted = await clickByText(config.meego.submitButtonText ?? '提交审批', 'click-submit');
  }
  return result;
}

/** 在所有 frame 里找第一个含指定文字的 frame。 */
async function findFrameWithText(cdp, sessionId, text) {
  for (const c of await frameContexts(cdp, sessionId)) {
    try {
      const has = await evalIn(cdp, c.sessionId, `(() => (document.body ? document.body.innerText : '').includes(${JSON.stringify(text)}))()`, c.contextId);
      if (has) return c;
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * 轮询所有 frame，返回第一个让表达式得到「真值」的 frame 与结果。
 * 用它而不是「先按文字找一个 frame」：antd 会在外层 frame 里留一份隐藏的弹窗 DOM，
 * 只按文字找很容易选中那份隐藏的，然后所有可见性判定都会失败。
 */
async function pollFrameWithValue(cdp, sessionId, expr, { timeoutMs = 25000, intervalMs = 1000, preferUrl } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const c of await frameContexts(cdp, sessionId, { preferUrl })) {
      try {
        const v = await evalIn(cdp, c.sessionId, expr, c.contextId);
        if (v) return { ctx: c, value: v };
      } catch { /* ignore */ }
    }
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

async function cmdFill(args, config, workspace) {
  if (isPlaceholderUrl(config.attendance.url)) return placeholderResult('fill', 'attendance.url', workspace);
  if (isPlaceholderUrl(config.meego.url)) return placeholderResult('fill', 'meego.url', workspace);
  const commit = args.commit === true;
  const submit = args.submit === true || config.meego.submit === true;

  let days = args.days !== undefined && args.days !== true ? Number(args.days) : null;
  let readInfo = null;
  let perDayMap = null;

  return withBrowser(config, async (cdp) => {
    // 1) 先取出勤天数
    if (days === null) {
      log('[fill] 读取 iTalent 出勤天数…');
      const preferUrl = config.attendance.frameUrlIncludes;
      // 跟 read 一样：优先复用用户已经打开的月报标签页（正文所在 widget iframe 在新标签页里是空的）
      let attTab = null;
      if (config.attendance.reuseTab !== false) {
        attTab = await findTab(cdp, ['attendance', preferUrl || 'italent.cn']);
        if (attTab) log(`[fill] 复用已打开的月报标签页：${String(attTab.url).slice(0, 90)}`);
      }
      const attOpenedHere = !attTab;
      if (!attTab) {
        attTab = await openTab(cdp, config.attendance.url);
        await waitForLoad(cdp, attTab.sessionId, { settleMs: 2500 });
      }
      await waitForFrame(cdp, attTab.sessionId, preferUrl, { timeoutMs: config.attendance.frameWaitMs ?? 15000 });
      const expr = `(${attendanceLookup.toString()})(${JSON.stringify(config.attendance.label)}, ${JSON.stringify(config.attendance.labelMatch)}, ${JSON.stringify(monthTokens())}, ${JSON.stringify(config.attendance.valueSelector)}, ${JSON.stringify(config.attendance.decimals)})`;
      const results = await pollFrames(cdp, attTab.sessionId, expr, preferUrl, config.attendance.renderWaitMs ?? 30000);
      const best = results.find((r) => r.value && r.value.found);
      let probes = null;
      if (!best) {
        const raw = await collectFrames(cdp, attTab.sessionId, labelProbeExpr(config.attendance.label), { preferUrl });
        probes = raw
          .filter((r) => r.value && Array.isArray(r.value.hits) && r.value.hits.length > 0)
          .map((r) => ({ frameUrl: r.frameUrl, preferred: r.preferred === true, hits: r.value.hits.slice(0, 8) }));
      }
      if (attOpenedHere) await closeTab(cdp, attTab.targetId);
      if (!best) {
        const login = looksLikeLogin(results);
        return {
          ok: false,
          command: 'fill',
          stage: 'read-attendance',
          error: login ? 'iTalent 跳转到了登录页，登录态已失效' : '没能从 iTalent 读到「出勤天数」',
          attendanceTab: { reused: !attOpenedHere, url: attTab.url },
          frames: results.map((r) => ({
            via: r.via,
            frameUrl: r.frameUrl,
            found: Boolean(r.value && r.value.found),
            error: r.error,
            attendanceTexts: r.value?.attendanceTexts,
            matchedBy: r.value?.matchedBy,
          })),
          probes,
          hint: login
            ? '请先运行 probe 重新登录一次，再执行 fill。'
            : (attOpenedHere
              ? '这次是 driver 自己新开的月报标签页，正文所在的 widget iframe 在新标签页里经常是空的。'
                + '请在浏览器里点开「我的假勤 → 我的月报」让它渲染出来，再重跑（会自动复用你那个标签页）。'
              : '先看 frames[].attendanceTexts（页面里所有含「出勤天数」的表头文字）把 attendance.label 改对；'
                + '文字本来就对的话，再用 probes 里的 cssPath 填 attendance.valueSelector。'),
        };
      }
      days = best.value.days;
      readInfo = { source: best.value.source, matchedRow: best.value.matchedRow, matchedMonth: best.value.matchedMonth, frameUrl: best.frameUrl, candidates: best.value.candidates };

      // 1b) 逐日明细（可选）：月报只给整月一个数，逐日才看得出哪天请假、哪个周末调休上班
      const wantDaily = args.daily === true || config.attendance.dailyDetail === true;
      if (wantDaily && readInfo.matchedMonth) {
        log(`[fill] 读 ${readInfo.matchedMonth} 的日报逐日明细（页面滚动很慢，可能要几分钟）…`);
        const daily = await readDailyDetail(cdp, attTab.sessionId, readInfo.matchedMonth);
        if (daily.ok) {
          perDayMap = {};
          for (const d of daily.days) {
            const h = d.hours != null && d.hours > 0
              ? Math.round(d.hours * 100) / 100
              : (d.statDays > 0 ? Math.round(d.statDays * config.rule.hoursPerDay * 100) / 100 : 0);
            if (h > 0) perDayMap[d.date] = h;
          }
          readInfo.daily = {
            complete: daily.complete,
            days: daily.days.length,
            hoursColumn: daily.hoursColumn ?? null,
            covered: `${daily.days[0].date}~${daily.days[daily.days.length - 1].date}`,
            sumStatDays: Math.round(daily.days.reduce((a, x) => a + (x.statDays || 0), 0) * 10000) / 10000,
            sumHours: Math.round(Object.values(perDayMap).reduce((a, x) => a + x, 0) * 100) / 100,
            planDates: Object.keys(perDayMap).length,
          };
          log(`[fill] 日报逐日：${readInfo.daily.covered}，${readInfo.daily.planDates} 天有出勤，合计 ${readInfo.daily.sumHours}h（月报口径 ${Math.round(days * config.rule.hoursPerDay * 100) / 100}h）`);
        } else {
          log(`[fill] 日报逐日没读成（${daily.error}），退回按工作日平摊`);
          readInfo.daily = { ok: false, error: daily.error };
        }
      }
    }

    const hours = Math.round(days * config.rule.hoursPerDay * 100) / 100;
    const fillMode = String((args.mode && args.mode !== true ? args.mode : '') || config.meego.mode || 'single').toLowerCase();

    // 2) 预览模式：不碰页面，直接给结论
    if (!commit) {
      return {
        ok: true,
        command: 'fill',
        mode: 'preview',
        fillMode,
        days,
        hoursPerDay: config.rule.hoursPerDay,
        hours,
        attendance: readInfo,
        wouldWrite: fillMode === 'batch'
          ? {
            url: config.meego.url,
            flow: `${config.meego.registerButtonText ?? '工时登记'} → ${config.meego.batchModeText ?? '批量登记'}`,
            value: hours,
            spread: perDayMap
              ? '按日报逐日填：每天的「实际出勤工时」，只填有出勤的天（请假/节假日/未打卡不填）'
              : `${config.meego.batch?.workdaysOnly === false ? '含周末' : '只填工作日'}，每个工作日 ${config.rule.hoursPerDay}h，余数落在最后一个工作日`,
            row: config.meego.batch?.rowMatch ? `匹配 /${config.meego.batch.rowMatch}/ 的那一行` : '第一行',
            submit,
            ...(perDayMap ? { plan: Object.keys(perDayMap).sort().map((d) => ({ date: d, hours: perDayMap[d] })) } : {}),
          }
          : {
            url: config.meego.url,
            flow: `${config.meego.registerButtonText ?? '工时登记'} → ${config.meego.registerModeText ?? '单项登记'}`,
            hoursInputSelector: config.meego.hoursInputSelector ?? '#basic_actWorkHour',
            value: hours,
            submit,
          },
        hint: submit
          ? '这是预览，没有改任何东西。确认无误后加 --commit 真正写入（--commit 也会提交）。'
          : '这是预览，没有改任何东西。确认无误后加 --commit 打开弹窗并填好工时（仍不会提交，需你手动点「提交审批」）。',
      };
    }

    // 3) 批量登记分支：工时登记 → 批量登记 → 选类型/实例 → 定范围 → 逐格填
    if (fillMode === 'batch') {
      const preferUrlB = config.meego.frameUrlIncludes;
      const batchTab = await openTab(cdp, config.meego.url);
      await waitForLoad(cdp, batchTab.sessionId, { settleMs: config.meego.settleMs });
      const frameWaitB = await waitForFrame(cdp, batchTab.sessionId, preferUrlB, {
        timeoutMs: config.meego.frameWaitMs ?? 15000,
      });

      const stepsB = [];
      const clickByTextB = async (text, stepName, waitMs) => {
        // 轮询等待：冷启动/首屏时插件按钮要晚几秒才渲染出来，找一次就放弃会误判成「没有这个按钮」。
        // 同时做命中测试：页面还在转圈（ant-spin 遮罩）时点了没反应，要等遮罩消失再点。
        const expr = `(${meegoFindClickable.toString()})(${JSON.stringify(text)})`;
        const budget = waitMs ?? config.meego.clickWaitMs ?? 25000;
        const deadline = Date.now() + budget;
        let lastCoveredBy = null;
        for (;;) {
          const hit = await findInFrames(cdp, batchTab.sessionId, expr, preferUrlB);
          if (hit && hit.point && hit.point.hitTest) {
            const clicked = await clickAt(cdp, hit.ctx.sessionId, hit.point.x, hit.point.y);
            stepsB.push({ step: stepName, text, ok: true, via: hit.ctx.via, frameUrl: hit.ctx.frameUrl, point: { x: hit.point.x, y: hit.point.y }, clickMs: clicked.elapsedMs });
            return true;
          }
          if (hit && hit.point) lastCoveredBy = hit.point.coveredBy || null;
          if (Date.now() >= deadline) {
            stepsB.push({
              step: stepName,
              text,
              ok: false,
              error: hit
                ? `找到了「${text}」但一直被别的东西盖住（最上层=${lastCoveredBy}），没能点下去`
                : `等了 ${budget}ms 也没找到该文字对应的可点元素`,
            });
            return false;
          }
          await sleep(700);
        }
      };

      log('[fill] 批量登记：工时登记 → 批量登记');
      // 首屏还在加载时布局会漂移，算好的坐标可能一两百毫秒后就偏了 —— 所以点完要校验效果，
      // 菜单没弹出来就把「工时登记」再点一轮（最多 3 轮）。
      const btnText = config.meego.registerButtonText ?? '工时登记';
      const modeText = config.meego.batchModeText ?? '批量登记';
      let opened = await clickByTextB(btnText, 'click-register-button');
      let modeOk = false;
      if (opened) {
        await sleep(1200);
        modeOk = await clickByTextB(modeText, 'click-register-mode', 8000);
        for (let round = 1; round <= 2 && !modeOk; round += 1) {
          log(`[fill] 菜单没弹出来，第 ${round} 次重试点「${btnText}」`);
          opened = await clickByTextB(btnText, `click-register-button-retry${round}`, 8000);
          if (!opened) break;
          await sleep(1200);
          modeOk = await clickByTextB(modeText, `click-register-mode-retry${round}`, 8000);
        }
      }
      let batchRes = null;
      if (modeOk) {
        await sleep(1200);
        batchRes = await runBatchFill({
          cdp,
          config,
          hours,
          readInfo,
          submit,
          preferUrl: preferUrlB,
          steps: stepsB,
          clickByText: clickByTextB,
          meegoSessionId: batchTab.sessionId,
          perDayMap,
        });
      } else {
        batchRes = { mode: 'batch', fatal: modeOk ? '批量登记流程中断' : '没点开「批量登记」（工时登记 的下拉菜单没弹出来）' };
      }
      // 连按钮都没点到时，把每个 frame 的实况带回去（最常见的原因是没登录 / 页面没渲染完）
      if (!modeOk) {
        batchRes.frames = [];
        for (const c of await frameContexts(cdp, batchTab.sessionId, { preferUrl: preferUrlB })) {
          const row = { via: c.via, url: String(c.frameUrl || '').slice(0, 80) };
          try {
            const d = await evalIn(cdp, c.sessionId, `(() => {
              const t = document.body ? document.body.innerText : '';
              return { chars: t.length, hasRegister: t.includes('工时登记'), hasLogin: /登录|扫码|sign in/i.test(t), head: t.replace(/\\s+/g, ' ').slice(0, 120) };
            })()`, c.contextId);
            Object.assign(row, d);
          } catch (e) { row.err = String(e?.message || e).slice(0, 60); }
          batchRes.frames.push(row);
        }
      }

      try { await screenshot(cdp, batchTab.sessionId, path.join(config.probe.outDir, 'meego-after-batch.png')); } catch { /* 忽略 */ }

      const filledOk = (batchRes.filledCount || 0) > 0;
      return {
        ok: filledOk && !batchRes.fatal,
        command: 'fill',
        mode: 'batch',
        days,
        hoursPerDay: config.rule.hoursPerDay,
        hours,
        attendance: readInfo,
        steps: stepsB,
        batch: batchRes,
        submitted: batchRes.submitted === true,
        keptOpen: true,
        frameWait: frameWaitB,
        fatal: batchRes.fatal || null,
        hint: batchRes.fatal
          ? `${batchRes.fatal}（批量登记的数据行来自「添加已有工作实例/节点/任务」，取决于你本人的排期）`
          : (filledOk
            ? `已填 ${batchRes.filledCount}/${batchRes.plan.length} 格、合计 ${batchRes.filledHours} 小时，**没有提交** —— 请核对后自己点「提交审批」。`
            : '一格格都没填成功，请看 batch.cells 里的 cellBefore/cellAfter 与 fillErrors。'),
      };
    }

    // 4) 真正写入 Meego（单项登记）：先点开「工时登记 → 单项登记」弹窗，再在弹窗里填工时。
    //    注意按钮在看板 frame，而弹窗由**另一个** iframe 渲染，所以必须跨 frame 操作。
    const buttonText = config.meego.registerButtonText ?? '工时登记';
    const modeText = config.meego.registerModeText ?? '单项登记';
    const hoursInputSelector = config.meego.hoursInputSelector ?? '#basic_actWorkHour';
    log(`[fill] 打开登记弹窗：${buttonText} → ${modeText}`);

    const preferUrl = config.meego.frameUrlIncludes;
    const meegoTab = await openTab(cdp, config.meego.url);
    await waitForLoad(cdp, meegoTab.sessionId, { settleMs: config.meego.settleMs });
    // 自定义插件页在跨域 iframe 里异步挂载，先等它出现再动手
    const frameWait = await waitForFrame(cdp, meegoTab.sessionId, preferUrl, {
      timeoutMs: config.meego.frameWaitMs ?? 15000,
    });

    const steps = [];
    // 跟批量那条一样：轮询等元素出现 + 命中测试等遮罩消失，避免「页面还在转圈就点」。
    const clickByText = async (text, stepName) => {
      const expr = `(${meegoFindClickable.toString()})(${JSON.stringify(text)})`;
      const deadline = Date.now() + (config.meego.clickWaitMs ?? 25000);
      let lastCoveredBy = null;
      for (;;) {
        const hit = await findInFrames(cdp, meegoTab.sessionId, expr, preferUrl);
        if (hit && hit.point && hit.point.hitTest) {
          const clicked = await clickAt(cdp, hit.ctx.sessionId, hit.point.x, hit.point.y);
          steps.push({ step: stepName, text, ok: true, via: hit.ctx.via, frameUrl: hit.ctx.frameUrl, point: { x: hit.point.x, y: hit.point.y }, clickMs: clicked.elapsedMs });
          return true;
        }
        if (hit && hit.point) lastCoveredBy = hit.point.coveredBy || null;
        if (Date.now() >= deadline) {
          steps.push({
            step: stepName,
            text,
            ok: false,
            error: hit
              ? `找到了「${text}」但一直被别的东西盖住（最上层=${lastCoveredBy}），没能点下去`
              : `等了 ${config.meego.clickWaitMs ?? 25000}ms 也没找到该文字对应的可点元素`,
          });
          return false;
        }
        await sleep(700);
      }
    };

    let ok = await clickByText(buttonText, 'click-register-button');
    if (ok) {
      await sleep(1200);
      ok = await clickByText(modeText, 'click-register-mode');
    }

    let filled = null;
    let modal = null;
    if (ok) {
      modal = await waitForModal(cdp, meegoTab.sessionId, hoursInputSelector, config.meego.modalWaitMs ?? 20000, preferUrl);
      if (modal.ctx) {
        const expr = `(${meegoSetValue.toString()})(${JSON.stringify(hoursInputSelector)}, ${JSON.stringify(hours)}, ${JSON.stringify(config.meego.workDateSelector ?? null)}, ${JSON.stringify(config.meego.workDate ?? null)})`;
        try {
          filled = await evalIn(cdp, modal.ctx.sessionId, expr, modal.ctx.contextId);
        } catch (e) {
          filled = { hoursFilled: false, note: `填值失败：${String(e?.message || e)}` };
        }
      }
    }

    // 只有显式要求才提交；默认留给你人工核对后自己点「提交审批」
    let submitted = false;
    if (submit && filled && filled.hoursFilled) {
      submitted = await clickByText(config.meego.submitButtonText ?? '提交审批', 'click-submit');
    }

    try { await screenshot(cdp, meegoTab.sessionId, path.join(config.probe.outDir, 'meego-after-fill.png')); } catch { /* 忽略 */ }

    const wrote = Boolean(filled && filled.hoursFilled);
    return {
      ok: wrote,
      command: 'fill',
      mode: 'commit',
      days,
      hoursPerDay: config.rule.hoursPerDay,
      hours,
      attendance: readInfo,
      steps,
      modal: modal ? { found: Boolean(modal.ctx), timedOut: modal.timedOut === true, frameUrl: modal.ctx ? modal.ctx.frameUrl : null } : null,
      filled: filled || null,
      submitted,
      // 弹窗刻意留在页面上，方便你核对后手动提交，所以这里不关标签页
      keptOpen: true,
      frameWait,
      hint: wrote
        ? (submitted
          ? '已填写并提交。请人工核对页面上的数值与提交状态。'
          : '已把工时填进弹窗，但**没有提交** —— 请你在页面上核对后自己点「提交审批」。')
        : (filled && filled.note) || '没能在弹窗里填上工时，请看上面的 steps / modal，确认失败在哪一步。',
    };
  });
}

/* ------------------------------------------------------------------ 入口 */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'help';
  const workspace = args.workspace && args.workspace !== true ? args.workspace : process.cwd();
  const config = loadConfig(args.config && args.config !== true ? args.config : null, workspace);

  log(`[workhours] command=${command} workspace=${workspace}`);

  let result;
  switch (command) {
    case 'probe': result = await cmdProbe(args, config, workspace); break;
    case 'read': result = await cmdRead(args, config, workspace); break;
    case 'fill': result = await cmdFill(args, config, workspace); break;
    default:
      result = {
        ok: false,
        command: 'help',
        usage: [
          'node driver.mjs probe [--out DIR] [--only attendance|meego] [--no-wait] [--workspace DIR]',
          'node driver.mjs read  [--workspace DIR] [--config FILE] [--daily]',
          'node driver.mjs fill  [--workspace DIR] [--config FILE] [--days N] [--commit] [--submit] [--daily]',
          'node driver.mjs fill  [--workspace DIR] [--commit] [--mode batch] [--submit] [--daily]   # 批量：逐格填；--daily 按日报逐日出勤填',
        ],
      };
  }

  // 结果写完后必须显式退出：复用已有浏览器时 CDP 的 WebSocket 不会自己断开，
  // 不退出的话事件循环会一直挂住，调用方（插件工具 / 脚本）就永远等不到结束。
  await new Promise((resolve) => process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(result)}\n`, resolve));
  process.exit(0);
}

main().catch(async (err) => {
  const result = { ok: false, command: process.argv[2] || 'unknown', error: String(err?.stack || err?.message || err) };
  await new Promise((resolve) => process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(result)}\n`, resolve));
  process.exit(1);
});