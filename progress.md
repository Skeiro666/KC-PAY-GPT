

## 2026-08-14 - Task: 修復 GPT 代充 API 協議代理傳參
### What was done
- Session inspect 保留為不使用代理的本機格式／到期檢查。
- 執行代充時從本地代理池取得啟用代理並傳入 `/pay.proxy`；本地池為空時省略欄位，由平台啟用代理池兜底。
- 完整 Session payload 繼續傳入，固定 CDK 冪等鍵不變。
- 重寫 `協議api.md`，對齊 inspect 無代理、Worker 協議有代理的新規格。
- 修正 Vitest CommonJS 測試載入方式。
### Testing
- `node --check gpt-api-client.js`、`node --check server.js` 通過。
- `npm test -- test/gpt-api-client.test.js`：3 passed。
- 線上使用正式 API 設定呼叫 inspect 成功，回 `reason=local_check`。
- 契約驗證確認 `/pay` payload 同時包含完整 Session 與 proxy。
- `docker compose up -d --build app` 成功，app 容器 healthy。
### Notes
- `gpt-api-client.js`：`submitPay` 支援並傳送 proxy。
- `server.js`：取得協議代理並傳入平台，保留平台代理回退。
- `test/gpt-api-client.test.js`：改驗證 proxy 會傳送並修復 Vitest 載入。
- `協議api.md`：更新完整協議與 403 風險說明。
- `progress.md`：追加本輪記錄。
- 回滾方式：還原上述檔案並執行 `docker compose up -d --build app`；回滾會恢復不傳代理的舊行為。


## 2026-08-14 - Task: 補齊 GPT API 套餐與卡片相容性
### What was done
- 新增 `pro_5x → pro5x`、`pro_20x → pro20x` 映射，inspect 與 pay 共用同一平台套餐鍵。
- `GET /plans` 客戶端支援平台 `{gpt, credit}` 回應。
- 卡片有效期嚴格支援 `MMYY`、`MM/YY`、`MM/YYYY`；無效格式明確失敗，不再回退 2030。
### Testing
- Node 語法檢查通過。
- `npm test -- test/gpt-api-client.test.js`：4 passed。
### Notes
- `server.js`：新增套餐鍵映射與有效期解析。
- `gpt-api-client.js`：支援 `raw.gpt` 套餐陣列。
- `test/gpt-api-client.test.js`：增加 plans 回應契約測試。
- `協議api.md`：補充套餐映射及有效期格式。
- `progress.md`：追加本輪記錄。
- 回滾方式：還原上述檔案並重建 app；回滾會使 Pro 套餐重新可能回 `plan_disabled`。


## 2026-08-14 - Task: 修復平台任務 done 誤判激活成功
### What was done
- 查詢 task 時優先讀取 `result.status`，不再把 queue 外層 `done` 當業務成功。
- 移除 `done` 成功終態；`result.ok=false` 強制按失敗處理並顯示內層錯誤。
### Testing
- `npm test -- test/gpt-api-client.test.js`：5 passed。
- 線上容器契約驗證：`done + result.failed → failed`，`done + result.success → success`。
- app 重建部署成功，容器 healthy。
### Notes
- `gpt-api-client.js`：優先解析內層業務狀態。
- `server.js`：移除 done 成功映射並使用 result.ok／error。
- `test/gpt-api-client.test.js`：新增 queue done 與業務終態回歸測試。
- `progress.md`：追加本輪記錄。
- 回滾方式：還原上述檔案並重建 app；回滾會再次把失敗任務誤報成功。


## 2026-11-05 - Task: 银行卡敏感字段加密与后台脱敏
### What was done
- 新增 `card-crypto.js`，使用 AES-256-GCM 加密卡号、有效期、CVC、持卡人。
- `card_assets` / `billing_records` 新增密文字段；服务启动时自动迁移旧明文并清空明文字段。
- 卡号使用 SHA256 去重，账单与后台接口只展示后四位，CVC 不再返回。
- 账单 CSV 导出改为脱敏卡号；`CARD_ENCRYPTION_KEY` 或 `data/card-encryption.key` 作为密钥。
### Testing
- `npm test`：13 passed（含 `test/card-crypto.test.js`）。
- 数据库端到端验证：导入测试卡后明文字段为空、密文以 `enc:v1:` 开头、`reserveCard` 可正确解密。
- 管理接口验证：`GET /api/admin/cards` 只返回 `**** **** **** 0002` 与 CVC `***`，无完整卡号泄漏。
- 3102 端口启动新版服务并通过 public runtime/payment-region 健康检查。
### Notes
- 线上 3000 端口旧进程为提权启动，自动审批不可用，未能在本轮直接重启；需管理员重启后新代码才生效。
- 密钥文件：`data/card-encryption.key`（已加入 `.gitignore`），务必备份；密钥丢失将无法解密。
- CVC 仍以密文保存以满足自动填表，项目不具备 PCI DSS 合规性。

