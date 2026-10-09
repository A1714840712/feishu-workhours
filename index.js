/**
 * 飞书项目 (Meego) 工时自动填报 —— DSH 宿主插件。
 *
 * 本文件只做三件事：把 `workhours` 能力暴露成一次 driver 子进程调用，
 * 然后把它接到两个调用方上 ——
 *   - 模型用的 `workhours` 工具（`ctx.tools.register`）；
 *   - 人用的 `/workhours` 会话命令（`ctx.commands.register`），Web 左栏面板
 *     的按钮就是通过 `ctx.remote.commands.execute()` 调它。
 * 两者共用 `runAction()`，所以「一个操作，两个调用方」不会各写一套逻辑。
 * 真正的浏览器自动化全在 `lib/driver.mjs`，因此同一套逻辑既能从命令行跑，
 * 也能从插件跑。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(HERE, 'lib', 'driver.mjs');
const RESULT_MARKER = '__DSH_WORKHOURS_RESULT__';

export const name = 'feishu-workhours';
export const inject = ['tools'];

/** 启动 driver 子进程并解析它带标记的 JSON 结果。 */
function runDriver(argv, { timeoutMs = 900000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [DRIVER, ...argv], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false,
      });
    } catch (e) {
      resolve({ ok: false, error: `无法启动 node: ${e?.message || e}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, error: `driver 超过 ${timeoutMs}ms 仍未结束，已终止` });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `无法启动 node: ${e?.message || e}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const at = stdout.lastIndexOf(RESULT_MARKER);
      if (at < 0) {
        resolve({
          ok: false,
          error: `driver 没有返回结果（退出码 ${code}）`,
          stderr: stderr.slice(-1500),
          stdout: stdout.slice(-1500),
        });
        return;
      }
      try {
        resolve({ result: JSON.parse(stdout.slice(at + RESULT_MARKER.length).trim()), stderr });
      } catch (e) {
        resolve({ ok: false, error: `driver 结果不是合法 JSON: ${e?.message || e}`, stdout: stdout.slice(-1500) });
      }
    });
  });
}

/**
 * 跑一次 driver 并把结构化结果压成一段可读摘要。
 * 工具与 `/workhours` 命令唯一的共同入口。
 * @param action - `probe` | `read` | `fill`。
 * @param options.workspace - 工作区绝对路径（配置查找与登录态目录都基于它）。
 * @param options.commit - 仅 fill：真正写入 Meego。
 * @param options.submit - 仅 fill：写完是否点提交按钮。
 * @param options.days - 仅 fill：跳过读取，直接用这个出勤天数。
 * @param options.daily - read/fill：额外读「日报」逐日明细（每天的实际出勤工时）。
 * @returns `{ ok, summary, detail? }`。
 */
async function runAction(action, { workspace, commit = false, submit = false, days, mode, daily = false } = {}) {
  const argv = [action, '--workspace', workspace];
  if (action === 'probe') {
    // 插件里没有终端可等，直接抓当前已登录的页面
    argv.push('--no-wait');
  }
  if (daily === true && (action === 'read' || action === 'fill')) argv.push('--daily');
  if (action === 'fill') {
    if (commit === true) argv.push('--commit');
    if (submit === true) argv.push('--submit');
    if (typeof days === 'number') argv.push('--days', String(days));
    if (mode === 'batch' || mode === 'single') argv.push('--mode', mode);
  }

  const outcome = await runDriver(argv);

  if (outcome.ok === false) {
    return {
      ok: false,
      summary: `工时任务失败：${outcome.error}`,
      detail: [outcome.stderr, outcome.stdout].filter(Boolean).join('\n').slice(-2000) || undefined,
    };
  }

  const r = outcome.result;
  return {
    ok: r.ok !== false,
    summary: summarize(action, r),
    detail: outcome.stderr ? outcome.stderr.trim().slice(-1200) : undefined,
  };
}

/** `/workhours` 认得的三个动作。 */
const COMMAND_ACTIONS = ['probe', 'read', 'fill'];

