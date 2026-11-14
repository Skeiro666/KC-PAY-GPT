# KC-PAY-GPT 前端 UI 优化 · 实施说明与验证记录

日期：2026-11-09
对应需求：[UI 优化方案与 AI 实施说明](UI优化方案与AI实施说明.md)

本文件记录**实际完成**的改动、验证方式与实际结果。凡是"未做"或"只在模拟环境验证"的内容都会明确写出，不把效果图当作功能已接通的证据。

---

## 1. 改动清单

### 1.1 新增文件

| 文件 | 作用 |
| --- | --- |
| `public/css/tokens.css` | 共享设计令牌：颜色、圆角、阴影、字体栈、间距、焦点样式、`prefers-reduced-motion`、`box-sizing` 基线 |
| `public/css/admin.css` | 后台设计层：只做视觉覆盖，不改 DOM/脚本；含移动端抽屉样式 |
| `public/js/admin-shell.js` | 后台外壳交互（纯增量）：小屏顶栏按钮、抽屉遮罩、Esc/点击收起、`aria-expanded` 同步 |
| `public/vendor/lucide.min.js` | 本地图标库（lucide v0.469.0，ISC），替换 `unpkg.com/lucide@latest` 外链 |
| `scripts/ui-audit/capture.mjs` | 隔离截图脚本：静态服务器 + 全量 mock API + Playwright 场景截图 |
| `docs/ui-audit/*.png` | 20 张真实浏览器截图（桌面 1440 / 笔记本 1280 / 平板 768 / 手机 390） |
| `docs/ui-audit/report.json` | 截图脚本产出的场景清单、console 报错、失败请求记录 |

### 1.2 修改文件

| 文件 | 改动 |
| --- | --- |
| `public/style.css` | 全量重写（1418 → 约 1200 行）：白色玻璃设计系统，旧类名与内联变量全部保留兼容 |
| `public/index.html` | 重排为「玻璃导航 + 首屏标题区 + 双栏（操作 / 说明）」，改写未经证实的文案，新增连接状态提示与 HTML 转义 |
| `public/subscription.html` | 重排同一设计语言，命名从「发票助手」改为「订阅查询」，说明改为"不代开发票"，新增 HTML 转义与 URL 白名单 |
| `public/admin-login.html` | 居中玻璃卡片、密码显隐按钮、`role="alert"` 错误区；登录/验证逻辑完全保留 |
| `public/admin.html` | 仅 4 处改动：① 移除 Google Fonts 外链、图标改本地 ② `*` 字体栈改为 `var(--font-sans)` ③ `</style>` 后追加 tokens/admin 两个样式表 ④ `</body>` 前追加 `admin-shell.js` |

`public/index.html` 与 `public/subscription.html` 不再依赖任何外部 CDN（字体走系统栈，图标为内联 SVG）。

---

## 2. 设计系统落地

按需求文档 §4.2 的令牌实现于 `public/css/tokens.css`：

- 背景 `#f5f5f7` + 两处极淡径向渐变，无彩色光团、无漂浮动画。
- 玻璃材质 = 半透明白 + `backdrop-filter: blur(20px) saturate(150%)`，并带 `@supports` 不支持时的实色回退。
- 一个页面只有一个视觉焦点：前台是兑换卡片，后台是数据卡片与表格。
- 主色仅 `#0071e3` 一档蓝；成功/失败/警告统一为低饱和语义色（`#187a3d` / `#c52b25` / `#945600`）。
- 字体全部为系统栈（`-apple-system, …, PingFang SC, Microsoft YaHei`），不下载任何字体文件。
- 键盘焦点 `:focus-visible` 全局可见；`prefers-reduced-motion` 下动效归零。

保留的兼容层（未删除，避免内联样式失效）：`--primary-soft`、`--accent`、`--surface-soft`、`--divider`、`--radius-sm/lg/xl`、`--shadow`、`--card-bg`、`--sidebar-bg` 等旧变量名，全部映射到新令牌。

---

## 3. 逐页改造

### 3.1 用户兑换页 `public/index.html`

- 布局：吸顶玻璃导航 → 首屏标题区（仅标题与说明）→ 双栏（左 620px 操作卡，右侧运行状态 + 套餐档位 + 常见问题）。
- 首屏不再显示「当前账单地区 / 结算币种」与「开通进度」两枚信息胶囊（用户要求移除）；`/api/public/payment-region` 接口保留但前台不再调用。
- 首屏即可见到 CDK 输入框，不再需要滚动越过三张套餐卡片。
- 文案去承诺化：
  - 删除「极速开通」「失败可回滚」「3-5 分钟开通完毕」；
  - 改为与代码一致的表述：「进入支付阶段之前中断，卡密会自动回滚；已进入支付阶段的任务需要人工核对」（对应 `server.js` 中 `progress < 40` 才 `markCdkUnused` 的逻辑）；
  - 套餐卡不再罗列 `GPT-5.5 / DALL·E` 等未经核实的权益，改为「档位由卡密决定，具体权益以官方说明为准」。