## 2026-11-09 - Task: 前端 UI 白色玻璃风格改造（前台/订阅/登录/后台）
### What was done
- 新增 `public/css/tokens.css` 共享设计令牌（白色玻璃、系统字体栈、焦点与动效降级、box-sizing 基线），旧变量名全部保留为兼容别名。
- 重写 `public/style.css`（1418 → 约 1200 行）：玻璃导航、首屏标题区、兑换页双栏布局、状态/进度/查询组件、订阅页组件、响应式断点。
- `public/index.html`：重排页面结构，首屏直接给 CDK 输入；删除「极速/失败可回滚/3-5 分钟」等未证实文案；新增 WebSocket 断线提示（只提示恢复，不推断失败）；查询结果与服务端消息统一 escapeHtml。
- `public/subscription.html`：更名为「订阅查询」，去掉"代开发票"暗示，账单链接增加 http(s) 白名单。
- `public/admin-login.html`：居中玻璃卡片 + 密码显隐（aria-pressed）+ role=alert 错误区，登录/2FA 逻辑与 token 键不变。
- 新增 `public/css/admin.css` + `public/js/admin-shell.js`：后台视觉覆盖（侧栏玻璃、统计卡、面板、表格吸顶、控件、弹层）与移动端抽屉导航；`admin.html` 只增加 3 个 link/script 标签并把 `*` 字体栈改为系统栈。
- 图标改为本地 `public/vendor/lucide.min.js`（v0.469.0，ISC），移除 unpkg `@latest` 与 Google Fonts 外链。
- 新增 `scripts/ui-audit/capture.mjs`：隔离静态服务器 + mock API + Playwright，产出 20 个场景截图到 `docs/ui-audit/`。
### Testing
- `npm test`：9 文件 / 42 用例通过。
- `node scripts/ui-audit/capture.mjs`：20 场景全部成功；除 1 条故意 mock 的 403 外无 console / 请求错误。
- 三个页面与 admin.html 的内联脚本 `new Function` 解析全部通过。
- 视口覆盖 1440 / 1280 / 768 / 390，桌面与手机均无横向溢出（截图宽度=视口宽度）。
### Notes
- 截图数据全为虚构 mock，不连数据库、不发起付款，不能作为支付链路可用性的证据。
- 后台未做逐页重排与桌面侧栏折叠；Session 遮挡摘要未实现；未做真实后端联调与真机验证。详见 `docs/UI优化实施说明.md` 第 5 节。
- 回滚方式：`git checkout -- public/index.html public/subscription.html public/admin-login.html public/admin.html public/style.css` 并删除 `public/css`、`public/js`、`public/vendor`、`docs/ui-audit`。

## 2026-11-09 - Task: 移除前台首屏的账单地区与进度说明胶囊
### What was done
- 删除 `public/index.html` 首屏 `.hero-meta` 区块（「当前账单地区：菲律宾，结算币种：PHP」与「开通进度 由服务端任务状态驱动」两枚胶囊）。
- 同步删除已无引用的 `loadPaymentRegionHint()` 与启动调用，前台不再请求 `/api/public/payment-region`（服务端接口保留，未改动）。
- 清理 `public/style.css` 中随之失效的 `.hero-meta` / `.meta-chip` 规则。
### Testing
- `node scripts/ui-audit/capture.mjs`：20 场景全部成功；首屏高度由 1039px 降至 983px，桌面与手机均正常。
- `grep paymentRegionHint|hero-meta|meta-chip public/index.html public/style.css`：0 命中。
### Notes
- 只删展示层，未改任何接口、CDK 校验、任务流程或进度条逻辑。
