# KC-PAY-GPT 项目实现与操作部署手册（中文）

编写日期：2026-11-11。适用目录：`E:\project\auto_chongzhi_chatgpt\KC-PAY-GPT`。已删除的 KC-PAY-GPT-new 不在范围内。

本文根据当前源码编写，覆盖实现、依赖、本地运行、后台操作、线上部署、备份恢复和排障。示例生产配置需要读者创建并验证；本次未执行真实付款、服务器安装或上线。所有 REPLACE_* 均须替换；recharge.example.com 是示例域名。Linux 命令不能直接当 PowerShell 命令执行。默认在项目根目录操作。

## 1. 项目功能与边界

这是一个带后台的订阅开通系统：用户提供 CDK 和账号 Session，服务器验证后启动本地浏览器流程或第三方代充 API，保存任务、账单并实时推送结果。

主要功能：CDK 管理与兑换、银行卡池、代理池、地址管理、Session 管理、任务监控、账单、订阅查询、自动续费控制、管理员二次验证、Telegram 通知、诊断截图/录像。

package.json 的描述含“注册”，但当前 Session 充值主流程不能据此认定有完整自动注册能力。成品号下载接口返回 410，不是可用功能。代码中的 Plus/Pro 名称、plan_name、促销和地区映射不保证外部服务始终支持。

普通激活任务会进入真实付款。支付链接调试只在建单后返回，但仍与外部服务交互；它不是付款前完整审查。本项目没有已删除版本的 PAYMENT_REVIEW_ONLY 功能。只使用有权管理的账号、付款工具、真实账单资料及服务配置。

## 2. 架构与技术

请求链：用户浏览器 → HTTPS/Nginx → Express HTTP 与 WebSocket → MySQL/后台 worker → Chromium 或供应商 API。

- Node.js：CommonJS；Express 提供 HTTP/静态资源，ws 推送消息，mysql2/promise 访问 MySQL，axios 调外部接口。
- 前端：HTML/CSS/原生 JS，无 npm run build。既有内联代码，也有 public/css/tokens.css、admin.css、public/js/admin-shell.js；不要漏拷贝资源。
- 浏览器：Playwright/CDP，仓库也包含 Puppeteer 依赖。运行时有 standalone、pool、bitbrowser。
- 数据库：MySQL 8；启动会创建表、补列、初始化配置、迁移卡片字段。
- Python：现有视觉/验证辅助模块使用 torch、transformers、OpenCV、numpy、pillow、requests、Python Playwright。模块存在不代表自动处理任何验证都有效；遇到验证按正常人工流程处理。
- 可选外部依赖：代充供应商、Telegram、其他验证集成；费用和账号独立准备。普通 CPU 可运行现有 CPU 依赖，GPU 不是默认前提。

Docker 路线不需宿主另装 Node/Python；裸机则自行安装。Docker 镜像包含两套语言的依赖/浏览器，体积和构建开销明显大于普通网页服务。

## 3. 文件职责与调用关系

| 文件/目录 | 职责 |
| --- | --- |
| server.js | dotenv、HTTP、鉴权、任务准入、worker 子进程、结果解析、WebSocket |
| index.js | Session 登录、地区/套餐、Checkout、付款编排、订阅处理、清理 |
| session-auth.js | 解析 Session、token/邮箱提取、Cookie 注入与登录准备 |
| chatgpt.js / pricing-checkout.js | API 建单 / 定价页 UI 建单 |
| browser-runtime.js | 选择浏览器模式，构造 worker 环境，关闭资源 |
| browser-standalone.js | 每任务启动独立 Chromium |
| browser-pool.js / browser-pool-client.js | 池预热、分配、健康检查、CDP 接入 |
| bitbrowser-client.js | 连接比特浏览器已有 profile，串行使用 |
| payment-retry.js / stripe-payment.js | 预留卡片、填表、拒付轮换、账单与结果 |
| mysql-store.js / mysql-schema.sql | 数据访问、配置、迁移、资产锁、任务 |
| card-crypto.js / redaction.js | AES-256-GCM 卡字段加密、脱敏 |
| subscription-check.js / auto-renew.js | 订阅查询、续费变更、取消重试 |
| gpt-api-client.js | 套餐、余额、预检、建单、订单/任务查询 |
| admin-auth.js / admin-paths.js | 管理员登录、二次验证、路径 |
| runtime-log.js / telegram-notify.js | 运行日志、通知 |
| public/ / test/ | 页面资源 / Vitest 回归 |

reset-db.js、update-mysql-schema.js 先读代码再执行，不属于正常启动步骤。不要直接 node index.js 当健康检查，它是实际支付 worker。

## 4. 任务如何实现

1. 用户校验 CDK，再提交完整 Session；服务端仍独立校验。
2. 检查 token、维护、并发、CDK、冷却、选定模式可用资源。
3. 同进程同一 CDK 提交互斥，校验期间预占并发名额。数据库通过 used_at IS NULL 的条件更新取得 CDK 占用。
4. 创建 task_logs，名额交给 jobKey；本地启动 index.js，第三方执行 API worker。
5. 根据 worker 输出分析阶段、结果，更新 MySQL 并广播给订阅该 jobKey 的连接。
6. 本地 success/manual 保留 CDK；worker 启动后异常且不能证明结果时保守转 manual。已知失败按现有逻辑回滚。
7. 结束关闭任务 context，独立模式关闭进程、池模式归还槽位；最后释放任务并发。录像关闭不应跳过 context 清理。

