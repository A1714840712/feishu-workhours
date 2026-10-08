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
  ensureBrowser, openTab, closeTab, waitForLoad, screenshot,
  collectFrames, actInFrames, waitForFrame, sleep,
} from './cdp.mjs';
import { INVENTORY_EXPR, HTML_EXPR, INTERACTABLES_EXPR, labelProbeExpr } from './extract.mjs';

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
    meego: { ...defaults.meego, ...(user?.meego || {}) },
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
          };
        }
      }
    } catch { /* 选择器非法，继续走启发式 */ }
  }

  const candidates = [];
  // 精确匹配优先：「出勤天数」绝不能被子串「应出勤天数」抢走
  const exactEls = [];
  const looseEls = [];
  for (const el of document.querySelectorAll('th,td,div,span,label,dt,dd,p,a')) {
    if (el.children.length > 0) continue;
    const t = textOf(el);
    if (!t || t.length > 30) continue;
    if (t === label) exactEls.push(el);
    else if (matchMode !== 'exact' && t.includes(label)) looseEls.push(el);
  }
  const labelEls = exactEls.length ? exactEls : looseEls;
  const matchedExactly = exactEls.length > 0;

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
    return { found: false, days: null, labelElementCount: labelEls.length, matchedExactly, candidates };
  }

  // 3) 选行：优先含当前月份的行，否则取第一条
  const byMonth = candidates.find((c) => c.rowText && tokens.some((t) => c.rowText.includes(t)));
  const chosen = byMonth || candidates[0];
  return {
    found: true,
    days: chosen.days,
    source: chosen.via,
    matchedRow: byMonth ? 'current-month' : 'first-candidate',
    candidates,
    labelElementCount: labelEls.length,
    matchedExactly,
  };
}

/** 在 Meego 工时页里定位「工时」输入框并写入数值；返回 null 表示本帧没命中。 */
function meegoFill(label, inputSelector, value, submit, submitSelector) {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const textOf = (el) => norm(el && (el.innerText || el.textContent));
  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let cur = el;
    for (let d = 0; cur && cur.nodeType === 1 && d < 5; d += 1) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(part + '#' + cur.id); break; }
      const raw = typeof cur.className === 'string' ? cur.className : '';
      part += raw.split(/\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c).join('');
      const p = cur.parentElement;
      if (p) {
        const sibs = Array.from(p.children).filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };

  const editable = (el) => el && (
    el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true
  ) && !el.disabled && !el.readOnly;

  let target = null;
  let how = null;

  // 0) 显式选择器
  if (inputSelector) {
    try {
      const el = document.querySelector(inputSelector);
      if (editable(el)) { target = el; how = 'inputSelector'; }
    } catch { /* 忽略非法选择器 */ }
  }

  // 1) 按可见文字「工时」找最近的输入框
  if (!target) {
    const labelEls = [];
    for (const el of document.querySelectorAll('th,td,div,span,label,dt,dd,p,a')) {
      if (el.children.length > 0) continue;
      const t = textOf(el);
      if (!t) continue;
      if (t === label || (t.length <= 30 && t.includes(label))) labelEls.push(el);
    }
    for (const le of labelEls) {
      // 同一个单元格 / 同一个父容器内找
      const scope = le.closest('td,th,[role="gridcell"],[role="cell"]') || le.parentElement;
      if (scope) {
        const near = Array.from(scope.querySelectorAll('input,textarea,[contenteditable="true"]')).filter(editable);
        if (near.length) { target = near[0]; how = 'label-scope'; break; }
      }
      // 往后的几个兄弟节点里找
      let cur = le;
      for (let i = 0; i < 4 && cur && !target; i += 1) {
        cur = cur.parentElement;
        if (!cur) break;
        const near = Array.from(cur.querySelectorAll('input,textarea,[contenteditable="true"]')).filter(editable);
        if (near.length) { target = near[0]; how = 'label-ancestor'; }
      }
      if (target) break;
    }
  }

  // 2) 兜底：整页范围里第一个可见的可编辑数字框
  if (!target) {
    const all = Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]'))
      .filter((el) => editable(el) && visible(el));
    const numeric = all.find((el) => {
      const ty = (el.getAttribute('type') || '').toLowerCase();
      const ph = (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '');
      return ty === 'number' || /工时|小时|hour|时长/.test(ph);
    });
    if (numeric) { target = numeric; how = 'fallback-numeric'; }
  }

  if (!target) return null;

  const before = target.value !== undefined ? target.value : textOf(target);
  const text = String(value);

  // React/Vue 会拦截直接赋值，必须走原生 setter + 派发事件
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    const proto = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(target, text);
    else target.value = text;
  } else {
    target.textContent = text;
  }
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
  target.dispatchEvent(new Event('blur', { bubbles: true }));

  const after = target.value !== undefined ? target.value : textOf(target);

  // 提交：显式选择器优先；没配就按可见文字兜底。只在配置显式要求 submit 时才会点。
  const SUBMIT_WORDS = ['提交', '保存', '确定', '保存并提交', '提交工时'];
  let submitted = false;
  let submitHow = null;
  let submitText = null;
  if (submit) {
    let btn = null;
    if (submitSelector) {
      try {
        const el = document.querySelector(submitSelector);
        if (el && visible(el) && !el.disabled) { btn = el; submitHow = 'submitSelector'; }
      } catch { /* 选择器非法，退回按文字找 */ }
    }
    if (!btn) {
      const cands = Array.from(
        document.querySelectorAll('button,[role="button"],a,input[type="submit"],input[type="button"]'),
      ).filter((el) => visible(el) && !el.disabled);
      const label = (el) => textOf(el) || norm(el.value);
      btn = cands.find((el) => SUBMIT_WORDS.includes(label(el)))
        || cands.find((el) => SUBMIT_WORDS.some((w) => label(el).includes(w)));
      if (btn) submitHow = 'text';
    }
    if (btn) { submitText = textOf(btn) || norm(btn.value) || null; btn.click(); submitted = true; }
    else submitHow = 'not-found';
  }

  return {
    how,
    path: cssPath(target),
    tag: target.tagName.toLowerCase(),
    type: target.getAttribute('type') || undefined,
    placeholder: target.getAttribute('placeholder') || undefined,
    before: norm(before),
    after: norm(after),
    wrote: norm(after) === text,
    submitted,
    submitHow,
    submitText,
    frameUrl: location.href,
  };
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

