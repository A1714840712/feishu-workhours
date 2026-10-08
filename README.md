# 飞书项目工时自动填报（DSH 插件）

从北森 **iTalent「我的月报」** 读取本月的**出勤天数**，按 `工时 = 出勤天数 × 8` 换算，
自动填入 **飞书项目 (Meego) 工时页**。

- 插件名：`@local/feishu-workhours`
- 工具名：`workhours`
- 依赖：**不装任何 npm 包**（只用 Node 22 内置能力直接驱动系统 Chrome，无需下载 Chromium）。
  唯一的 peer 是宿主提供的 `@deepseek-ai/dsh-tools`，由 DSH 的 runtime resolution 解析，**必须保留**（见 §4.1）
- 登录态：保存在独立浏览器配置目录里，**插件不接触、不存储账号密码**

---

## 1. 它由三部分组成

| 动作 | 作用 | 会改数据吗 |
|---|---|---|
| `probe` | 打开两个页面，把 DOM 结构 / HTML / 截图落盘，用来确定选择器 | 否 |
| `read` | 读取出勤天数并算出工时 | 否 |
| `fill` | 读取 + 写入 Meego。**默认只预览**，`commit: true` 才真正写 | 是（仅在 commit 时） |

底层全部由 `lib/driver.mjs` 实现，**同一套代码既能从命令行跑，也能从插件跑**。

---

## 1.1 目录结构

```
feishu-workhours/
├─ package.json          # bundle 清单（dsh.bundle.patch + dsh.client）
├─ cordis.patch.yml      # 把插件插入 profile
├─ index.js              # 宿主插件：注册 workhours 工具 + /workhours 命令
├─ client.js             # 浏览器插件：左栏「工时填报」条目 + 主面板
├─ config.default.json   # 默认配置（选择器 / 换算规则 / 浏览器）
├─ icon.svg, locale/     # 插件卡片显示用
├─ lib/
│  ├─ cdp.mjs            # 零依赖 CDP 客户端（启动 Chrome、连调试端口、跨 iframe 求值、帧偏好与等待）
│  ├─ extract.mjs        # 页面结构提取 + 失败自诊断（interactables / labelProbe）表达式
│  └─ driver.mjs         # 主引擎：probe / read / fill 三个子命令
├─ test/run-tests.mjs    # 端到端测试（本地夹具 + 跨站 iframe + 插件契约 + 客户端 bundle 契约，不需要登录）
```

---

## 2. 左栏面板（Web UI）

插件在 DSH Web 的左栏占一个条目（和「插件」「定时任务」并列），点开后是它的主面板：

```
左栏  ┌──────────┐
      │ … 会话 … │
      │ [插件]   │
      │ [工时填报] │ ← 本插件
      │ …        │
      └──────────┘
```

面板里有四个动作，它们**不自己实现业务**，只是把一条 `/workhours …` 命令行交给宿主：

| 按钮 | 实际命令 | 会写数据吗 |
|---|---|---|
| 读取出勤天数 | `/workhours read` | 否 |
| 预览填报（不写入） | `/workhours fill` | 否 |
| 抓取页面结构 | `/workhours probe` | 否 |
| 确认填报（写入 Meego） | `/workhours fill commit` | 是 |

- 写入按钮默认禁用，必须先勾选「我已核对读数，确认写入 Meego」。
- 面板里的动作**和 `workhours` 工具跑同一套 `lib/driver.mjs`**，不存在两套逻辑
  （`runAction()` 是唯一入口，见 index.js）。
- 命令需要一个会话才能执行：没有打开的会话时，面板会给出「新建会话」按钮。
- 命令结果只显示在面板里，**不进入模型对话**。

---

## 3. 第一次使用（必须做一次）

### 3.1 登录一次

浏览器用的是**独立配置目录**，所以需要人工登录一次，之后长期有效：

```powershell
cd E:\DSH-chajain\feishu-workhours
node lib\driver.mjs probe --workspace E:\DSH-chajain
```

- 会弹出一个 Chrome 窗口，并打开 iTalent 月报页和 Meego 工时页。
- 在窗口里**完成登录**（飞书 SSO / iTalent 登录），确认两个页面都能正常看到内容。
- 回到终端**按回车**，脚本会把结构抓到：

```
E:\DSH-chajain\.dsh-workhours\probe\
├─ attendance.inventory.json   # 结构化清单（表格、输入框、关键词命中）
├─ attendance.html             # 完整 HTML（含 shadow root）
├─ attendance.png              # 截图
├─ meego.inventory.json
├─ meego.html
└─ meego.png
```