浏览器池复用 Chromium 进程，每单 newContext 隔离登录；独立模式每单启动/关闭进程；比特浏览器使用配置的同一既有环境串行运行，结束关闭，不删除 profile 或重装内核。

重要限制：部分结果判断仍依赖日志文字和进度，不是完整持久化支付状态机。manual 既不证明已扣款，也不证明没扣款。第三方幂等、全部重试路径、强制退出后浏览器回收尚未完整审计。启动恢复按进度阈值判断 CDK 回滚，不能代替真实订单核对。

先只运行一个 app 实例。不要直接 PM2 cluster/多副本共库：并发集合含进程内状态，启动会重置资产锁并处理 running 任务，可能影响其他实例。

## 5. 所需资源与准备清单

准备源码、Docker Engine + Compose v2（或裸机依赖）、MySQL 存储、管理员邮箱/独立强密码、固定卡片加密密钥、域名/DNS/HTTPS、SSH、备份位置。本地付款还需授权 Session/付款工具/真实账单资料与可达网络；第三方需供应商权限、套餐、余额。

| 场景 | 估算资源 | 建议初始并发 |
| --- | --- | --- |
| 测试 | 2 核/4GB/60GB SSD | 1 |
| 小规模正式 | 4 核/8GB/100GB SSD | 先 1，观察后 2 |
| 更大余量 | 8 核/16GB/150GB SSD | 先 3–4，再压测 |
| 纯代充 API | 2 核/4GB 起 | 取决于供应商限制 |

这是估算，不是压测承诺。构建、浏览器、CPU 推理和 MySQL 可能同时达到峰值。原 Compose app 内存上限 6GB，系统/数据库另算；4GB 不能照搬。shm_size: 2gb 是共享内存容量限制，不额外提供物理 RAM。不要把代码每槽 0.55GB 提示当保证。保留约 20–30% 内存余量，磁盘达 70–80% 开始扩容/清理规划。

## 6. 本地 Docker：Windows PowerShell

安装 Docker Desktop，启用 Linux 容器/WSL2并等待启动。进入项目目录，只在没有 .env 时复制，编辑强密码。

```powershell
Set-Location E:\project\auto_chongzhi_chatgpt\KC-PAY-GPT
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
notepad .env
docker version
docker compose version
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml up -d --build
docker compose -f docker-compose.yml ps
docker compose -f docker-compose.yml port app 3000
docker compose -f docker-compose.yml logs --tail 100 app
```

原 Compose 项目名 kc-gpt-pay2，MySQL 宿主端口 3310，容器内部 mysql:3306。网页宿主端口是 ${PORT:-3100}；.env.example 的 PORT=3000 会改成 3000，以 port 命令为准。访问对应端口的 / 和 /admin-login。

原 Compose 仅显式转发部分环境变量，.env 写了不等于容器里有。ADMIN_EMAIL、ADMIN_SECONDARY_PASSWORD、ADMIN_TOKEN_SECRET、CHECKOUT_MODE、CHECKOUT_UI_FALLBACK、AUTO_CANCEL_RENEW、RECORD_VIDEO 等如需生效，要在 app environment 显式补齐或采用第 12 节独立模板。修改环境后 recreate，不是仅 restart。

## 7. 裸机开发

项目声明 Node >=20，Dockerfile 仍是 node:20-slim。安装要求不等于长期支持承诺，应按官方生命周期审查。建议在 Node 24 验证兼容，再单独升级镜像基线，不宣称当前已验证升级。

本机准备 Node 和 MySQL（可用原 Docker mysql 容器：docker compose -f docker-compose.yml up -d mysql）。.env 用 DB_HOST=127.0.0.1、DB_PORT=3310（对应该容器）、DB_NAME=plus_papay 和真实数据库账号密码。停掉其他共库 app，避免冲突。

```powershell
node --version
npm --version
npm ci
npx playwright install chromium
npm test
node --check server.js
node --check index.js
npm start
```

Linux 安装浏览器/系统库改用 npx playwright install --with-deps chromium。npm start 常驻窗口；Ctrl+C 停止，npm run start:headful 用于本机可见浏览器诊断。无桌面 Linux 优先 HEADFUL=0。

MySQL 服务和目标 database 必须先存在；ensureReady 只建表/补列。通过交互 MySQL 客户端创建：

```sql
CREATE DATABASE plus_papay CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

应用账号需要目标库的建表/改表和数据权限。不要赋予不必要的全服务器权限。

使用现有 Python 模块时：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-hcaptcha.txt
.\.venv\Scripts\python.exe -m playwright install chromium
```

Linux 用 python3 -m venv .venv 和 .venv/bin/python。设置 HCAPTCHA_SOLVER_PYTHON 为对应解释器绝对路径。模块/模型可能额外下载，按健康检查实际结果确认。不要无故升级 lockfile 或拿真实账号执行 worker 验证安装。

## 8. 首次后台配置顺序