async function cmdRead(args, config, workspace) {
  if (isPlaceholderUrl(config.attendance.url)) return placeholderResult('read', 'attendance.url', workspace);
  const expr = `(${attendanceLookup.toString()})(${JSON.stringify(config.attendance.label)}, ${JSON.stringify(config.attendance.labelMatch)}, ${JSON.stringify(monthTokens())}, ${JSON.stringify(config.attendance.valueSelector)}, ${JSON.stringify(config.attendance.decimals)})`;

  return withBrowser(config, async (cdp) => {
    const preferUrl = config.attendance.frameUrlIncludes;
    const tab = await openTab(cdp, config.attendance.url);
    await waitForLoad(cdp, tab.sessionId, { settleMs: 2500 });
    const frameWait = await waitForFrame(cdp, tab.sessionId, preferUrl, {
      timeoutMs: config.attendance.frameWaitMs ?? 15000,
    });
    const results = await collectFrames(cdp, tab.sessionId, expr, { preferUrl });

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
    await closeTab(cdp, tab.targetId);

    return {
      ok: Boolean(best),
      command: 'read',
      days: best ? best.value.days : null,
      hours,
      hoursPerDay: config.rule.hoursPerDay,
      source: best ? best.value.source : null,
      matchedRow: best ? best.value.matchedRow : null,
      frameUrl: best ? best.frameUrl : null,
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
      })),
      hint: best
        ? null
        : (looksLikeLogin(results)
          ? '页面被重定向到了登录页 —— 浏览器里的登录态已失效。请先运行 probe 重新登录一次。'
          : '没找到「出勤天数」。请看下面的 probes：它列出了页面上含「出勤天数」的元素及其 cssPath，选出正确那个填进 attendance.valueSelector。'),
    };
  });
}