/**
 * 解析 `/workhours` 的 rawInput：`probe | read | fill [commit] [submit] [days=21.5] [mode=batch] [daily]`。
 * 什么都不传时按 `read` 处理（最安全：不写字）。
 * @param rawInput - 命令名之后的全部输入。
 * @returns 解析出的选项，或 `{ error }`。
 */
export function parseCommandInput(rawInput) {
  const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean);
  const action = tokens[0] ?? 'read';
  if (!COMMAND_ACTIONS.includes(action)) {
    return { error: `未知动作 "${action}"，可用：${COMMAND_ACTIONS.join(' | ')}` };
  }
  let days;
  let mode;
  for (const token of tokens.slice(1)) {
    const matched = /^days=(\d+(?:\.\d+)?)$/.exec(token);
    if (matched) days = Number(matched[1]);
    const m = /^mode=(single|batch)$/.exec(token);
    if (m) mode = m[1];
  }
  return {
    action,
    commit: tokens.includes('commit'),
    submit: tokens.includes('submit'),
    daily: tokens.includes('daily'),
    days,
    mode,
  };
}

/**
 * 注册 `/workhours` 会话命令，让 Web 面板（或手打命令）能直接跑同一条链路。
 * @param ctx - 已注入 `commands` 的上下文。
 */
function registerCommand(ctx) {
  ctx.commands.register({
    name: 'workhours',
    description: '飞书项目工时填报：读 iTalent 出勤天数，按 ×8 写入 Meego 工时页',
    input: { hint: 'probe | read | fill [commit] [submit] [days=21.5] [mode=batch] [daily]' },
    async handler({ agent, rawInput }) {
      const parsed = parseCommandInput(rawInput);
      if (parsed.error !== undefined) return { kind: 'error', text: parsed.error };

      const workspace = agent?.session?.header?.cwd || process.cwd();
      const result = await runAction(parsed.action, {
        workspace,
        commit: parsed.commit,
        submit: parsed.submit,
        days: parsed.days,
        mode: parsed.mode,
        daily: parsed.daily,
      });
      return result.ok
        ? { kind: 'success', text: result.summary }
        : { kind: 'error', text: result.summary };
    },
  });
}

/** 把日报逐日明细压成几行（`--daily` 才有）。 */
function formatDaily(r) {
  const d = r && r.daily;
  if (!d) return '';
  if (d.ok === false) return `\n（日报逐日没读成：${d.error}）`;
  const per = d.perDayHours || {};
  const dates = Object.keys(per).sort();
  if (dates.length === 0) return '';
  const sum = Math.round(dates.reduce((a, k) => a + per[k], 0) * 100) / 100;
  const head = `\n日报逐日：${d.days.length} 天（${d.days[0].date}~${d.days[d.days.length - 1].date}）`
    + `，取值列「${d.hoursColumn || `${r.hoursPerDay}h×天数`}」，逐日合计 ${sum}h`
    + `${Math.abs(sum - r.hours) > 0.01 ? `（与月报口径 ${r.hours}h 差 ${Math.round((sum - r.hours) * 100) / 100}h，不会用于填报）` : '（与月报口径一致）'}`;
  return `${head}\n  ${dates.map((k) => `${k.slice(5)} ${per[k]}h`).join('，')}`;
}

/** 把失败时的「含该标签的元素」压成几行，cssPath 可直接抄进配置。 */
function formatProbes(probes) {
  if (!Array.isArray(probes) || probes.length === 0) return '';
  const lines = ['', '页面里含该标签的元素（把正确那条的 cssPath 写进配置）：'];
  for (const p of probes) {
    lines.push(`  帧 ${p.frameUrl || '(主文档)'}${p.preferred ? ' [偏好]' : ''}`);
    for (const h of p.hits || []) {
      lines.push(`    ${h.exact ? '=' : '~'} "${h.text}"  → ${h.path}${h.cellPath ? `  (单元格 ${h.cellPath})` : ''}`);
    }
  }
  return lines.join('\n');
}