- 主按钮文案改为「确认开通」，与"点击才会提交、粘贴不会自动提交"的提示配套。
- 新增连接状态提示：WebSocket `onclose` 显示「连接中断，正在恢复进度…（不会自动重新提交开通）」，`onopen` 隐藏；不推断业务失败（需求 §5.3）。
- 安全：查询结果、Session 邮箱、套餐名、服务端报错统一经 `escapeHtml` 渲染。
- 保留不动：DOM id、`/api/verify-cdk`、`/api/run-process`、`/api/cdk/query`、`/api/public/*`、WebSocket 协议、心跳、断线重连、进度上限 99 的既有逻辑。

### 3.2 订阅查询页 `public/subscription.html`

- 命名与信息层级按实际能力调整：标题「订阅查询」，说明「只读取订阅信息并提供官方入口，不代开发票」。
- 结果区沿用 `.query-result-card`，10 个字段全部渲染为「标签 / 值」，值为等宽数字右对齐。
- 「打开 OpenAI 账单页面」保留为真实外链，并对后端返回的 `billingPageUrl` 增加 `http(s)` 白名单校验。
- 保留 Session 客户端校验（JWT 三段 + 过期判断）与 `/api/public/subscription/check` 请求体。

### 3.3 后台登录页 `public/admin-login.html`

- 居中玻璃卡片（max 420px），品牌标记 + 字段标签 + 错误区（`role="alert"`）。
- 新增密码显隐按钮（`aria-pressed` 同步，切换后焦点回到输入框），错误提示不清空其它字段。
- 二次验证步骤保留验证方式切换、Telegram 发送、返回；样式改为浅色胶囊 segmented control。
- 未改动：token 存储键、`/api/admin/login`、`/api/admin/login/send-tg-code`、`/api/admin/login/verify-2fa`、指纹算法、跳转路径。

### 3.4 管理后台 `public/admin.html`

不做整文件重写（8518 行、HTML/CSS/业务脚本耦合），采用"后置样式层"渐进覆盖：

- 侧栏改为 232px 半透明玻璃，导航项 38px 高、圆角 10、选中态白底 + 蓝字 + 细阴影；分组子项用细左边线缩进。
- 内容区留白改用 `clamp()`，页面标题 22–28px、字重 600。
- 统计卡片：统一 18px 圆角、`--shadow-card`、26px 等宽数字；图标底色统一为淡蓝（覆盖历史荧光色）。
- 面板 / 表格：表格容器圆角 14、表头 `position: sticky` 吸顶、行高固定、hover 用极淡蓝；`code` 单元格等宽且不换行。
- 控件：输入 40px、按钮 36px、分页 32px、下拉/筛选/开关统一圆角与描边。
- 弹层：截图弹窗 / 确认框改为 26px 圆角 + 遮罩模糊；toast 改玻璃底并保留语义色边框。
- 移动端（≤1024px）：侧栏变抽屉（272px，`translateX` 过渡 + 遮罩 + Esc/点击关闭 + 抽屉内关闭按钮），内容区顶部出现 38px 汉堡按钮与品牌名；≤520px 统计卡片两列。
- 唯一使用 `!important` 的位置：覆盖写在 `style` 属性里的历史荧光色（`.stat-icon` 与 12 个 `.stat-value[style*=…]` 选择器）以及 `font-size: 28px` 的两个指标，均在 `admin.css` 文末集中注明。

---

## 4. 验证记录

### 4.1 真实浏览器截图

`node scripts/ui-audit/capture.mjs` 产出 20 个场景，全部成功（0 失败）：