async function cmdFill(args, config, workspace) {
  if (isPlaceholderUrl(config.attendance.url)) return placeholderResult('fill', 'attendance.url', workspace);
  if (isPlaceholderUrl(config.meego.url)) return placeholderResult('fill', 'meego.url', workspace);
  const commit = args.commit === true;
  const submit = args.submit === true || config.meego.submit === true;

  let days = args.days !== undefined && args.days !== true ? Number(args.days) : null;
  let readInfo = null;

  return withBrowser(config, async (cdp) => {
    // 1) 先取出勤天数
    if (days === null) {
      log('[fill] 读取 iTalent 出勤天数…');
      const preferUrl = config.attendance.frameUrlIncludes;
      const attTab = await openTab(cdp, config.attendance.url);
      await waitForLoad(cdp, attTab.sessionId, { settleMs: 2500 });
      await waitForFrame(cdp, attTab.sessionId, preferUrl, { timeoutMs: config.attendance.frameWaitMs ?? 15000 });
      const expr = `(${attendanceLookup.toString()})(${JSON.stringify(config.attendance.label)}, ${JSON.stringify(config.attendance.labelMatch)}, ${JSON.stringify(monthTokens())}, ${JSON.stringify(config.attendance.valueSelector)}, ${JSON.stringify(config.attendance.decimals)})`;
      const results = await collectFrames(cdp, attTab.sessionId, expr, { preferUrl });
      const best = results.find((r) => r.value && r.value.found);
      let probes = null;
      if (!best) {
        const raw = await collectFrames(cdp, attTab.sessionId, labelProbeExpr(config.attendance.label), { preferUrl });
        probes = raw
          .filter((r) => r.value && Array.isArray(r.value.hits) && r.value.hits.length > 0)
          .map((r) => ({ frameUrl: r.frameUrl, preferred: r.preferred === true, hits: r.value.hits.slice(0, 8) }));
      }
      await closeTab(cdp, attTab.targetId);
      if (!best) {
        const login = looksLikeLogin(results);
        return {
          ok: false,
          command: 'fill',
          stage: 'read-attendance',
          error: login ? 'iTalent 跳转到了登录页，登录态已失效' : '没能从 iTalent 读到「出勤天数」',
          probes,
          hint: login
            ? '请先运行 probe 重新登录一次，再执行 fill。'
            : '看上面的 probes（含该标签的元素及其 cssPath），把正确那个写进 attendance.valueSelector。',
        };
      }
      days = best.value.days;
      readInfo = { source: best.value.source, matchedRow: best.value.matchedRow, frameUrl: best.frameUrl, candidates: best.value.candidates };
    }

    const hours = Math.round(days * config.rule.hoursPerDay * 100) / 100;

    // 2) 预览模式：不碰页面，直接给结论
    if (!commit) {
      return {
        ok: true,
        command: 'fill',
        mode: 'preview',
        days,
        hoursPerDay: config.rule.hoursPerDay,
        hours,
        attendance: readInfo,
        wouldWrite: { url: config.meego.url, label: config.meego.label, inputSelector: config.meego.inputSelector, value: hours, submit },
        hint: '这是预览，没有改任何东西。确认无误后加 --commit 真正写入。',
      };
    }

    // 3) 真正写入 Meego
    log(`[fill] 写入 Meego：${days} 天 × ${config.rule.hoursPerDay} = ${hours} 小时`);
    const preferUrl = config.meego.frameUrlIncludes;
    const meegoTab = await openTab(cdp, config.meego.url);
    await waitForLoad(cdp, meegoTab.sessionId, { settleMs: config.meego.settleMs });
    // 自定义插件页在跨域 iframe 里异步挂载，先等它出现再动手
    const frameWait = await waitForFrame(cdp, meegoTab.sessionId, preferUrl, {
      timeoutMs: config.meego.frameWaitMs ?? 15000,
    });

    const action = `(${meegoFill.toString()})(${JSON.stringify(config.meego.label)}, ${JSON.stringify(config.meego.inputSelector)}, ${JSON.stringify(hours)}, ${JSON.stringify(submit)}, ${JSON.stringify(config.meego.submitSelector)})`;
    const acted = await actInFrames(cdp, meegoTab.sessionId, action, { preferUrl });

    // 没命中时列出每个 frame 里的可编辑元素与按钮，直接给出可写进配置的选择器
    let interactables = null;
    if (!acted.hit) {
      const raw = await collectFrames(cdp, meegoTab.sessionId, INTERACTABLES_EXPR, { preferUrl });
      interactables = raw.map((r) => ({
        frameUrl: r.frameUrl,
        preferred: r.preferred === true,
        error: r.error,
        editables: r.value?.editables ?? [],
        buttons: r.value?.buttons ?? [],
      }));
    }

    try { await screenshot(cdp, meegoTab.sessionId, path.join(config.probe.outDir, 'meego-after-fill.png')); } catch { /* 忽略 */ }
    await closeTab(cdp, meegoTab.targetId);

    return {
      ok: acted.hit,
      command: 'fill',
      mode: 'commit',
      days,
      hoursPerDay: config.rule.hoursPerDay,
      hours,
      attendance: readInfo,
      wrote: acted.hit ? acted.value : null,
      frameUrl: acted.frameUrl,
      frameWait,
      attempts: acted.attempts,
      interactables,
      hint: acted.hit
        ? '已写入。请人工核对页面上的数值与提交状态。'
        : '没能在 Meego 页面定位到工时输入框。请看上面的 interactables：它列出了每个 frame 的可编辑元素与按钮，把正确那个的 cssPath 写进 meego.inputSelector（必要时再配 meego.submitSelector）。',
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
          'node driver.mjs read  [--workspace DIR] [--config FILE]',
          'node driver.mjs fill  [--workspace DIR] [--config FILE] [--days N] [--commit] [--submit]',
        ],
      };
  }

  process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(result)}\n`);
}

main().catch((err) => {
  const result = { ok: false, command: process.argv[2] || 'unknown', error: String(err?.stack || err?.message || err) };
  process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(result)}\n`);
  process.exitCode = 1;
});