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
node lib\driver.mjs fill  --workspace E:\DSH-chajain --commit   # 点开弹窗并填好工时（不提交）
node lib\driver.mjs fill  --workspace E:\DSH-chajain --commit --submit  # 顺便点提交（默认不建议）
node lib\driver.mjs fill  --workspace E:\DSH-chajain --days 21.5 --commit  # 跳过读取，直接填
node lib\driver.mjs fill  --workspace E:\DSH-chajain --mode batch          # 批量：预览分摊方案
node lib\driver.mjs fill  --workspace E:\DSH-chajain --mode batch --commit # 批量：按工作日逐格填（不提交）
node lib\driver.mjs fill  --workspace E:\DSH-chajain --mode batch --days 2 --commit  # 只填 2 格，用来试水
```

`--commit` 之后弹窗会留在页面上、标签页不关，你核对完自己点「提交审批」即可。

> **建议先小步试水**：`--mode batch --days 2 --commit` 只填两格，确认格子和日期都对上，
> 再跑整月（不加 `--days`，工时会按 `attendance` 读到的出勤天数 × 8 算）。

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
| `attendance.url` | iTalent 月报地址。默认值已在真实页面上验证（缺 `viewName` / `app` / `shadow_context` / `#/indexPage` 会被弹回首页） |
| `attendance.label` | 目标列名，默认 `本月实际出勤天数`（**精确匹配优先**，避免被「月报能量日应出勤天数」「能量日实际出勤天数」抢走） |
| `attendance.valueSelector` | 写死选择器；`null` 时走「表头列 → 同列数据行」的 grid 启发式 |
| `attendance.rowMatch` | `current-month`：优先选含当前月份的那一行，没有则回退到最新可得的那一行（结果里的 `matchedMonth` 会写明用的哪个月） |
| `attendance.decimals` | 天数保留几位小数，默认 **4**（月报里的天数是 0.125 的整数倍，位太少会算错小时） |
| `attendance.frameUrlIncludes` | 帧偏好：URL 含该片段的 frame **先试**，默认 `italent.cn` |
| `attendance.frameWaitMs` | 等该帧出现的最长时间，默认 15000 |
| `attendance.renderWaitMs` | 轮询等异步表格渲染的最长时间，默认 30000 |
| `rule.hoursPerDay` | 每天工时，默认 8 |
| `meego.registerButtonText` | 看板上打开登记入口的按钮文字，默认 `工时登记` |
| `meego.registerModeText` | 下拉里的登记方式，默认 `单项登记` |
| `meego.batchModeText` | 批量那条路的下拉项文字，默认 `批量登记` |
| `meego.mode` | 默认登记方式：`single`（单项，一次填一格）或 `batch`（批量，按天逐格填）；命令行 `--mode batch` 可覆盖 |
| `meego.clickWaitMs` | 等按钮出现、并等加载遮罩（`ant-spin`）消失的最长时间，默认 25000 |
| `meego.batch.workItemType` | 批量登记要选的工作项类型（如 `项目管理`）；`null` = 只报错提示你去配 |
| `meego.batch.workItemInstance` | 批量登记要搜的工作项实例名（通常跟类型同名） |
| `meego.batch.range` | 日期范围按钮文字，默认 `上个月`；命中不了就自己填 `YYYY-MM-01` / 月末 |
| `meego.batch.workdaysOnly` | 只填周一~周五，默认 `true` |
| `meego.batch.rowMatch` | 网格里要填的那一行（登记对象）；`null` = 用第一行 |
| `meego.batch.selectWaitMs` | 等批量弹窗里两个下拉出现的最长时间，默认 25000 |
| `meego.hoursInputSelector` | 弹窗里的工时输入框，默认 `#basic_actWorkHour`（`请输入工时` 那个） |
| `meego.workDateSelector` | 弹窗里的工作日期框，默认 `#basic_workDate` |
| `meego.workDate` | 可选：要填的工作日期（如 `2026-09-30`）。默认 `null` = 不动它，留给你自己选。日期框是 antd 受控组件，填值属尽力而为 |
| `meego.modalWaitMs` | 等弹窗（在另一个 frame 里）出现的最长时间，默认 20000 |
| `meego.submitButtonText` | 弹窗里的提交按钮文字，默认 `提交审批` |
| `meego.submit` | 是否**默认**点提交，默认 `false`。建议保持 false：`--commit` 只把值填好，提交由你手动点 |
| `meego.frameUrlIncludes` | 帧偏好，默认 `projectplg.feishupkg.com` —— Meego 的 `openapp` 自定义插件页跑在**跨域 iframe** 里，表单在这里面 |
| `meego.frameWaitMs` | 等该帧出现的最长时间，默认 15000（插件页由宿主异步挂载，晚于外层 `readyState=complete`） |
| `browser.port` | Chrome 调试端口，默认 9333 |
| `browser.profileDir` | 登录态目录，默认 `<workspace>/.dsh-workhours/chrome-profile` |
| `browser.keepOpen` | `true` 则跑完不关浏览器，方便观察 |

> `frameUrlIncludes` **只调整尝试顺序，不做过滤**：即使填错（或页面改版换了域名），
> 仍然会退回其余 frame，不会因此直接失败；`read` / `fill` 的结果里会带一行 `帧定位：…`
> 或 `⚠ 没等到 URL 含该片段的 frame … 实际看到的帧：…`，照它改配置即可。