> 登录态存在 `E:\DSH-chajain\.dsh-workhours\chrome-profile`。
> 下次直接跑 `read` / `fill` 就行，不用再登录。

### 3.2 确认选择器

把 `attendance.inventory.json` 和 `meego.inventory.json` 交给助手，让它把精确选择器写进配置；
或者自己看清单里的 `keywordHits` / `inputs`，把 `cssPath` 填到配置里：

```jsonc
{
  "attendance": { "valueSelector": "填 iTalent 出勤天数的那个单元格/输入框" },
  "meego":      { "inputSelector": "填 Meego 工时输入框", "submitSelector": "填提交按钮" }
}
```

**留 `null` 也基本能用**：内置的启发式会按可见文字「出勤天数」「工时」就近定位元素。
但写死选择器要稳得多。

**也可以先不 probe**：`read` / `fill` 定位失败时会**自我诊断**，直接告诉你该填什么：

- `read` 失败 → 列出页面上所有含「出勤天数」的元素及其 `cssPath`（`=` 精确命中，`~` 子串命中）；
- `fill` 失败 → 列出**每个 frame** 里的可编辑元素（`cssPath` / type / placeholder / 邻近文字）与可见按钮。

把其中正确那条的 `cssPath` 抄进 `attendance.valueSelector` / `meego.inputSelector` 即可，不必再跑一轮 probe。

---

## 4. 安装插件

> **当前状态：已安装。** 已执行
> `dsh plugin --profile desktop add E:\DSH-chajain\feishu-workhours`，
> profile 的 `dsh.profile.bundles` 现在包含 `@local/feishu-workhours`。
>
> - 插件代码改动**不需要重新安装**：profile 里是 junction 链接（`link:E:/DSH-chajain/feishu-workhours`）指向本目录。
> - 但 Host 插件在**进程启动时**加载，所以新代码 / 新安装要**重启应用**才会生效。
> - **新增 `dsh.client` 声明（也就是左栏面板）一定需要重启。** 宿主把每个 Loader 条目的
>   `package.json` 元数据缓存在进程内（`dsh-client-modules` 的 `resolveMeta`/`pkgMeta`，「until restart」），
>   本插件启动时还没有 `dsh.client`，所以正在运行的实例不会重新读它；
>   在 Plugins 页里禁用再启用也**不会**让宿主重读（缓存命中即返回，见 `reconcilePackage`）。

装 Host 插件会在**宿主进程里执行代码**，属于敏感操作，需要完全权限或一次批准。

**方式 A：Web UI**

`Plugins` 页 → `Add plugin` → 填绝对路径：

```
E:\DSH-chajain\feishu-workhours
```

**方式 B：CLI**

```powershell
& 'F:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add E:\DSH-chajain\feishu-workhours
```

> `desktop` 是应用独占的 profile，只能用应用自带的 CLI 管理（`dsh --profile desktop --dump-config` 会被拒绝）。

### 4.1 `peerDependencies` 不能删

`package.json` 里的这一条不是可选项：

```jsonc
"peerDependencies": { "@deepseek-ai/dsh-tools": "~0.2.0-rc.2" }
```

launcher 在挂载 profile 条目前，会把 **runtime resolution 装进 Node 的 ESM/CommonJS 解析器**；
对于 profile 链接到树外的目录（本项目正是这种），**目录 `package.json` 里声明的 peer 包名会解析到运行时包**
（见 `@deepseek-ai/dsh-app-boot` 的 README「链接目录 / 进程内模块解析」两节）。

删掉它，`index.js` 的 `import { defineTool } from '@deepseek-ai/dsh-tools'` 就会
`ERR_MODULE_NOT_FOUND`，插件**整个无法加载**（在纯 Node 下直接 `node -e "import('./index.js')"` 也一样，
这是预期行为，不代表配置错误）。

### 4.2 怎么确认它真的加载了

用一个临时 profile 做加载验证，不打扰 `desktop`：

```powershell
$dsh = 'F:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile headless add E:\DSH-chajain\feishu-workhours   # 初始化并安装
& $dsh --profile headless --dump-config | Select-String feishu-workhours  # 组合结果里应有该条目
& $dsh headless "只回复 ok"                                            # 真正启动，看有无「未激活」警告
```

判定标准（对照实验）：

| 情况 | 输出 |
|---|---|
| 插件导入失败 | `dsh: warning: N entry did not activate` + `<id> (<name>): failed to import` |
| 插件正常 | 没有任何「未激活」警告（模型凭据缺失之类的报错与此无关） |

对照实验本身可以这样复现 —— 用一个临时 overlay 插入不可能解析的插件名：

