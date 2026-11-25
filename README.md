# volc-usage

[![CI](https://github.com/tanjiangshan/volc-usage/actions/workflows/ci.yml/badge.svg)](https://github.com/tanjiangshan/volc-usage/actions/workflows/ci.yml)

火山AI网关每日 credit 用量仪表盘。数据直接来自网关自己的 `/v1/usage/*` 接口，因此 OpenCode、dsh、codex 以及其它设备只要用同一个 API Key，用量都会统计进来。

- 常驻网页仪表盘：`http://127.0.0.1:8788`
- 命令行：`today` / `week` / `month` / `watch`
- 每日额度阈值通知（默认 20/40/60/80/100/120%），支持飞书 / 钉钉 / 企业微信 / Slack / Telegram / 通用 Webhook
- 历史快照落地 SQLite，网关只保留最近 31 天也能留下长期记录
- 零运行时依赖，只用 Node 内置模块（`node:sqlite`、`fetch`）
- Windows / macOS / Linux 一键安装，自带便携版 Node 下载

> 只适用于提供 `/v1/usage/*` 用量接口的火山AI网关实例。网关地址是每个账号自己的，不是公共地址。

## 环境要求

- Windows 10/11、macOS 12+、常见 Linux 发行版
- Node.js >= 24；**没有也能装**，安装脚本会自动下载便携版 Node 到 `.runtime/`，不需要管理员权限
- 网页只监听 `127.0.0.1`，不会暴露到局域网

## 一键安装

解压/拷贝整个目录，然后按系统选一个入口：

| 系统 | 操作 |
| --- | --- |
| Windows | 双击 `setup.cmd` |
| macOS | 双击 `setup.command`（没有执行权限时先在终端跑 `chmod +x setup.command`） |
| Linux | 终端执行 `bash setup.sh` |

安装脚本会：

1. 检测 Node.js 24；没有就从 nodejs.org 下载便携版并校验 SHA256
2. 注册开机自启（Windows 启动文件夹 / macOS launchd / Linux systemd 用户服务）
3. 启动服务并等待健康检查
4. 自动打开 <http://127.0.0.1:8788>

首次打开会进入设置页，需要填两项：

- **网关地址**：形如 `https://xxxx.apigateway-cn-beijing.volceapi.com/v1`。可以从 OpenCode 的 `~/.config/opencode/opencode.jsonc` 里 provider `火山AI网关` 的 `baseURL` 复制，或在火山引擎 AI 网关控制台查看接入地址
- **API Key**：同一个网关的 Key

如果 OpenCode 已经配置好网关，服务会自动复用其中的地址和 Key，通常直接就能看到数据。

卸载（保留配置和历史）：

```bash
node install.mjs uninstall
```

彻底删除配置与历史：

```bash
node install.mjs uninstall --purge
```

不想注册自启、只手动运行：

```bash
node server.mjs
```

服务里记录的是安装时的 Node 绝对路径。升级、切换或删除 Node 后，重新运行一次 setup 脚本即可更新；`.runtime/` 只是便携版 Node，可以随时删除，下次安装会重新下载。

## 换电脑 / 多台电脑

每台机器独立运行一份即可，互相不依赖：

1. 拷贝整个项目目录（可以不带 `.runtime/`、`config.json`、`usage.db`）
2. 双击/执行对应系统的 setup 脚本
3. 网页里填写同一个网关地址和 API Key

说明：

- 同一个 Key 共用每日 150 credit，多台机器的用量会汇总，这正是网关口径
- 每台机器的历史库是独立的；网关只保留 31 天，跑一天后图表自动补齐
- 只想维护一份仪表盘时，可在运行服务的机器上开 SSH 隧道：
  `ssh -N -L 8788:127.0.0.1:8788 那台机器`，然后本机访问 <http://127.0.0.1:8788>
- 不要为了让别的机器访问而把监听地址改成 `0.0.0.0`：页面没有登录鉴权

## 数据口径

| 指标 | 来源 | 说明 |
| --- | --- | --- |
| 今日 credit | `/v1/usage/by-model?window=today` 的 `credit` 求和 | 权威口径；等于 `credit_breakdown.input + cached + output` |
| 今日 token / 请求 | `/v1/usage/summary` | 仅用于展示和覆盖校验，`summary` 没有 credit 字段 |
| 每日 credit | `/v1/usage/by-model?window=month` 按 `daily[].date` 聚合 | 权威口径 |
| 每日请求数 | `/v1/usage/daily?days=31` | `by-model` 窗口不返回请求数，这里补齐 |
| 按小时 | `/v1/usage/hourly` | 今日分时 token / 请求趋势 |

三种 credit 表示（顶层 `credit`、`credit_breakdown`、`daily[].credit`）不要相加，它们是同一份数据的三种视图。

`credit: null` 只在当天完全没有 token 和请求时按 0 处理；有消费但返回 `null` 或字段缺失时视为「未知」，此时暂停通知，避免把未知误判成 0。

日界线固定为 Asia/Shanghai 00:00。网关原生 week 从周一开始，month 为自然月。

## 开机常驻

安装脚本已经注册好自启，登录后自动运行：

| 系统 | 机制 | 查看状态 |
| --- | --- | --- |
| Windows | `%APPDATA%\...\Startup\volc-usage.vbs` | 任务管理器 → 启动 |
| macOS | `~/Library/LaunchAgents/com.volc-usage.dashboard.plist` | `launchctl print gui/$(id -u)/com.volc-usage.dashboard` |
| Linux | systemd 用户服务 `volc-usage` | `systemctl --user status volc-usage` |

Linux 如果希望**注销登录后也保持运行**，执行一次（需要 sudo）：

```bash
sudo loginctl enable-linger "$USER"
```

日志：

```bash
# Linux
journalctl --user -u volc-usage -f
# macOS / Windows
# 文件位于数据目录 logs/server.log
```

Windows 另外生成了 `start.cmd` / `stop.cmd`，需要手动启停时双击即可。

## 网关地址与 API Key

两者都按以下顺序解析，网页设置里保存的会覆盖后面：

| 配置 | 顺序 |
| --- | --- |
| 网关地址 | 环境变量 `VOLC_GATEWAY_BASE_URL` → `~/.config/volc-usage/config.json` 的 `baseUrl` → OpenCode provider `火山AI网关` 的 `settings.baseURL` |
| API Key | 环境变量 `VOLC_GATEWAY_API_KEY` → 同一配置文件的 `apiKey` → OpenCode provider 的 `settings.apiKey` |

网页设置保存到 `~/.config/volc-usage/config.json`，权限 `0600`。接口只返回 Key 末四位，不回显完整 Key、网关地址会正常显示（不含凭据）。

## CLI

```bash
node cli.mjs today                  # 今日额度、模型明细、近 7 天概况
node cli.mjs week                   # 本周每日用量
node cli.mjs month                  # 本月每日用量
node cli.mjs watch                  # 终端每 30 秒刷新，Ctrl+C 退出
node cli.mjs config show            # 查看配置与 Key 来源
node cli.mjs config set-base-url <url>  # 设置网关地址（会校验）
node cli.mjs config set-key <KEY>   # 保存 Key（先走本地服务校验）
node cli.mjs config clear-key       # 清除网页配置的 Key
node cli.mjs config set-limit 150   # 修改每日额度
node cli.mjs config set-notify on|off
node cli.mjs config set-webhook <url> [format] [secret]
node cli.mjs config clear-webhook
node cli.mjs config test-notify     # 通过本地服务发送测试通知
```

本地服务在运行时 CLI 直接读 `/api/state`（不额外打网关）；服务没起来时自动直连网关，只读不落库。

## 配置

配置文件：`~/.config/volc-usage/config.json`（可用 `VOLC_USAGE_CONFIG_DIR` 改目录）。

```json
{
  "baseUrl": "https://xxxx.apigateway-cn-beijing.volceapi.com/v1",
  "dailyCreditLimit": 150,
  "notify": true,
  "port": 8788,
  "webhook": {
    "url": "https://open.feishu.cn/open-apis/bot/v2/hook/...",
    "format": "auto",
    "secret": ""
  }
}
```

`baseUrl` 必填；`webhook` 可省略。完整默认值见 `config.example.json`。可覆盖的轮询间隔（毫秒）：

| 任务 | 默认 | 用途 |
| --- | --- | --- |
| `poll.today` | 60000 | 今日 credit，最敏感的额度判断 |
| `poll.month` | 300000 | 本月历史 |
| `poll.summary` | 600000 | token 展示与覆盖校验 |
| `poll.hourly` | 300000 | 今日分时图 |
| `poll.daily` | 1800000 | 每日请求数 / `complete` |

环境变量：`VOLC_GATEWAY_BASE_URL`、`VOLC_GATEWAY_API_KEY`、`VOLC_USAGE_PORT`、`VOLC_USAGE_DISABLE_NOTIFY=1`（只写日志，不发桌面通知）。

## 通知

按今日 credit 占额度的百分比触发，阈值默认 `[20, 40, 60, 80, 100, 120]`。一次跨多档只发最高档，低档同时标记为已处理；已通知档位写入 SQLite，重启不会重复发送。数据过期或 credit 未知时跳过。

推荐配置 Webhook（无桌面环境也能收到）：

| 类型 | `format` | 说明 |
| --- | --- | --- |
| 自动识别 | `auto` | 按 URL 域名识别飞书 / 钉钉 / 企业微信 / Slack / Telegram |
| 飞书 | `feishu` | 群机器人 Webhook；支持加签，密钥填 `secret` |
| 钉钉 | `dingtalk` | 群机器人 Webhook；支持加签，密钥填 `secret` |
| 企业微信 | `wecom` | 群机器人 Webhook |
| Slack | `slack` | Incoming Webhook |
| Telegram | `telegram` | URL 填完整的 `sendMessage` 地址，`chatId` 可选 |
| 通用 | `generic` | POST JSON：`{ source, title, text, timestamp }` |

### 获取飞书机器人地址

1. 打开飞书，进入接收提醒的群（建议单独建一个「额度监控」群）
2. 点右上角 `···` → **设置** → **群机器人** → **添加机器人**
3. 选择 **自定义机器人**，起名（如 `额度监控`），完成添加
4. 复制生成的 Webhook 地址，形如：
   ```
   https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```
5. 在「安全设置」里二选一：
   - **自定义关键词**：填 `火山` 或 `额度`（通知标题一定包含这两个词）
   - **签名校验**：复制飞书给的密钥，填到仪表盘的「签名密钥」
   - 不要选 **IP 白名单**，本机出口 IP 不固定
6. 打开仪表盘 → **设置 → Webhook 推送**，粘贴地址，类型留「自动识别」，点 **发送测试通知**

手机端路径相同：群聊 → 右上角 `···` → 设置 → 群机器人 → 添加机器人。

如果找不到「群机器人」，通常是当前账号不是群主/管理员，或企业管理员禁用了自定义机器人；换一个自己建的普通内部群即可。

### 钉钉 / 企业微信

- **钉钉**：群设置 → 机器人 → 添加机器人 → 自定义（通过 Webhook 接入）。安全设置选「加签」并把密钥填入「签名密钥」，或选「自定义关键词」填 `火山` / `额度`。
- **企业微信**：群 → 群机器人 → 添加 → 新创建一个机器人，复制 Webhook 即可，没有加签，密钥留空。
- **Telegram**：通过 `@BotFather` 建机器人，URL 填 `https://api.telegram.org/bot<token>/sendMessage`；`chatId` 需要在配置文件 `webhook.chatId` 里填，或直接拼在 URL 查询参数上。

也可以用命令行配置和测试：

```bash
node cli.mjs config set-webhook 'https://open.feishu.cn/open-apis/bot/v2/hook/...' feishu '<签名密钥，可省略>'
node cli.mjs config test-notify
```

Webhook 地址只保存在本机 `0600` 文件里，接口不回显完整地址或签名密钥。

常见失败：

- 飞书 `code=19021`：签名不匹配，检查密钥是否复制完整、类型是否误选
- 飞书 `code=19024`：关键词不匹配，把关键词改成 `火山` 或 `额度`
- 钉钉 `errcode=310000`：加签或关键词校验失败，同上处理
- 群里收不到但测试返回成功：检查机器人是否被移出群、是否发到了另一个群

没有配置 Webhook 时：Linux 尝试 `notify-send`，macOS 使用系统通知（`osascript`），Windows 直接写日志。都没有可用通知服务时退回日志。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 仪表盘页面 |
| GET | `/api/state` | 页面所需的完整快照 |
| GET | `/api/config` | 脱敏配置 |
| POST | `/api/config` | 更新 Key / 额度 / 通知 / Webhook |
| POST | `/api/notify-test` | 发送测试通知 |
| POST | `/api/refresh` | 手动刷新全部数据 |
| GET | `/api/health` | 存活检查 |

## 测试

```bash
npm test
```

覆盖 JSONC 解析、Key/地址优先级、credit 归一化与聚合、覆盖校验、时区边界、通知去重、Webhook 签名、SQLite 快照。

## 已知边界

- 本工具只观测，不代理、不拦截请求，也不会阻止超额调用；是否拒绝以网关实际响应为准。
- 网关 `summary` 与 `by-model` 的抓取时间相差过大时跳过覆盖校验，避免误报；credit 始终以 `by-model` 为准。
- `/v1/usage/daily` 默认只返回最近 7 天，代码显式请求 `?days=31`。
- 网关冷启动时 `/v1/usage/hourly` 可能返回 500 `function_dial_timeout`，客户端会自动重试。

## 项目结构

```
server.mjs            HTTP 服务 + 静态页面
cli.mjs               命令行
install.mjs           跨平台安装 / 卸载
setup.sh|.command|.cmd 启动安装的入口（自动准备 Node）
lib/config.mjs        配置、JSONC、Key/地址解析
lib/gateway.mjs       网关请求、重试、缓存绕过
lib/credit.mjs        credit 归一化、聚合、覆盖校验
lib/runtime.mjs       轮询、快照、通知评估
lib/store.mjs         SQLite 历史与通知去重
lib/notify.mjs        Webhook / 桌面通知
lib/time.mjs          Asia/Shanghai 时间边界
public/index.html     仪表盘（无 CDN、手写 SVG）
test/                 node:test 单元测试
```

## 开发

```bash
node server.mjs        # 前台运行
npm test               # 单元测试
```

网页在 `public/index.html` 内联 CSS/JS，无构建步骤。CI 在 Ubuntu / macOS / Windows 上跑同一套测试。

## 隐私

- API Key、Webhook 地址、签名密钥只保存在本机 `~/.config/volc-usage/config.json`（0600），不会上传
- 用量历史只保存在本机 SQLite
- 仪表盘只监听 `127.0.0.1`

## License

[MIT](LICENSE)

