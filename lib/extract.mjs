/**
 * 页面结构侦察（recon）。
 *
 * `inventory` 会被序列化成字符串注入浏览器执行，所以它必须是**自包含**的：
 * 不能引用模块作用域里的任何变量或函数。改动时请保持这个约束。
 */

function inventory() {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const textOf = (el) => norm(el && (el.innerText || el.textContent));
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 6; depth += 1) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(part + '#' + cur.id);
        break;
      }
      const raw = typeof cur.className === 'string' ? cur.className : '';
      const cls = raw.split(/\s+/).filter(Boolean).slice(0, 3).map((c) => '.' + c).join('');
      part += cls;
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    path: cssPath(el),
    text: textOf(el).slice(0, 200),
    visible: isVisible(el),
    id: el.id || undefined,
    name: el.getAttribute('name') || undefined,
    cls: (typeof el.className === 'string' ? el.className : '') || undefined,
    placeholder: el.getAttribute('placeholder') || undefined,
    ariaLabel: el.getAttribute('aria-label') || undefined,
    type: el.getAttribute('type') || undefined,
    value: el.value !== undefined && el.value !== null ? String(el.value).slice(0, 120) : undefined,
    disabled: el.disabled === true ? true : undefined,
    readOnly: el.readOnly === true ? true : undefined,
    role: el.getAttribute('role') || undefined,
  });

  const inputs = Array.from(
    document.querySelectorAll('input,textarea,select,[contenteditable="true"]'),
  ).slice(0, 400).map(describe);

  const buttons = Array.from(
    document.querySelectorAll('button,[role="button"],a,input[type="submit"],input[type="button"]'),
  ).filter(isVisible).slice(0, 300).map(describe);

  const tables = Array.from(document.querySelectorAll('table')).slice(0, 40).map((t) => ({
    path: cssPath(t),
    headers: Array.from(t.querySelectorAll('thead th, thead td')).map(textOf).filter(Boolean),
    firstRows: Array.from(t.querySelectorAll('tbody tr')).slice(0, 15).map((tr) =>
      Array.from(tr.children).map((td) => textOf(td).slice(0, 80)),
    ),
  }));

  const KEYWORDS = ['出勤天数', '出勤', '工时', '天数', '小时', '加班', '请假', '考勤', '填报', '提交'];
  const keywordHits = [];
  for (const el of document.querySelectorAll('*')) {
    // 只看叶子节点，避免祖先重复命中同一段文字
    if (el.children.length > 0) continue;
    const t = textOf(el);
    if (!t || t.length > 60) continue;
    const kw = KEYWORDS.find((k) => t.includes(k));
    if (!kw) continue;
    const cell = el.closest('td,th,[role="gridcell"],[role="cell"]');
    const row = el.closest('tr,[role="row"]');
    const parent = el.parentElement;
    keywordHits.push({
      keyword: kw,
      ...describe(el),
      parentText: parent ? textOf(parent).slice(0, 200) : undefined,
      inCell: cell ? { path: cssPath(cell), text: textOf(cell).slice(0, 120) } : undefined,
      rowText: row ? textOf(row).slice(0, 300) : undefined,
    });
    if (keywordHits.length >= 150) break;
  }

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    bodyTextSample: textOf(document.body).slice(0, 1500),
    iframes: Array.from(document.querySelectorAll('iframe')).slice(0, 20).map((f) => ({
      src: f.getAttribute('src') || undefined,
      id: f.id || undefined,
      path: cssPath(f),
    })),
    tables,
    inputs,
    buttons,
    keywordHits,
  };
}

/** 注入浏览器执行的表达式，求值结果即上面的对象。 */
export const INVENTORY_EXPR = `(${inventory.toString()})()`;

/* ------------------------------------------------------------------ 失败自诊断 */

/**
 * 紧凑列出本帧里可编辑的元素与可见按钮。
 * 当定位失败时，这份清单就是「该把哪个 cssPath 写进配置」的答案，
 * 省掉一轮 probe。同样必须自包含。
 */
function interactables() {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
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

  const editables = [];
  for (const el of document.querySelectorAll('input,textarea,select,[contenteditable="true"]')) {
    if (editables.length >= 12) break;
    const scope = el.closest('td,th,[role="gridcell"],[role="cell"]') || el.parentElement;
    editables.push({
      path: cssPath(el),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      value: el.value === undefined || el.value === null ? undefined : String(el.value).slice(0, 40),
      visible: visible(el),
      disabled: el.disabled === true ? true : undefined,
      scopeText: scope ? norm(scope.innerText || scope.textContent).slice(0, 80) : undefined,
    });
  }

  const buttons = [];
  for (const el of document.querySelectorAll('button,[role="button"],a[href],input[type="submit"],input[type="button"]')) {
    if (buttons.length >= 15) break;
    if (!visible(el)) continue;
    const t = norm(el.innerText || el.textContent || el.value);
    if (!t || t.length > 20) continue;
    buttons.push({ path: cssPath(el), tag: el.tagName.toLowerCase(), text: t, id: el.id || undefined });
  }

  return { url: location.href, title: document.title, editables, buttons };
}

/** 找出所有「文字包含某标签」的叶子元素，用于反推 valueSelector / inputSelector。 */
function labelProbe(label) {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const textOf = (el) => norm(el && (el.innerText || el.textContent));
  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let cur = el;
    for (let d = 0; cur && cur.nodeType === 1 && d < 6; d += 1) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(part + '#' + cur.id); break; }
      const raw = typeof cur.className === 'string' ? cur.className : '';
      part += raw.split(/\s+/).filter(Boolean).slice(0, 3).map((c) => '.' + c).join('');
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

  const hits = [];
  for (const el of document.querySelectorAll('*')) {
    if (hits.length >= 20) break;
    if (el.children.length > 0) continue;
    const t = textOf(el);
    if (!t || t.length > 40 || !t.includes(label)) continue;
    const row = el.closest('tr,[role="row"]');
    const cell = el.closest('td,th,[role="gridcell"],[role="cell"]');
    hits.push({
      path: cssPath(el),
      text: t,
      tag: el.tagName.toLowerCase(),
      exact: t === label,
      rowText: row ? textOf(row).slice(0, 120) : undefined,
      cellPath: cell ? cssPath(cell) : undefined,
    });
  }
  return { url: location.href, label, hits };
}

/** 本帧可编辑元素/按钮清单（自诊断用）。 */
export const INTERACTABLES_EXPR = `(${interactables.toString()})()`;

/** 生成本帧「含某标签的元素」清单表达式。 */
export const labelProbeExpr = (label) => `(${labelProbe.toString()})(${JSON.stringify(label)})`;

/** 把 DOM 的完整 HTML 取出来（含 shadow root，便于排查低代码框架）。 */
export const HTML_EXPR = `(() => {
  const walk = (root) => {
    let out = root.innerHTML || '';
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        out += '\\n<!-- shadow-root of ' + el.tagName.toLowerCase() + ' -->\\n' + walk(el.shadowRoot);
      }
    }
    return out;
  };
  return walk(document);
})()`;