| 场景 | 文件 | 视口 |
| --- | --- | --- |
| 兑换页初始 | `docs/ui-audit/front-empty-desktop.png` | 1440×900 |
| 兑换页初始（笔记本） | `docs/ui-audit/front-empty-laptop.png` | 1280×800 |
| 兑换页初始（平板） | `docs/ui-audit/front-empty-tablet.png` | 768×1024 |
| 兑换页初始（手机） | `docs/ui-audit/front-empty-mobile.png` | 390×844 |
| 卡密校验通过 / 待提交 Session | `docs/ui-audit/front-step2-desktop.png` | 1440 |
| 卡密无效错误态 | `docs/ui-audit/front-error-mobile.png` | 390 |
| 查询状态结果 | `docs/ui-audit/front-query-result-desktop.png` | 1440 |
| 开通中（含断线提示） | `docs/ui-audit/front-running-desktop.png` | 1440 |
| 开通成功 | `docs/ui-audit/front-success-desktop.png` | 1440 |
| 订阅查询初始 / 结果 / 手机 | `subscription-empty-desktop.png`、`subscription-result-desktop.png`、`subscription-empty-mobile.png` | 1440 / 390 |
| 登录页 / 手机 / 二次验证 | `login-desktop.png`、`login-mobile.png`、`login-2fa-desktop.png` | 1440 / 390 |
| 后台概览（桌面 / 笔记本 / 手机） | `admin-dashboard-*.png` | 1440 / 1280 / 390 |
| 后台移动端抽屉 | `admin-drawer-mobile.png` | 390 |
| 后台任务列表（有数据） | `admin-tasks-desktop.png` | 1440 |

> **截图数据全部为虚构 mock 数据**（`scripts/ui-audit/capture.mjs` 内置），不连接数据库、不调用真实第三方接口、不发起任何付款。截图只能证明界面与状态渲染，不能证明支付链路可用。

### 4.2 截图脚本本身

- 隔离静态服务器只读 `public/`，`/api/*` 全部由脚本返回固定数据；WebSocket 不实现，因此"连接中断"提示是**真实触发**的，不是画的。
- 每个场景采集 `console` 报错、`pageerror`、失败请求（排除预期的 ws）并写入 `report.json`。
- 结果：19 个场景 0 报错；`front-error-mobile` 有 1 条 `403`，来自该场景**故意**让 `/api/verify-cdk` 返回失败的 mock，属预期。
- 整页截图会把吸顶导航钉在文档流顶部（等价于页面处于滚动顶部时的观感），脚本在执行截图前做了这一步并在代码中注明。

### 4.3 回归检查

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 单元测试 | `npm test` | 9 个文件 / 42 用例全部通过（1.70s） |
| 内联脚本语法 | `new Function(<script>)` 解析 | index / subscription / admin-login 各 1 段、admin.html 2 段全部通过 |
| 后台加载 | 截图脚本真实加载 `/admin` | 无 `pageerror`、无失败请求，`lucide` 本地加载成功 |
| 敏感信息 | 人工检查改动 | 未新增 localStorage 写入 Session；Session 仍只随请求体发送 |

---

## 5. 未完成项与已知限制

1. **后台未逐页重排**：`admin.html` 只做了视觉层覆盖，页面内部结构（尤其"系统配置"长表单、"银行卡池""CDK 管理"列表区）仍是原有信息密度，尚未按需求 §6.5 分区重写。风险最低，收益也需要逐页评估。
2. **后台未做桌面端侧栏折叠**：只实现了平板/手机抽屉。桌面折叠成图标栏会导致二级菜单（银行卡池 / CDK / Session / 账单）失去可读入口，在没有 tooltip 体系前不做。
3. **Session 遮挡摘要未实现**：需求 §5.2 提到"可用遮挡摘要展示"，当前仍是明文 textarea（仅补充了"不写入本地存储/URL/日志"的说明）。遮挡需要新增"摘要视图 ↔ 原文编辑"切换，涉及提交值一致性验证，留作下一轮。
4. **表单/表格的"更多菜单"未做**：低频操作仍平铺在行内（沿用原结构），只统一样式。
5. **未做真实后端联调**：本环境没有可用 MySQL，无法启动 `server.js` 完整跑通。截图与交互验证都在 mock 层完成；真实环境需在部署机上复核一次兑换流程与后台首屏。
6. **未做移动端实机验证**：截图由 Chromium 设备尺寸模拟，未在真机 iOS Safari 验证 `backdrop-filter` 与 `100vh` 行为（已提供 `@supports` 回退与 `100vh` 兜底，但未实测）。
7. **`admin.html` 内联颜色未批量清理**：仅覆盖了统计卡片相关的高亮色；其它页面仍存在历史内联色值，未做全量替换（避免大范围误改业务脚本中的颜色字符串）。

---

## 6. 复现方式

```bash
# 截图（需要本机安装 Chrome；不连数据库、不连真实接口）
node scripts/ui-audit/capture.mjs

# 结果
# docs/ui-audit/*.png
# docs/ui-audit/report.json
```

如 Chrome 不在默认路径，用 `CHROME_PATH` 指定可执行文件。

---

## 7. 图标与字体来源

- 图标：`lucide` v0.469.0，ISC License，取自 `https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js`，落盘为 `public/vendor/lucide.min.js`（固定版本，不再使用 `@latest`）。
- 字体：全部使用系统字体栈，不引入任何 Web Font；`admin.html` 已移除 Google Fonts 外链。
