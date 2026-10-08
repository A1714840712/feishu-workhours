/**
 * 飞书项目工时填报 —— DSH Web 客户端插件（左栏面板）。
 *
 * 浏览器侧 bundle 只做两件事：
 *   1. 在左栏列表 `sidebar.panellist` 注册一个图标，点击后打开中间的主面板；
 *   2. 在布局的 root `main` keyed slot 注册面板本体（key 与上面那个 id 相同）。
 *
 * 面板上的按钮**不自己实现业务**：它们通过 `ctx.remote.commands.execute()` 调用
 * 宿主侧的 `/workhours` 命令，而宿主命令与模型用的 `workhours` 工具跑的是同一套
 * `lib/driver.mjs`（见 index.js）。所以「一个操作，两个调用方」在这里成立。
 *
 * 约定：本文件是**手写**的纯 JS，不经打包；宿主直接把这份文件当作 `lib/client.js`
 * 那一层来服务（见 package.json 的 `dsh.client` 与 `./client` 导出）。
 * 除 `react` 外不 require 任何东西 —— 特别是不要 require 宿主的 Client 包。
 */
window.__ModuleLoader__.load({
  id: '@local/feishu-workhours',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 本插件在 client locale service 里拥有的字典命名空间。 */
    const NS = 'feishuWorkhours';
    /** 左栏条目 id，同时也是它打开的 `main` 面板 key —— 两者必须一致。 */
    const PANEL_ID = 'feishu-workhours';

    /** 简体中文字典（键集的事实来源）。 */
    const zh = {
      'panel': '工时填报',
      'title': '飞书项目工时自动填报',
      'intro': '从北森 iTalent「我的月报」读取出勤天数，按 ×8 换算成工时，写入飞书项目 (Meego) 工时页。',
      'rule': '工时 = 出勤天数 × 8',
      'ruleNote': '倍率默认 8 小时/天，可在工作区的 .dsh-workhours/config.json 里改 rule.hoursPerDay。',
      'loginNote': '浏览器用独立配置目录保存登录态，插件不接触账号密码。第一次必须先在终端跑一次 node lib/driver.mjs probe --workspace <工作区> 完成登录，之后长期有效。',
      'session.current': '命令在当前会话里执行，结果只显示在这里，不会进入模型对话。',
      'session.none': '当前没有打开任何会话；命令需要一个会话才能执行。',
      'session.create': '新建会话',
      'action.read': '读取出勤天数',
      'action.preview': '预览填报（不写入）',
      'action.commit': '确认填报（写入 Meego）',
      'action.probe': '抓取页面结构',
      'commit.confirm': '我已核对读数，确认写入 Meego',
      'commit.note': '写入不可撤销。默认不点 Meego 的提交按钮，请核对后在页面上手动提交。',
      'state.running': '执行中…',
      'result.title': '执行结果',
      'result.error': '执行失败',
      'result.empty': '（命令没有返回文字）',
      'error.noRemote': '当前页面没有可用的命令通道（remote.commands 未挂载）。',
      'error.noSession': '没有可执行的会话。',
      'error.transport': '命令调用失败',
      'error.unknownCommand': '宿主里没有 /workhours 命令：插件可能没加载，或者新增的客户端部分需要重启应用才会生效。',
    };

    /** 英文字典，键集与 zh 完全一致。 */
    const en = {
      'panel': 'Work hours',
      'title': 'Feishu Project work-hour auto-fill',
      'intro': 'Reads attendance days from Beisen iTalent "My Monthly Report", converts them at ×8 into hours, and writes the result into the Feishu Project (Meego) work-hour page.',
      'rule': 'Hours = attendance days × 8',
      'ruleNote': 'The multiplier defaults to 8 hours/day; change rule.hoursPerDay in the workspace\'s .dsh-workhours/config.json.',
      'loginNote': 'The browser keeps its login state in a dedicated profile directory; the plugin never touches your credentials. Sign in once from a terminal with node lib/driver.mjs probe --workspace <workspace>; afterwards the session lasts.',
      'session.current': 'The command runs in the current Session and its result is shown only here — it does not enter model history.',
      'session.none': 'No Session is open; a command needs one to run.',
      'session.create': 'New Session',
      'action.read': 'Read attendance days',
      'action.preview': 'Preview fill (writes nothing)',
      'action.commit': 'Confirm fill (writes to Meego)',
      'action.probe': 'Capture page structure',
      'commit.confirm': 'I checked the reading and confirm writing to Meego',
      'commit.note': 'A write cannot be undone. Meego\'s submit button is left untouched; submit from the page after checking.',
      'state.running': 'Running…',
      'result.title': 'Result',
      'result.error': 'Failed',
      'result.empty': '(the command returned no text)',
      'error.noRemote': 'This page has no command channel (remote.commands is not mounted).',
      'error.noSession': 'No Session to run in.',
      'error.transport': 'Command call failed',
      'error.unknownCommand': 'The Host has no /workhours command: the plugin may not be loaded, or its new client half needs an application restart.',
    };

    /**
     * 面板样式。只用主题 token，不写死颜色；按钮与复选框的规则抄自宿主
     * primitives 的 Button.module.css / Checkbox.module.css，类名换成自己的前缀。
     */
    const CSS = `
.fwh-page{box-sizing:border-box;height:100%;overflow:auto;display:flex;flex-direction:column;align-items:center;gap:24px;padding:0 clamp(24px,4vw,48px) 48px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.fwh-page>*{width:100%;max-width:960px}
.fwh-head{padding-top:28px}
html[data-platform='darwin'] .fwh-head{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.fwh-title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.fwh-intro{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.fwh-card{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:16px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}
.fwh-rule{margin:0;font-size:15px;font-weight:500;line-height:24px}
.fwh-note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.fwh-warn{margin:0;color:var(--dsw-alias-state-warn-primary);font-size:13px;line-height:20px}
.fwh-session{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.fwh-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
.fwh-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent}
.fwh-button:disabled{cursor:not-allowed;opacity:.4}
.fwh-button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.fwh-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.fwh-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.fwh-outline{border:.5px solid var(--dsw-alias-border-l3);background:transparent}
.fwh-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.fwh-commit{align-self:flex-start}
.fwh-checkbox{display:inline-flex;align-items:center;gap:6px;font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer}
.fwh-checkbox input{flex:0 0 auto;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:inherit}
.fwh-checkbox:has(input:disabled){cursor:default;opacity:.5}
.fwh-result{box-sizing:border-box;display:flex;flex-direction:column;gap:8px;padding:16px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}
.fwh-result-error{border-color:var(--dsw-alias-state-error-primary)}
.fwh-result-head{font-size:13px;font-weight:500;line-height:20px}
.fwh-result-error .fwh-result-head{color:var(--dsw-alias-state-error-primary)}
.fwh-output{max-height:360px;margin:0;padding:12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-markdown-code-block);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;overflow:auto}
`;

    /**
     * 左栏图标：按侧边栏要求的边长渲染一个时钟字形。
     * 用 `currentColor` 上色，所以选中/未选中都跟随宿主主题，无需自己判断。
     * @param props - 侧边栏的图标份额：`size` 请求边长，`active` 是否选中。
     * @returns 图标元素。
     */
    function WorkhoursIcon({ size }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block' },
      },
        h('circle', { cx: 12, cy: 12, r: 8.5 }),
        h('path', { d: 'M12 7.4v4.9l3.3 1.9' }),
      );
    }

    /**
     * 订阅 uiSession 暴露的「当前主会话」绑定源，返回它的 sessionId。
     * 面板是 root 作用域的，拿不到会话作用域的 `sessionId` prop，只能读这个源。
     * 绑定源在首次渲染时解析（此时应用早已启动完成），没有会话时返回 undefined。
     * @param getSource - 解析绑定源的函数；不可用时返回 undefined。
     * @returns 当前主会话 id，或 undefined。
     */
    function useMainSessionId(getSource) {
      const [source] = React.useState(getSource);
      const [sessionId, setSessionId] = React.useState(() =>
        source === undefined ? undefined : source.getSnapshot()?.key);
      React.useEffect(() => {
        if (source === undefined) return undefined;
        const read = () => setSessionId(source.getSnapshot()?.key);
        read();
        return source.subscribe(read);
      }, [source]);
      return sessionId;
    }

    /**
     * 工时面板：三个只读动作 + 一个需要显式勾选确认的写入动作。
     * 所有动作都只是把一条 `/workhours …` 命令行交给宿主命令通道。
     * @param props - slot 组合出来的份额：`t`、`executeLine`、`getSessionSource`、`startSession`。
     * @returns 面板元素树。
     */
    function WorkhoursPanel(props) {
      const t = props.t;
      const sessionId = useMainSessionId(props.getSessionSource);
      const [busy, setBusy] = React.useState(null);
      const [outcome, setOutcome] = React.useState(null);
      const [confirmed, setConfirmed] = React.useState(false);

      const invoke = (action, line) => {
        if (busy !== null) return;
        setBusy(action);
        setOutcome(null);
        Promise.resolve(props.executeLine(line, sessionId))
          .then((next) => setOutcome(next))
          .catch((error) => setOutcome({ ok: false, text: (error && error.message) || String(error) }))
          .then(() => {
            setBusy(null);
            setConfirmed(false);
          });
      };

      const button = (action, label, line, variant) => h('button', {
        key: action,
        type: 'button',
        className: `fwh-button fwh-${variant}`,
        disabled: busy !== null,
        onClick: () => invoke(action, line),
      }, busy === action ? t('state.running') : label);

      const sessionNotice = sessionId === undefined
        ? h('section', { className: 'fwh-card' },
          h('p', { className: 'fwh-warn' }, t('session.none')),
          h('button', {
            type: 'button',
            className: 'fwh-button fwh-outline',
            onClick: () => props.startSession(),
          }, t('session.create')),
        )
        : h('p', { className: 'fwh-session' }, t('session.current'));

      return h('div', { className: 'fwh-page' },
        h('style', null, CSS),
        h('header', { className: 'fwh-head' },
          h('h1', { className: 'fwh-title' }, t('title')),
          h('p', { className: 'fwh-intro' }, t('intro')),
        ),
        h('section', { className: 'fwh-card' },
          h('p', { className: 'fwh-rule' }, t('rule')),
          h('p', { className: 'fwh-note' }, t('ruleNote')),
          h('p', { className: 'fwh-note' }, t('loginNote')),
        ),
        sessionNotice,
        h('section', { className: 'fwh-actions' },
          button('read', t('action.read'), '/workhours read', 'outline'),
          button('preview', t('action.preview'), '/workhours fill', 'primary'),
          button('probe', t('action.probe'), '/workhours probe', 'outline'),
        ),
        h('section', { className: 'fwh-card' },
          h('label', { className: 'fwh-checkbox' },
            h('input', {
              type: 'checkbox',
              checked: confirmed,
              disabled: busy !== null || sessionId === undefined,
              onChange: (event) => setConfirmed(event.target.checked),
            }),
            h('span', null, t('commit.confirm')),
          ),
          h('button', {
            type: 'button',
            className: 'fwh-button fwh-primary fwh-commit',
            disabled: busy !== null || !confirmed || sessionId === undefined,
            onClick: () => invoke('commit', '/workhours fill commit'),
          }, busy === 'commit' ? t('state.running') : t('action.commit')),
          h('p', { className: 'fwh-note' }, t('commit.note')),
        ),
        outcome !== null && h('section', {
          className: outcome.ok ? 'fwh-result' : 'fwh-result fwh-result-error',
        },
          h('div', { className: 'fwh-result-head' }, outcome.ok ? t('result.title') : t('result.error')),
          h('pre', { className: 'fwh-output' }, outcome.text),
        ),
      );
    }

    return {
      /** 只依赖 slot 注册与字典；其余服务在用到时惰性解析，缺一个也不会让左栏条目消失。 */
      inject: ['slots', 'locale'],
      /**
       * 注册左栏图标与它打开的主面板。
       * @param ctx - 浏览器侧的 root context。
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'feishu-workhours: dictionaries');
        const t = ctx.locale.bind(NS);

        /**
         * 宿主命令通道。`remote.commands` 必须在 inject 里声明才允许访问
         * （否则是 `cannot get property "remote.commands" without inject`），
         * 但它**不能**放进本插件的静态 inject：静态 inject 一旦缺失，apply 就不会跑，
         * 左栏条目会跟着一起消失。所以用 ctx.inject 在它就绪时填入；
         * 真缺席时只退化成一条可读提示，条目和面板照常存在。
         */
        let commands;
        ctx.inject(['remote', 'remote.commands'], (remoteCtx) => {
          commands = remoteCtx.remote.commands;
          return () => { commands = undefined; };
        });

        /** uiSession 暴露的当前主会话绑定源（服务缺失时返回 undefined）。 */
        const getSessionSource = () => {
          const uiSession = ctx.get('uiSession');
          return uiSession === undefined ? undefined : uiSession.current;
        };

        /** 无会话时给用户一个出口：按最近的 Workspace 开一个新会话。 */
        const startSession = () => {
          const uiWorkspace = ctx.get('uiWorkspace');
          if (uiWorkspace !== undefined) uiWorkspace.startSession();
        };

        /**
         * 把一条命令行交给宿主命令通道，并压成面板要显示的 { ok, text }。
         * 失败一律返回可读文字，不向组件抛错。
         * @param line - 完整命令行，例如 `/workhours read`。
         * @param sessionId - 执行该命令的会话。
         * @returns 面板显示用的结果。
         */
        const executeLine = async (line, sessionId) => {
          if (sessionId === undefined) return { ok: false, text: t('error.noSession') };
          if (commands === undefined) return { ok: false, text: t('error.noRemote') };
          let result;
          try {
            result = await commands.execute(sessionId, line, []);
          } catch (error) {
            return { ok: false, text: `${t('error.transport')}：${(error && error.message) || error}` };
          }
          if (result === undefined || result.ok !== true) {
            const failure = result === undefined ? undefined : result.error;
            return {
              ok: false,
              text: failure === undefined
                ? t('error.transport')
                : `${t('error.transport')}：${failure.message}（${failure.code}）`,
            };
          }
          if (result.value === undefined) return { ok: false, text: t('error.unknownCommand') };
          const settled = result.value.result;
          return {
            ok: settled.kind === 'success',
            text: settled.text === undefined ? t('result.empty') : settled.text,
          };
        };

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ executeLine, getSessionSource, startSession }),
        }, WorkhoursPanel));

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          locale: NS,
          label: () => t('panel'),
        }, WorkhoursIcon));
      },
    };
  },
});