/** 把失败时各帧的可编辑元素与按钮压成几行。 */
function formatInteractables(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  const lines = ['', '各帧里的可编辑元素与按钮（把正确那条的 cssPath 写进配置）：'];
  for (const f of list) {
    const eds = f.editables || [];
    const btns = f.buttons || [];
    if (eds.length === 0 && btns.length === 0 && !f.error) continue;
    lines.push(`  帧 ${f.frameUrl || '(主文档)'}${f.preferred ? ' [偏好]' : ''}${f.error ? ` 错误=${f.error}` : ''}`);
    for (const e of eds) {
      const meta = [
        e.tag,
        e.type,
        e.placeholder ? `placeholder=${e.placeholder}` : null,
        e.visible === false ? '不可见' : null,
        e.disabled ? 'disabled' : null,
      ].filter(Boolean).join(' ');
      lines.push(`    输入 ${e.path}  [${meta}]${e.scopeText ? `  邻近文字"${e.scopeText}"` : ''}`);
    }
    for (const b of btns) lines.push(`    按钮 "${b.text}"  → ${b.path}`);
  }
  return lines.join('\n');
}

/** 帧定位结果的一行说明；没等到偏好帧时给出实际看到的帧，便于修配置。 */
function frameNote(r) {
  const fw = r?.frameWait;
  if (!fw || fw.waited !== true) return '';
  if (fw.matched) return `\n帧定位：已等到 ${fw.matched}`;
  const seen = (fw.seen || []).join(' | ') || '(无)';
  return `\n⚠ 没等到 URL 含该片段的 frame —— 检查配置里的 frameUrlIncludes。实际看到的帧：${seen}`;
}