```yaml
# broken-overlay.yml
- insert:
    - id: definitely-not-a-plugin
      name: '@local/definitely-not-a-plugin'
```

```powershell
& $dsh headless --patch .\broken-overlay.yml "只回复 ok"   # → failed to import
& $dsh headless "只回复 ok"                                # → 没有「未激活」警告
```

> 验证用的 `headless` profile 用完可以删掉（`Remove-Item "$env:USERPROFILE\.dsh\profiles\headless" -Recurse`），
> 它只用来证明加载链路，不是交付物。

> 已装的插件**要在新会话/重启后生效**（已有会话保留它启动时的插件版本）。

### 4.3 怎么确认左栏面板真的装上了

不要动正在运行的应用（它没开调试端口，而且 `/` 需要启动时打印的 token）。
用一个**临时 profile 起一套 Web UI**，再让 Chrome 通过 CDP 去看左栏：

```powershell
$dsh = 'F:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
& $dsh whcheck --from-default-profile web --dump-config          # 建临时 profile（从 web 模板）
& $dsh plugin --profile whcheck add E:\DSH-chajain\feishu-workhours

# 起服务：它会把带 token 的 URL 打印出来，记下这个 token
& $dsh --profile whcheck --port 19388 --no-open

# 另开一个终端：验证左栏条目、面板内容、主题 token、控制台报错，并截图
node E:\DSH-chajain\tools\verify-sidebar.mjs 'http://127.0.0.1:19388/?token=<上一步打印的 token>' --shots=E:\DSH-chajain\.dsh-workhours\shots

# 再进一步：真的点一下「读取出勤天数」，看命令有没有打回宿主
node E:\DSH-chajain\tools\verify-sidebar.mjs 'http://127.0.0.1:19388/?token=<上一步打印的 token>' --click=读取出勤天数

# 收尾
Remove-Item "$env:USERPROFILE\.dsh\profiles\whcheck" -Recurse
```

`tools\verify-sidebar.mjs` 用 DOM 而不是像素来判断，判定标准：

| 结果 | 含义 |
|---|---|
| `left-rail panel entries` 里出现 `工时填报` | 左栏条目已注册 |
| `aria-current: "工时填报"` | 点击后主面板被选中 |
| `panel actions` 含那 4 个按钮 | 面板渲染完整 |
| `light` / `dark` 两组颜色都不是 `rgba(0, 0, 0, 0)` | 主题 token 解析成功，没有写死颜色 |
| `panel actions with a Session` 是 4 个按钮 | 面板认得当前会话 |
| `--click` 打出 driver 自己的业务报错 | 按钮 → 命令 → 宿主 → driver 全链路通了 |
| `SIDEBAR VERIFY: OK` 且 `console errors/warnings: 0` | 没有 slot 崩溃 |

**实测结果**（`--click=读取出勤天数`，未登录的干净 profile）：

```
command outcome: ERROR — 执行失败
command text: 没能读到「出勤天数」。页面被重定向到了登录页 —— 浏览器里的登录态已失效。
              请先运行 probe 重新登录一次。
```

这条 ERROR 是**预期**的：它证明命令真的打到了宿主、真的启动了 driver、真的开了 Chrome 去访问 iTalent，
只是没登录而已。要区分的是**接线错误**（`without inject`、`没有可用的命令通道`、`宿主里没有 /workhours`），
那些才是 bug。

**这套验证证明的是宿主侧的组合与渲染，不是「你的应用里已经出现」** ——
正在运行的 desktop profile 仍需要重启一次（见 §4）。

### 4.4 客户端插件的一个坑：`remote.commands` 必须按需注入

浏览器的命令通道**不能**直接 `ctx.get('remote').commands` 访问，会抛：

```
cannot get property "remote.commands" without inject
```

要么像官方插件那样把它写进静态 `inject`，要么用 `ctx.inject`。本插件用的是后者：

```js
// 静态 inject 只放 slots/locale —— 静态 inject 一旦缺失，apply 根本不跑，左栏条目会跟着消失。
let commands;
ctx.inject(['remote', 'remote.commands'], (remoteCtx) => {
  commands = remoteCtx.remote.commands;
  return () => { commands = undefined; };
});
```

这样通道缺席时只是退化成一条可读提示，**条目和面板照常存在**。
（对照：`ctx.get('uiSession')` 这类服务名不带点，`ctx.get` 会安全地返回 `undefined`，不需要 inject。）

---

## 5. 用法

同一个操作有**三个入口**，跑的都是 `lib/driver.mjs`：