> **占位符没换掉时会提前报错，不会打开浏览器。** `fill` / `probe` 直接返回
> `配置里的 meego.url 还是占位符，没有填成你自己的地址。`，并在 `hint` 里写明该写到哪个文件。
> 这样就不用对着 Chrome 的无效地址导航错误猜原因了。
> `read` 只读 iTalent，不需要 `meego.url`，因此不受影响；`probe --only attendance` 同理。

---

## 7. 测试

不需要登录即可验证整条链路（用本地 HTML 夹具模拟两个页面）：

```powershell
node test\run-tests.mjs
```

覆盖（**99 项，全部通过**）：

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
- **占位符配置的提示**（`[8]` 段）：`meego.url` 还是 `REPLACE-ME` 时，`fill` 与
  `probe --only meego` 在打开浏览器之前就返回 `stage=config` 的明确错误（错误与 `hint` 都断言过可读）；
  `read` 与 `probe --only attendance` 不受影响（见 §6）

面板在**真实宿主里**的渲染由另一个脚本验证（见 §4.3）：

```powershell
node E:\DSH-chajain\tools\verify-sidebar.mjs <带 token 的 URL> <截图目录>
```

---

## 8. 已知限制（请务必读）

- **选择器已经在真实页面上验证过**（iTalent 月报 + Meego 工时看板）。三处关键事实：
  1. **月报不是 `<table>`，是 `fixedDataTable` 的 div 网格**。取值靠「表头列序号 → 数据行同列格子」，
     所以 `attendanceLookup` 里有一条专门的 grid 路径；用 `<th>/<td>` 的老逻辑在这页上永远找不到。
  2. **月报的表是异步渲染的**（页面 `readyState=complete` 时往往还是空壳），因此 `read` / `fill`
     会轮询等它出现，最长 `attendance.renderWaitMs`（默认 30000）。只抓一次会稳定报「没找到」。
  3. **同一页有三列都含「出勤天数」**：`本月实际出勤天数` / `月报能量日应出勤天数` / `能量日实际出勤天数`。
     默认 `attendance.label` 取**精确的那一列**（`本月实际出勤天数`），避免歧义。
- **月报里没有当前月那一行。** 月报只列已结束的月份（实测当前月 2026-10 时，最新是 2026-09）。
  默认行为是**回退到最新可得的那一行**，并在结果里用 `matchedMonth` 明确标出用的是哪个月。
  `matchedRow` 为 `current-month` 表示正好命中当前月，为 `first-candidate` 表示是回退结果。
- **出勤天数是小数，且等于「小时 ÷ 8」**（实测 21.875 / 19.5 / 23 / 13 / 12.75，全是 0.125 的整数倍）。
  所以 `attendance.decimals` 默认给到 **4**：若按早期的 1 位小数，21.875 会被舍成 21.9，
  换算成 175.2 小时而不是正确的 **175**。
- **Meego 写入要跨 frame，而且必须先点开弹窗。** 真实结构是：
  看板 frame 里点【工时登记】→ 下拉里点【单项登记】→ 弹窗出现在**另一个** `page-web` 目标里，
  里面有 `#basic_actWorkHour`。所以 `fill --commit` 是「真实鼠标点击 + 在弹窗 frame 里按原生 setter 填值」。
  合成 `el.click()` 对 antd 无效（实测点了没反应），必须走 CDP `Input.dispatchMouseEvent`。
- **`--commit` 只填不提交。** 弹窗会留在页面上（标签页不关），由你核对后自己点「提交审批」。
  只有显式 `--submit` 或 `meego.submit: true` 才会去点提交按钮。
- **批量登记（按天分摊）已实现**，用法是 `--mode batch`（或 `meego.mode: "batch"`）。它做这些事：
  点【工时登记】→ 点【批量登记】→ 选工作项类型 → 搜索并选中工作项实例 → 切到 `上个月`
  → 用 `attendance` 读到的出勤天数 × 8 得到总工时，**按工作日 8 小时逐格分摊**（余数落在最后一个工作日）
  → 逐格「点格子 → 核对浮层里的登记日期 → 填 `#realActWorkHour` → 失焦确认」，每格填完都回读 `合计` 校验。
  结果里的 `batch.cells` 会带每格的 `cellBefore` / `cellAfter`，`filledCount` / `filledHours` 是汇总。
- **批量那条路的两个坑**（都已在代码里处理，出问题时看 `steps` 里的报错原文）：
  1. 批量弹窗由**另一个** `page-web` 目标渲染，而且 antd 会在外层 frame 里留一份**隐藏的弹窗 DOM**。
     所以定位弹窗的判据是「能找到**可见**的『选择工作项类型』下拉」，不是「哪个 frame 的文字里有这几个字」。
  2. 首屏还在加载时按钮会被 `ant-spin` 遮罩盖住，且布局会漂移（算好的坐标转眼就偏）。
     所以点击是「轮询找到 → 命中测试确认没被遮罩盖住 → 点 → 校验菜单是否弹出 → 没弹出就重试整轮」。
- **批量登记的行来自你本人的排期数据**（【添加已有工作实例/节点/任务】）。没有排期时表体是「暂无数据」，
  这时 `batch.rows` 为空、`fatal` 会说明原因 —— 不是你配错了，是确实没有可填的对象。
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