1. 默认 /admin-login 登录，/admin 面板；自定义路径以配置为准。管理员邮箱、登录密码、二级密码应在首次库初始化前设置。已初始化后改 .env 不会重置后台密码，用后台修改。
2. 受限网络下更换默认密码，配置二次验证，保存恢复方式并确认服务器时间准确。默认管理员 token 24 小时、二级 30 分钟、挑战 5 分钟；登录限流主要含内存状态，不替代边缘防护。
3. 打开维护，前台并发设 1、池槽位设 1。数据库配置可能优先于 env 默认，先确认后台当前值。
4. 确定本地/供应商模式，活跃任务期间不切换。
5. 本地模式按需要录入和测试代理。容器的 127.0.0.1 是容器自身；Docker Desktop 可按环境用 host.docker.internal，Linux 明确可达地址。
6. 核对地区/币种：代码 PH/PHP、US/USD、SG/SGD、MY/MYR。真实账单地址与套餐地区不是同一概念；禁止用随机地址代替授权资料。
7. 专用银行卡池导入解析“卡号|有效期|CVC|持卡人”，每行一条、接口上限 500 条；有效期以页面和服务端校验为准。其他旧编辑器格式可能不同。仅导入授权资源，列表应脱敏，密钥应持久化。
8. 生成少量“自助”CDK 并选择套餐，检查状态后分发。管理员手动启动同样可能付款。
9. 可选 Telegram，测试消息。通知成功不证明充值成功，通知失败不应再付一次。
10. 按第 14 节验收后关闭维护，小流量开放。

比特浏览器模式额外安装/运行外部软件，准备既有 profile ID 与可达 API，设置 BROWSER_PROVIDER=bitbrowser 等变量。容器不会自动安装该软件或创建环境，同一个环境串行使用。

## 9. 用户操作与异常核对

用户输入 CDK → 校验套餐 → 用自己的登录浏览器获取完整 Session JSON → 粘贴 → 明确点击确认启动 → 保存 jobKey/用 CDK 查询 → 核对订阅和账单。

Session 是登录凭据，按密码保护；不要贴到公开聊天，不写入 URL。accessToken 不等于登录 Cookie，token-only 可能通过初步校验但不能打开已登录 Checkout；字段支持以 session-auth.js 为准。粘贴不应自动付款，等待时不要重复提交/切换账号。

成功付款与取消自动续费是两件事。AUTO_CANCEL_RENEW=1 会在支付后尝试取消未来续费，取消失败需单独处理，不意味着支付失败。后台恢复/取消按钮会改变真实订阅，须符合账号持有人意图。

manual、超时、断线：先查任务日志、外部订单、订阅与实际账单；无法确认时不解锁、不重复付款。管理员确认未完成后再决定处理 CDK。现有界面不保证有一键安全重置，禁止靠删除任务或随意 SQL 代替核对。

订阅查询的实际路径是 `/subscription`，当前标题“发票助手”，能力以实际返回为准，不保证生成特定发票文件。卡池枯竭先补授权资源，拒付区分银行、余额、资料和页面原因，不盲目换卡循环。

## 10. 第三方代充

后台配置受信任供应商 Base URL/API Key → 测试套餐/余额 → 映射套餐 → 启用。默认地址只是代码默认值，不代表可用性或可信度保证。核对对接api.md 与供应商现行协议、权限和费用。

客户端涉及 /plans、/balance、/pay/inspect、/pay、/pay/orders/{order_id}、/tasks/{task_id}。开启后会向供应商发送 Session，先确认授权、数据处理、额度、套餐和网络。它不使用本地卡池支付，但启动仍可能预热池；纯 API 应在后台关闭池并确认日志，原镜像仍会安装 Python/浏览器。

外层 done 不等于业务成功，超时先查已存在订单，不能直接重新建单。供应商幂等和线上结果核对未在本文编写时验证。


## 11. 线上主机准备

建议单机 x86_64 Ubuntu 24.04、4 核 8GB 起步。准备 SSH 密钥、管理账号、云控制台恢复入口。安全组只开放 80/443 和受限 SSH；先放行实际 SSH 端口再改防火墙，避免锁死。

按 Docker 官方 Ubuntu 文档配置 apt 源后，执行下面安装命令。已有 Docker 的机器先核对，不盲目卸载。主机无需另装 Node/Python。不要公开 MySQL、CDP 9222/19222+、比特浏览器 API。Docker 发布端口与主机防火墙存在交互，最终从外部核对暴露面。

用私有 Git 或受控文件传输把已审查源码放到 /opt/kc-pay-gpt。不要上传真实 .env、Session、卡片、浏览器 profile、备份或调试日志到公共仓库。后续命令均以此目录为基准。

```bash
# After configuring Docker's official apt repository:
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker compose version
sudo mkdir -p /opt/kc-pay-gpt
# Transfer reviewed source into this directory, then:
cd /opt/kc-pay-gpt
```


## 12. 创建独立生产配置

以下是待创建/验证的模板，本次没有替你部署。保存为项目根目录 compose.prod.yml，所有命令显式用 -f compose.prod.yml -p kc-prod，不混用原开发项目/卷。

先从 .env.example 复制私有 .env，并设置：