1. **左栏面板**：左栏「工时填报」→ 点按钮（见 §2）。
2. **斜杠命令**：在输入框里打 `/workhours read`、`/workhours fill commit`
   （语法 `probe | read | fill [commit] [submit] [days=21.5]`）。
3. **交给助手**：直接说，或让助手调用 `workhours` 工具。

| 说法 | 实际动作 |
|---|---|
| 「抓一下工时页面的结构」 | `probe`（**不等终端**，只抓当前已加载的页面） |
| 「看看我这个月出勤多少天、该填多少工时」 | `read` |
| 「填报工时（先预览）」 | `fill`（`commit` 默认 false，不写） |
| 「确认无误，填报工时」 | `fill` + `commit: true` |

> 唯一的例外是**第一次登录**：那一步必须走终端版的 `probe`（见 §3.1），
> 因为插件里的 `probe` 传了 `--no-wait`，不会停下来等你登录 —— 未登录时它只会抓到登录页。

也可以绕过插件直接用命令行：

```powershell
node lib\driver.mjs probe --workspace E:\DSH-chajain            # 首次登录用这个（会等回车）
node lib\driver.mjs read  --workspace E:\DSH-chajain
node lib\driver.mjs fill  --workspace E:\DSH-chajain            # 预览
node lib\driver.mjs fill  --workspace E:\DSH-chajain --commit   # 真正写入
node lib\driver.mjs fill  --workspace E:\DSH-chajain --commit --submit  # 写完并点提交
node lib\driver.mjs fill  --workspace E:\DSH-chajain --days 21.5 --commit  # 跳过读取，直接写
```

---

## 6. 配置

复制一份到工作区再改（查找顺序：`--config` → `<workspace>/.dsh-workhours/config.json` → `<workspace>/config.json`）。
其中 `meego.url` **必须**换成你自己的看板地址 —— 仓库里的默认值只是 `REPLACE-ME` 占位符；
真实地址只写在工作区的私有配置里，不要提交进仓库：

```powershell
copy config.default.json E:\DSH-chajain\.dsh-workhours\config.json
```

| 键 | 说明 |
|---|---|
| `attendance.url` | iTalent 月报地址 |
| `attendance.label` | 目标列名，默认 `出勤天数`（**精确匹配优先**，不会被「应出勤天数」抢走） |
| `attendance.valueSelector` | 写死选择器；`null` 时走启发式 |
| `attendance.rowMatch` | `current-month`：优先选含当前月份的那一行 |
| `attendance.frameUrlIncludes` | 帧偏好：URL 含该片段的 frame **先试**，默认 `italent.cn` |
| `attendance.frameWaitMs` | 等该帧出现的最长时间，默认 15000 |
| `rule.hoursPerDay` | 每天工时，默认 8 |
| `meego.label` / `inputSelector` | 工时输入框的定位方式 |
| `meego.frameUrlIncludes` | 帧偏好，默认 `projectplg.feishupkg.com` —— Meego 的 `openapp` 自定义插件页跑在**跨域 iframe** 里，表单在这里面 |
| `meego.frameWaitMs` | 等该帧出现的最长时间，默认 15000（插件页由宿主异步挂载，晚于外层 `readyState=complete`） |
| `meego.submitSelector` | 提交按钮选择器；留 `null` 时按可见文字兜底找「提交 / 保存 / 确定 / 保存并提交 / 提交工时」 |
| `meego.submit` | 是否默认点提交（**建议保持 false**，人工确认后再提交）。为 `true` 但找不到按钮时，结果里会明确写「没找到提交按钮，请人工提交」 |
| `browser.port` | Chrome 调试端口，默认 9333 |
| `browser.profileDir` | 登录态目录，默认 `<workspace>/.dsh-workhours/chrome-profile` |
| `browser.keepOpen` | `true` 则跑完不关浏览器，方便观察 |

> `frameUrlIncludes` **只调整尝试顺序，不做过滤**：即使填错（或页面改版换了域名），
> 仍然会退回其余 frame，不会因此直接失败；`read` / `fill` 的结果里会带一行 `帧定位：…`
> 或 `⚠ 没等到 URL 含该片段的 frame … 实际看到的帧：…`，照它改配置即可。

---

## 7. 测试

不需要登录即可验证整条链路（用本地 HTML 夹具模拟两个页面）：

```powershell
node test\run-tests.mjs
```

覆盖（**87 项，全部通过**）：

- 浏览器启动 / CDP / 跨 frame 提取 / 截图 / 结构 JSON 与 HTML 落盘
- 精确匹配优先（「出勤天数」不被「应出勤天数」抢走）、当前月份行选取、小数天数、`×8` 换算
- 预览不写入；`commit` 写入且不写错框
- **跨站 iframe**（本地起两个环回主机 `127.0.0.1` / `127.0.0.2` + `sandbox` 属性，模拟飞书项目自定义插件页）：
  帧偏好生效、等到 iframe 出现、只写进目标帧、外层诱饵未被写