/** 把 driver 的结构化结果压成模型可读的摘要。 */
export function summarize(action, r) {
  if (action === 'probe') {
    const lines = [`已抓取页面结构到 ${r.outDir}`];
    for (const page of r.pages || []) {
      lines.push(`\n【${page.name}】${page.url}`);
      for (const f of page.frames || []) {
        lines.push(`  - ${f.via} ${f.frameUrl || '(空)'}：输入框 ${f.inputs}，表格 ${f.tables}，关键词命中 ${f.keywordHits}${f.error ? `，错误 ${f.error}` : ''}`);
      }
      lines.push(`  结构 JSON: ${page.inventoryFile}`);
    }
    lines.push('\n下一步：把这些 inventory.json 交给助手，写死精确选择器后就能稳定填报。');
    return lines.join('\n');
  }

  if (action === 'read') {
    if (!r.ok) return `没能读到「出勤天数」。${r.hint || ''}${formatProbes(r.probes)}${frameNote(r)}`;
    const base = `出勤天数 = ${r.days} 天（来源 ${r.source}，${r.matchedRow}）\n→ 工时 = ${r.days} × ${r.hoursPerDay} = ${r.hours} 小时${frameNote(r)}`;
    return base + formatDaily(r);
  }

  // action === 'fill'
  if (r.mode === 'preview') {
    const plan = r.wouldWrite && r.wouldWrite.plan;
    const planNote = plan
      ? `\n按日报逐日填 ${plan.length} 格，合计 ${plan.reduce((a, x) => a + x.hours, 0)}h：\n  `
        + plan.map((x) => `${x.date.slice(5)} ${x.hours}h`).join('，')
      : '';
    return `【预览，未写入任何内容】出勤 ${r.days} 天 × ${r.hoursPerDay} = ${r.hours} 小时${planNote}`
      + `\n确认后把 commit 设为 true 才会真正写入。`;
  }
  if (!r.ok) {
    return `写入失败：${r.hint || r.error || '未知原因'}${formatInteractables(r.interactables)}${frameNote(r)}`;
  }
  const w = r.wrote || {};
  const submit = w.submitted
    ? `是（${w.submitHow === 'submitSelector' ? '按配置选择器' : `按文字点中「${w.submitText}」`}）`
    : (w.submitHow === 'not-found' ? '否 —— 没找到提交按钮，请人工提交' : '否');
  return `已写入工时 ${r.hours} 小时（出勤 ${r.days} 天 × ${r.hoursPerDay}）\n定位方式 ${w.how}，写入后值为 "${w.after}"，提交=${submit}${frameNote(r)}`;
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'workhours',
    description:
      '自动填报飞书项目 (Meego) 工时。流程：从北森 iTalent「我的月报」读取出勤天数 → 按 出勤天数 × 8 算出总工时 → 写入 Meego 工时页。'
      + '\n三种动作：'
      + '\n- probe：打开两个页面并把 DOM 结构、截图落盘。首次使用、或页面改版后必须做一次，用于确定选择器。'
      + '\n- read：只读取出勤天数并算出工时，不碰 Meego。'
      + '\n- fill：读取并写入。默认只预览（不写），必须显式传 commit: true 才真正写入。'
      + '\nfill 有两种登记方式（参数 mode）：single=单项登记，弹窗里填一格；batch=批量登记，'
      + '把 出勤天数×8 按工作日逐格分摊到整月（余数落在最后一个工作日），每格填完都回读「合计」校验。'
      + '\n两种方式都**只填不提交**，除非显式传 submit: true。'
      + '\n注意：浏览器使用独立配置目录保存登录态，插件不接触账号密码；首次需要人工登录一次。'
      + '\n首次登录必须在终端里做：`node lib/driver.mjs probe --workspace <工作区>` 会打开浏览器并等你在终端回车（'
      + '这里的 probe 不等终端，只抓当前已加载的页面，未登录时只会抓到登录页）。'
      + '\n若 read/fill 报登录态失效，或定位失败，请把结果里的 probes / interactables 交给助手写精确选择器。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['probe', 'read', 'fill'],
        description: 'probe（抓结构） | read（只读换算） | fill（读取并写入）',
      },
      commit: {
        type: 'boolean',
        description: '仅 fill 用。true 才真正写入 Meego；默认 false，只做预览。',
      },
      submit: {
        type: 'boolean',
        description: '仅 fill 用。写完是否点击提交按钮。默认 false，交给人工确认后提交。',
      },
      days: {
        type: 'number',
        description: '仅 fill 用。跳过读取，直接用这个出勤天数换算（便于先验证写入链路）。',
      },
      mode: {
        type: 'string',
        enum: ['single', 'batch'],
        description: '仅 fill 用。single=单项登记（一次一格）；batch=批量登记，把 出勤天数×8 按工作日逐格填。默认用配置里的 meego.mode。',
      },
      daily: {
        type: 'boolean',
        description: '仅 read/fill 用。true 时额外读「日报」逐日明细，按每天的实际出勤工时逐格填'
          + '（不会把工时填到节假日上、也不会漏掉调休上班的周末）。默认 false，用配置里的 attendance.dailyDetail。'
          + '这一趟要滚动虚拟表格，约 1~3 分钟。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          detail: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.detail ? `${value.summary}\n\n---\n${value.detail}` : value.summary,
      }],
    },
    async execute(args, exec) {
      const workspace = exec.agent?.session?.header?.cwd || process.cwd();
      const result = await runAction(args.action, {
        workspace,
        commit: args.commit === true,
        submit: args.submit === true,
        days: typeof args.days === 'number' ? args.days : undefined,
        mode: args.mode === 'batch' ? 'batch' : (args.mode === 'single' ? 'single' : undefined),
        daily: args.daily === true,
      });
      return {
        ok: result.ok,
        action: args.action,
        summary: result.summary,
        detail: result.detail,
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `工时填报 · ${args.action}`,
      kind: 'execute',
      rawInput: args.action,
      content: [{
        type: 'text',
        text: args.action === 'fill' && args.commit !== true ? '预览模式（不会写入）' : `执行 ${args.action}`,
      }],
    }),
  }));

  // `/workhours` 是可选能力：在缺少 commands 服务的 profile 里插件照样加载，
  // 只是 Web 左栏面板与手打命令用不了（工具不受影响）。
  ctx.inject(['commands'], (commandCtx) => {
    registerCommand(commandCtx);
  });
}