- DB_NAME=plus_papay；DB_PASSWORD 是应用用户密码；另新增 DB_ROOT_PASSWORD，使用不同强密码。
- ADMIN_EMAIL、ADMIN_PASSWORD、ADMIN_SECONDARY_PASSWORD 替换默认值；ADMIN_TOKEN_SECRET 显式随机。
- CARD_ENCRYPTION_KEY 固定为 64 位 hex。命令 openssl rand -hex 32 生成一次，另一次独立输出作 token secret。只在私密终端运行并安全备份。
- 迁移已有加密数据必须保留原密钥，不可重新生成。环境密钥优先于文件，错误 env 能覆盖正确旧文件。
- BROWSER_PROVIDER=chrome、HEADFUL=0、BROWSER_POOL=1、BROWSER_POOL_SIZE=1、BROWSER_POOL_MAX_SIZE=2、RECORD_VIDEO=0、MAX_PROCESS_ATTEMPTS=1；后台并发也设 1。
- 明确 CHECKOUT_MODE、CHECKOUT_UI_FALLBACK、AUTO_CANCEL_RENEW。促销不确定则 CHECKOUT_PROMO_CAMPAIGN=none。

构建前审查 Dockerfile 的 Node20 基线，在验证后单独升级；Python 依赖未完整锁版本，正式发布需固定并验证。首次 PyTorch/浏览器下载较大。

**构建秘密保护**：扩充 .dockerignore 排除 data/、backups/、.venv/、*.log、私有 SQL、真实 Session 文件和临时脚本。现有规则只排除 data/browser-pool，COPY . . 可能把 data/card-encryption.key 烘焙进镜像。本文没有改现有忽略文件，部署者必须实际处理。

模板用专用数据库用户 kc_app；初始化为其授予目标库权限，满足现有 schema migration，不使用 root 作为 app 用户。MySQL 无宿主端口，app 仅绑定 127.0.0.1:3100。8GB 主机示例 app 上限5GB、mysql上限1GB，实际 OOM 先降并发再调整。共享内存计入真实资源，不另加可用 RAM。现有数据库密码不会因改 env 自动变化。

env_file 解决原 Compose 配置漏传，但也把 DB_ROOT_PASSWORD 带进 app 环境（app 不使用它）；正式强化可拆出专用 app env 文件减小暴露。模板未实现 Docker secrets。生产不挂载源码，以镜像版本为准。

```yaml
name: kc-prod
services:
  mysql:
    image: mysql:8.0
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: ${DB_ROOT_PASSWORD:?Set DB_ROOT_PASSWORD}
      MYSQL_DATABASE: ${DB_NAME:-plus_papay}
      MYSQL_USER: kc_app
      MYSQL_PASSWORD: ${DB_PASSWORD:?Set DB_PASSWORD}
    volumes:
      - mysql_data:/var/lib/mysql
    mem_limit: 1g
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
  app:
    build: .
    image: kc-pay-gpt:${APP_IMAGE_TAG:-local}
    restart: unless-stopped
    init: true
    env_file:
      - .env
    environment:
      NODE_ENV: production
      PORT: "3000"
      DB_HOST: mysql
      DB_PORT: "3306"
      DB_USER: kc_app
      DB_NAME: ${DB_NAME:-plus_papay}
      DB_PASSWORD: ${DB_PASSWORD:?Set DB_PASSWORD}
      HEADFUL: "0"
    depends_on:
      mysql:
        condition: service_healthy
    ports:
      - "127.0.0.1:3100:3000"
    volumes:
      - ./data:/app/data
      - ./debug_screenshots:/app/debug_screenshots
      - ./product_files:/app/product_files
    shm_size: "2gb"
    mem_limit: 5g
    stop_grace_period: 60s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
volumes:
  mysql_data:
```


### 12.1 启动与健康检查

Compose environment 显式设置优先于 env_file；容器 PORT=3000 与宿主3100分开。修改 env 后重新创建，restart 不更新注入环境。

先创建持久目录，chmod .env。当前镜像默认 root；若改非 root，还需处理挂载权限与浏览器安装路径。先启动 mysql、等健康后启 app，公网暂不放流量。config --quiet 只验证结构，不证明能运行；不要公开完整 config 输出，里面可能有密码。

mysql 健康检查只代表数据库进程响应；runtime success 才是应用基础检查，仍不代表付款验收。

```bash
cd /opt/kc-pay-gpt
chmod 600 .env
mkdir -p data debug_screenshots product_files
sudo docker compose -f compose.prod.yml -p kc-prod config --quiet
sudo docker compose -f compose.prod.yml -p kc-prod build app
sudo docker compose -f compose.prod.yml -p kc-prod up -d mysql
sudo docker compose -f compose.prod.yml -p kc-prod ps
# Wait until mysql is healthy before continuing.
sudo docker compose -f compose.prod.yml -p kc-prod up -d app
sudo docker compose -f compose.prod.yml -p kc-prod logs --tail 100 app
curl --fail http://127.0.0.1:3100/api/public/runtime
curl --fail http://127.0.0.1:3100/api/public/payment-region
```


## 13. 域名、Nginx、HTTPS

域名 A 指向服务器，IPv6正确配置后才加AAAA。安装 Nginx，下面保存为 /etc/nginx/sites-available/kc-pay-gpt，替换域名并启用。不删除已有其他站点。

nginx -t 通过才 reload。DNS/80可达后申请证书，下方采用 Ubuntu Certbot 包；已有证书管理系统沿用现有方式，避免重复安装。确认 HTTPS、HTTP跳转与自动续期。

WebSocket 与 HTTP 同源，必须转发 Upgrade/Connection。当前代码读取 X-Forwarded-For 首值，本例唯一边缘代理覆盖为 remote_addr，不拼接客户端自报地址；有 CDN/多级代理必须先配置可信真实IP链。回源3100不公开，data/截图不得另设公开静态目录。