- **提交兜底**：`submit: true` 且没配选择器时按文字点中「提交」
- **失败自诊断**：定位失败时 `interactables` 给出可编辑元素与按钮的 `cssPath`
- **插件契约**：`name` / `inject` / `apply` 导出、注册 `workhours`、参数 schema（`action` 必填且枚举正确）、
  输出 schema、`render` 文本、非法参数被拒、摘要里带 `cssPath` 与提交方式
- **命令契约**（`[6]` 段）：`/workhours` 走**可选注入** `['commands']`、命令名与 `input.hint`、
  `parseCommandInput` 的默认动作 / `commit` / `submit` / `days=` / 未知动作
- **客户端 bundle 契约**（`[7]` 段）：把 `window.__ModuleLoader__` 与 `react` 顶替掉后跑 `client.js`，
  断言它注册了 `sidebar.panellist`（id `feishu-workhours`）与 key 相同的 `main` 主面板、
  zh/en 字典键集一致、图标与面板可渲染、**点按钮真的发出 `/workhours read|fill|probe`**、
  没有会话时给出「新建会话」、以及**写入按钮必须显式勾选确认**；
  另外断言 `ctx.inject` 按需注入 `['remote','remote.commands']`、通道缺席 / 就绪 / 释放三种情况下
  `executeLine` 的行为（见 §4.4）

面板在**真实宿主里**的渲染由另一个脚本验证（见 §4.3）：

```powershell
node E:\DSH-chajain\tools\verify-sidebar.mjs <带 token 的 URL> <截图目录>
```

---

## 8. 已知限制（请务必读）

- **选择器还没有在真实页面上验证过。** 两个页面都必须登录才能访问，助手拿不到真实 DOM。
  另外，Meego 那页的业务代码**不在公开的 bundle 里**（`page-web/index.js`、`936.index.js`
  只是 `runtime-client` 通用外壳，没有任何中文业务文案），所以也无法靠静态分析反推选择器。
  目前定位依赖「按可见文字就近定位」的启发式 —— 失败时会自我诊断并给出候选 `cssPath`（见 §3.2）。
- **只写一个总数。** 目标是「总工时 = 出勤天数 × 8」写进单个输入框。
  如果真实页面是按天/按人分行的表格，需要先确定该写哪一行，再补 `meego.inputSelector`（或加扩展逻辑）。
- **有些格子要先点一下才会出现输入框。** 当前实现只在已有 `<input>`/`contenteditable` 里写；
  若真实页面是「点单元格进入编辑态」，第一次 `fill` 会失败并给出诊断，据此再决定是否加点击步骤。
- **iTalent 是低代码框架**（URL 里带 `shadow_context`），有可能使用 shadow DOM。
  `probe` 导出的 HTML 已经包含 shadow root 内容，便于排查。
- **Meego 插件页在跨域 iframe 里**：外层 `project.feishu.cn`，表单在
  `projectplg.feishupkg.com/b/plugin/pkg/MII_<看板 id>/.../page-web/`，
  带 `sandbox="allow-downloads allow-forms allow-pointer-lock allow-scripts allow-same-origin"`。
  跨域 / 独立进程（OOPIF）两条路径都已处理
  （`Page.createIsolatedWorld(grantUniveralAccess)` + OOPIF target），并有跨站 iframe 的回归测试。
- **提交动作默认关闭。** 自动点提交风险高，建议保持 `submit: false`，人工核对后手动提交。
  即使显式打开，也只在确实找到按钮时才点，且结果会写明点的是哪个按钮。
- **页面改版会让启发式失效。** 失效表现是 `read` 报「没找到出勤天数」或 `fill` 报
  「没能定位到工时输入框」——此时看结果里的 `probes` / `interactables`（或重跑 `probe`）更新选择器。
- **首次需要在独立配置目录的 Chrome 里人工登录一次**（见 §3.1）。登录态之后长期有效；
  插件本身不接触、不存储账号密码。
- 如果 `browser.profileDir` 目录下的 Chrome 已经在运行（但没有开调试端口），
  再次启动只会激活旧窗口而不会开端口，driver 会明确报错并提示怎么处理。

---

## 9. 合规提醒

这个插件只是把你**真实的出勤记录**换算成工时后省去手工录入，请确保：
填报的小时数如实反映真实工时，且自动填报本身符合贵司的考勤/工时管理制度。