```nginx
server {
    listen 80;
    server_name recharge.example.com;
    client_max_body_size 15m;
    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
    }
}
```

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
# Save the configuration above before enabling it.
sudo ln -s /etc/nginx/sites-available/kc-pay-gpt /etc/nginx/sites-enabled/kc-pay-gpt
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d recharge.example.com
sudo certbot renew --dry-run
```


## 14. 上线验收清单

- [ ] 容器无重启循环、DB报错、解密失败、浏览器缺失；本机 runtime 和 region 正常。
- [ ] 公网只开放预期端口，DB/CDP不公开，HTTPS有效。
- [ ] 默认密码更换、token secret 显式设置；登录、二次验证、退出、过期流程可用。
- [ ] 首页、后台、手机布局正常，CSS/脚本无404；无效输入/维护提示清楚。
- [ ] 后台池大小/并发正确，资源脱敏显示；不要把浏览器进程启动当登录验证成功。
- [ ] 对授权账号执行支付链接调试前，明确选择调试入口。它建单后退出，不调用付款；不是完整卡片审查。
- [ ] 实际充值验收需另外明确账号、金额、操作时间授权，只先跑一单；核对账单、订阅、CDK、续费。
- [ ] 刷新/断线恢复原任务而非建新单；manual保留锁且提示人工核对。
- [ ] 完成一套备份，并在隔离环境恢复验证原密文可解。

本文没有替你执行这些线上检查。单元测试不能证明真实付款、外部页面/验证、云网络或完整镜像构建成功。




## 15. 日常运维与停机

每日看 active/manual/失败、卡池余量、通知、数据库空间、证书与备份。观察 CPU峰值、RAM、OOMKilled、重启次数、任务耗时，而非仅平均CPU。磁盘增长主要来自镜像、截图录像、日志和数据库。

按jobKey固定时间线；日志/媒体可能含邮箱地址等，不能认定脱敏彻底。制定保存期，如诊断媒体7–14天（依业务要求调整）。先预览清理范围、确认无活跃任务和待核对证据再删除；数据库可能仍引用已删文件。

维护顺序：后台维护/排空 → 等现有任务完成并核对 → 备份 → 停app → 变更 → 启动检查 → 关闭维护。当前 SIGTERM 会清理并退出，stop_grace_period 不表示代码会自动等待付款结束。禁止在付款中随意重启。

不要靠swap维持正常浏览器并发。内存不足先降任务数；浏览器故障查上下文、进程、网络/页面，不无限循环建单重启。

```bash
sudo docker compose -f compose.prod.yml -p kc-prod ps
sudo docker compose -f compose.prod.yml -p kc-prod logs --tail 200 app
sudo docker stats --no-stream
df -h
free -h
sudo docker compose -f compose.prod.yml -p kc-prod exec app node --version
```


## 16. 备份：数据库、原密钥、文件成套保存

至少备份数据库、对应源码/镜像标签、.env、compose.prod.yml、data（原card-encryption.key及配置）、需要保留的product_files和诊断证据。数据库含Session/配置秘密，即使卡字段加密，备份仍高度敏感。

以下在Linux项目目录运行，先维护排空。backup放源码外，umask077。停app，mysql继续运行；无业务写入窗口中dump与文件保持一致。mysqldump从容器环境读取root密码，不把秘密放宿主命令参数，但仍有环境暴露，不等于完整秘密管理。

set -e 失败就停止；失败后检查原因，确认安全再手动启动app。完成后加密异地保存，校验哈希并恢复演练；数据库/密钥分别控制访问。丢密钥不能恢复密文，备份包不得公开下载。命令仅对应第12节模板，不能混用旧Compose名。

```bash
set -e
umask 077
cd /opt/kc-pay-gpt
backup_dir="/opt/kc-backups/$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -m 700 -o "$(id -u)" -g "$(id -g)" "$backup_dir"
sudo docker compose -f compose.prod.yml -p kc-prod stop app
sudo docker compose -f compose.prod.yml -p kc-prod exec -T mysql sh -c   'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --single-transaction --routines --events --triggers --hex-blob --no-tablespaces "$MYSQL_DATABASE"'   > "$backup_dir/database.sql"
sudo tar -czf "$backup_dir/private-files.tar.gz" .env compose.prod.yml data product_files
sudo chown "$(id -u):$(id -g)" "$backup_dir/private-files.tar.gz"
chmod 600 "$backup_dir"/*
sha256sum "$backup_dir/database.sql" "$backup_dir/private-files.tar.gz" > "$backup_dir/SHA256SUMS"
sudo docker compose -f compose.prod.yml -p kc-prod up -d app
```


## 17. 恢复、迁移、升级回滚

### 17.1 恢复操作

1. 在受限主机/隔离空目录准备对应源码。禁止客户流量；同机演练必须用不同项目名、目录、端口，不能共用原库。
2. 校验SHA256SUMS，tar -tzf先查看包内容，再解压到正确空目录。不要覆盖运行中的生产目录。
3. 恢复原.env、密钥、配置与文件，用原数据库版本建新mysql卷。确认库名/密码。库名变更要先明确导入策略。
4. mysql就绪后，用下面命令导入已确认目标库。它改变数据库，只对隔离恢复库或授权恢复执行。
5. 启动app前复核环境密钥与备份一致，不能新生成；环境优先于文件。校验挂载权限。
6. 启动会执行迁移与running恢复，检查历史任务、脱敏资源、解密、维护。恢复策略按进度回滚部分CDK，不代表外部订单失败。
7. 人工核对中断订单/订阅，避免双执行后再切换DNS/代理。

### 17.2 发布与回滚

先维护排空、备份、记录版本/镜像，再构建、启动和验收。APP_IMAGE_TAG用唯一发布标签，不一直用local覆盖旧镜像。配置改变要recreate。

回滚必须匹配源码/镜像/数据库schema/原密钥。迁移后旧代码不一定兼容。恢复快照需要核算快照后的实际支付，不能为了回滚UI丢业务账单。

不要 docker compose down -v，不运行未理解的reset-db.js。项目名决定卷名，换-p后看不到旧数据先查卷映射，不要初始化/删除旧卷。

```bash
# Only after verifying an ISOLATED/authorized target database:
# Replace /secure/restore/database.sql with your verified dump.
sudo docker compose -f compose.prod.yml -p kc-prod exec -T mysql sh -c   'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot "$MYSQL_DATABASE"'   < /secure/restore/database.sql
```


## 18. 故障排查表

| 表现 | 先查 | 原则 |
| --- | --- | --- |
| DB拒绝连接 | mysql健康、DB_HOST/PORT、网络 | 裸机宿主端口，容器mysql:3306 |
| Access denied/未知库 | 实际账号密码、卷历史 | env不会修改旧卷密码，不删卷碰运气 |
| 解密失败 | 原key、env优先级、data挂载 | 恢复原key，新key无效 |
| 后台密码不对 | 首次初始化值、实际连接库、改密历史 | env不是重置工具 |
| 502 | app状态、本机3100、upstream | 从本机runtime逐层排 |
| 413 | Nginx body与JSON_BODY_LIMIT | 合理对齐，不无限放开 |
| 无实时进度 | WebSocket101、Upgrade头、jobKey/心跳 | 不重新建充值任务 |
| 浏览器缺失 | 构建/Playwright安装/系统库 | 依赖变更后重建镜像 |
| 浏览器OOM | 退出原因、RAM、shm、并发 | 降并发、查峰值/泄漏 |
| 没登录 | Session过期、Cookie、账号 | token不是Cookie |
| 403/验证 | 正常登录、网络、页面提示 | 人工正常验证，不循环建单 |
| 无购买入口 | 已有订阅、资格、真实页面 | 已订阅未必能再买 |
| manual/超时 | 订单、订阅、账单、日志 | 先核对后恢复，不重复付款 |
| 供应商401/403 | key、scope、base URL | 不打印完整key |
| 取消续费失败 | 生效延迟、平台返回 | 与付款结果独立 |
| 配置不生效 | DB覆盖、是否recreate | 找到实际配置来源 |

固定同一jobKey的时间线，一次只调整一个因素，避免同时改代理、地区、Session和支付代码导致无法归因。




## 19. 开发验证与未完成事项

隔离开发库，npm ci后npm test，JS修改跑node --check。当前有API契约、卡片加密、脱敏、续费、Session/Checkout、生命周期回归，不覆盖所有UI、数据库并发、云环境、真实支付。

历史记录10文件50测试通过；不是本文重新执行结果。生命周期回归包括非持锁请求不解锁、同码互斥、准入预占名额、关闭录像仍清理、池探活独占、success/manual/worker异常保留CDK，依赖注入不替代集成验证。

后续需单独做：持久化支付状态机/对账、供应商幂等、分布式调度、强杀回收、完整敏感数据审计、依赖锁定/镜像升级、UI浏览器回归。不要描述为已完成。

当前npm脚本只有start、start:headful、test、test:watch；没有已删除目录的start:local、test:all、review:external。




## 20. 交接与证明边界

交接源码/镜像版本、主机域名、实际Compose名/目录、数据库版本与备份位置、原密钥保管、管理员/二次验证恢复、模式/并发、保留期、已知问题与最近核对记录。密码、Session、卡片、代理秘密单独私密交接，不写入手册。

事故顺序：维护阻止新任务 → 保存jobKey/证据 → 核对外部结果 → 决定恢复/回滚。

本文不是“已上线、真实支付通过、支付卡行业合规”的证明。实现保存加密CVC等，字段加密不等于合规认证；正式运营前需处理实际支付数据存储要求与代码限制。附录是实现索引，不表示所有接口可公开或变量都应启用。




## 附录 A：逐项配置索引

仅提取公开.env.example，未读真实.env。空值需设置或按源码回退；注释项未必启用。默认密码必须替换。部分变量为历史/可选入口，非当前worker必用。

| 变量 | 示例值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 见对应源码与上文 |
| `JSON_BODY_LIMIT` | `15mb` | 见对应源码与上文 |
| `ADMIN_TOKEN_SECRET` | `(empty)` | 留空将基于 cwd 派生 |
| `ADMIN_EMAIL` | `admin@vru.cc` | 首次建库时的默认管理员邮箱 |
| `ADMIN_PASSWORD` | `admin123` | 首次建库时的默认登录密码 |
| `ADMIN_SECONDARY_PASSWORD` | `admin123` | 首次建库时的默认二级密码（卡池/CDK/Session） |
| `ADMIN_LOGIN_PATH` | `admin-login` | 首次建库时的默认登录入口路径（可后台修改） |
| `ADMIN_PANEL_PATH` | `admin` | 首次建库时的默认管理后台路径（可后台修改） |
| `DB_HOST` | `127.0.0.1` | 见对应源码与上文 |
| `DB_PORT` | `3306` | 见对应源码与上文 |
| `DB_USER` | `root` | 见对应源码与上文 |
| `DB_PASSWORD` | `(empty)` | 必填：MySQL 密码 |
| `DB_NAME` | `plus_papay` | 见对应源码与上文 |
| `DB_POOL_LIMIT` | `60` | 见对应源码与上文 |
| `HEADFUL` | `0` | 1 = 有头模式（调试用） |
| `CHROMIUM_CHANNEL` | `(empty)` | 留空使用 Playwright 自带 Chromium；可选 chrome / msedge |
| `BROWSER_POOL` | `1` | 1 = 默认启用浏览器池；也可在后台「浏览器池」页切换（写入 MySQL，优先生效） |
| `BROWSER_POOL_SIZE` | `2` | 池大小，建议与前台并发一致 |
| `BROWSER_POOL_MAX_SIZE` | `24` | 槽位上限（128G 独服可设 16–24） |
| `BROWSER_POOL_BASE_PORT` | `19222` | 槽位 CDP 起始端口（slot-N 使用 BASE+N） |
| `BROWSER_PROVIDER` | `chrome` | 见对应源码与上文 |
| `BITBROWSER_API_URL` | `http://127.0.0.1:54345` | 见对应源码与上文 |
| `BITBROWSER_PROFILE_ID` | `(empty)` | 见对应源码与上文 |
| `BITBROWSER_HEADLESS` | `1` | 见对应源码与上文 |
| `BITBROWSER_OPEN_TIMEOUT_MS` | `60000` | 见对应源码与上文 |
| `HCAPTCHA_VLM_API_KEY` | `sk-...` | 见对应源码与上文 |
| `HCAPTCHA_VLM_BASE_URL` | `https://api.openai.com/v1` | 见对应源码与上文 |
| `HCAPTCHA_VLM_MODEL` | `gpt-5.5` | 见对应源码与上文 |
| `HCAPTCHA_CAPTCHA_PLATFORM_API_KEY` | `CAP-...` | 见对应源码与上文 |
| `HCAPTCHA_CAPTCHA_PLATFORM_API_URL` | `https://api.capsolver.com` | 见对应源码与上文 |
| `HCAPTCHA_CAPTCHA_PLATFORM_TIMEOUT` | `180` | 见对应源码与上文 |
| `CHATGPT_SESSION_COOKIE` | `(empty)` | 见对应源码与上文 |
| `HCAPTCHA_SOLVER_PYTHON` | `(empty)` | 见对应源码与上文 |
| `CHATGPT_TOKEN` | `(empty)` | 见对应源码与上文 |
| `STRIPE_KEY` | `(empty)` | 见对应源码与上文 |
| `CHECKOUT_MODE` | `ui` | 见对应源码与上文 |
| `CHECKOUT_UI_FALLBACK` | `1` | 见对应源码与上文 |
| `RECORD_VIDEO` | `0` | 见对应源码与上文 |
| `CHECKOUT_PROMO_CAMPAIGN` | `plus-1-month-free` | 见对应源码与上文 |
| `CHECKOUT_UI_MODE` | `custom` | 见对应源码与上文 |
| `AUTO_CANCEL_RENEW` | `1` | 见对应源码与上文 |
| `AUTO_CANCEL_RENEW_DELAY_MS` | `8000` | 见对应源码与上文 |
| `AUTO_CANCEL_RENEW_INTERVAL_MS` | `5000` | 见对应源码与上文 |
| `AUTO_CANCEL_RENEW_RETRIES` | `6` | 见对应源码与上文 |
| `BILLING_COUNTRY` | `US` | 见对应源码与上文 |
| `BILLING_ADDRESS` | `(empty)` | 见对应源码与上文 |
| `BILLING_CITY` | `(empty)` | 见对应源码与上文 |
| `BILLING_STATE` | `(empty)` | 见对应源码与上文 |
| `BILLING_ZIP` | `(empty)` | 见对应源码与上文 |
| `BILLING_NAME` | `(empty)` | 见对应源码与上文 |
| `BILLING_PHONE` | `(empty)` | 见对应源码与上文 |
| `CARD_ENCRYPTION_KEY` | `(empty)` | 见对应源码与上文 |
| `CARD_NUMBER` | `(empty)` | 见对应源码与上文 |
| `CARD_EXPIRY` | `(empty)` | 见对应源码与上文 |
| `CARD_CVC` | `(empty)` | 见对应源码与上文 |
| `PROXY` | `(empty)` | 见对应源码与上文 |
| `INBOX_API_BASE` | `(empty)` | 如：https://your-temp-email.example.com；历史/可选能力 |
| `INBOX_EMAIL_DOMAINS` | `(empty)` | 见对应源码与上文；历史/可选能力 |
| `RANDOM_EMAIL_DOMAIN` | `(empty)` | 见对应源码与上文；历史/可选能力 |

管理员身份/密码/路径主要首次初始化；维护/并发/地区/供应商/通知等在MySQL app_config；连接/密钥/浏览器/Checkout由进程环境读取。部分集成同步env到DB，不是所有变量DB优先，查对应getter/同步代码。

模板新增DB_ROOT_PASSWORD、APP_IMAGE_TAG，app不消费它们。源码另读PROCESS_IDLE_TIMEOUT_MS（默认3分钟无输出）、MAX_PROCESS_ATTEMPTS（1）、PAYMENT_MAX_CARD_ATTEMPTS（3）、ASSET_LOCK_STALE_MS（15分钟），不要盲目增加重试。

## 附录 B：数据库与持久化边界

```text
app_config
phone_assets
card_assets
cdk_codes
task_logs
activation_attempt_limits
product_assets
pool_emails
tax_free_addresses
proxy_assets
billing_records
admin_login_logs
```

app_config保存配置/密码哈希；card_assets保存卡片密文/后四位/状态；cdk_codes.used_at也表示占用；task_logs含任务/Session/输出；billing_records含账单；proxy_assets/tax_free_addresses是资源；activation_attempt_limits是冷却；admin_login_logs是安全事件。phone_assets、pool_emails、product_assets含历史能力，表存在不代表当前界面启用。启动迁移可补初始SQL未列字段，以运行schema/ensureLegacyColumns为准。卡片加密不代表Session、代理同等加密。

## 附录 C：HTTP路由索引

来自server.js注册，不是完整权限协议。/api/admin大部分统一鉴权，提前注册项单独鉴权；卡池/CDK/Session有二级权限。external/cards/push需读自身密钥检查。WebSocket订阅不是管理员授权，jobKey不应随意公开。字段/响应查handler；不提供付款触发curl，避免误执行。

```text
GET /admin
GET /admin-login
GET /admin-login/
GET /admin-login.html
POST /api/admin/login
POST /api/admin/login/send-tg-code
POST /api/admin/login/verify-2fa
GET /api/admin/runtime-logs
POST /api/admin/runtime-logs/clear
POST /api/admin/proxy/test
POST /api/external/cards/push
GET /api/public/admin-paths
POST /api/public/subscription/check
GET /subscription
GET /api/public/payment-region
GET /api/public/runtime
GET /api/admin/session
GET /api/admin/security/status
GET /api/admin/login-logs
GET /api/admin/secondary/session
POST /api/admin/verify-secondary
POST /api/admin/security/2fa-mode
POST /api/admin/security/paths
POST /api/admin/2fa/setup
POST /api/admin/2fa/confirm
POST /api/admin/2fa/disable
POST /api/admin/change-secondary-password
GET /api/admin/task-logs
GET /api/admin/data
GET /api/admin/browser-pool
POST /api/admin/browser-pool/mode
POST /api/admin/browser-pool/reload
GET /api/admin/sessions
GET /api/admin/sessions/:jobKey
POST /api/admin/subscription/cancel-auto-renew
POST /api/admin/subscription/enable-auto-renew
POST /api/admin/subscription/batch-renewal-status
GET /api/admin/screenshots
GET /api/admin/video
GET /api/admin/screenshots/:subdir/:filename
DELETE /api/admin/task-logs/:jobKey
POST /api/admin/telegram
POST /api/admin/telegram/test
POST /api/admin/hcaptcha
POST /api/admin/hcaptcha/test
POST /api/admin/hcaptcha/test-vlm
POST /api/admin/hcaptcha/test-captcha-platform
GET /api/admin/hcaptcha/logs
GET /api/admin/gpt-api
POST /api/admin/gpt-api
POST /api/admin/gpt-api/test
GET /api/admin/gpt-api/status
POST /api/admin/config
GET /api/admin/region
PUT /api/admin/region
GET /api/admin/checkout/plans
POST /api/admin/checkout/generate
GET /api/admin/checkout/status/:jobKey
GET /api/admin/cards
POST /api/admin/cards/import
DELETE /api/admin/cards/:id
GET /api/admin/proxies
POST /api/admin/proxies
PUT /api/admin/proxies/:id
POST /api/admin/proxies/:id/test
DELETE /api/admin/proxies/:id
GET /api/admin/addresses
POST /api/admin/addresses
POST /api/admin/addresses/generate-random-us
DELETE /api/admin/addresses/unbound
PUT /api/admin/addresses/:id
DELETE /api/admin/addresses/:id
POST /api/admin/change-password
GET /api/admin/cdks
POST /api/admin/cdks/generate
POST /api/admin/cdks/import
POST /api/admin/cdks/:cdk/ship
DELETE /api/admin/cdks/:cdk
GET /api/admin/billing
GET /api/admin/billing/export
GET /api/admin/billing/summary/:cardLast4
DELETE /api/admin/billing/failed
DELETE /api/admin/billing/:id
POST /api/run-process
POST /api/admin/trigger-activation
POST /api/verify-cdk
GET /api/cdk/query
GET /api/cdk/download
```

## 附录 D：官方参考

用于安装、生命周期和代理行为核对；项目行为来自本地代码，不是官方认证。Docker apt需先配置官方源，Nginx升级头参照WebSocket官方说明，Chromium需充足共享内存，Node20基线需按生命周期审查。

- [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Docker Compose plugin](https://docs.docker.com/compose/install/linux/)
- [Playwright Docker](https://playwright.dev/docs/docker)
- [Nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html)
- [Node.js release schedule](https://github.com/nodejs/Release#release-schedule)
