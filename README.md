# 方舟控制台

ARK: Survival Evolved（ASE）的中文 Web 管理后台，适配手机。React / MUI / Zustand 前端，Nest 管理服务，MySQL 持久化，Windows / Linux 主机助手。

平台部署一套后台，服主可以注册账号并申请独立工作空间。空间开通后，服主接入自己的主机，并可邀请其他账号协管主机、地图、互通组等资源。首次运行请使用空的 MySQL 数据库。部署与接入步骤见 [多服主部署](docs/WORKSPACES.md)。

支持公开 / preaquatica 分支选择与整组更新、按互通组管理玩家和封禁。商店可按互通组选择 ArkShop 或独立商店，提供金币、限时 VIP 与可导出的流水。请先阅读 [版本、用户与商店接入说明](docs/PLAYER-SHOP.md)，管理端与游戏电脑的助手需一起更新。

## 运行前准备

- Node.js 22.18+（本地已用 Node 26 验证）和 pnpm 12。
- MySQL 8.4+，或使用 `deploy/docker-compose.yml` 启动独立数据库。
- 管理端暂不需要安装游戏。每台游戏主机通过助手下载安装 ASE 服务端。
- Windows 游戏主机需要 VC++ x64 和 DirectX 运行库；Linux 需要可运行 SteamCMD 的 x86_64 环境及其 32 位库。缺失时 SteamCMD / 游戏的真实错误会显示在任务和运行日志。
- 游戏端口需要对玩家可达；公网远程管理使用 HTTPS。助手仅主动连接后台，不需要开放管理端口。

## 首次运行

```sh
pnpm install
pnpm run setup
pnpm dev
```

安装向导使用你输入的数据库管理账号建立独立应用账号，管理员密码可自行输入或自动生成。管理账号密码不保存。已有 `.env` 不会覆盖。

向导会逐行显示问题，直接回车使用方括号中的默认值。请在可以输入的 PowerShell / Windows Terminal 中运行；如果启动器不能转发输入，进入项目目录直接运行 `node scripts/setup.mjs`。连接数据库时会显示进度，连接超时为 8 秒。

打开 `http://127.0.0.1:5173`。正式运行：

```sh
pnpm build
pnpm start
```

正式运行的网页和 API 统一由 `http://127.0.0.1:3000` 提供；对应修改 `.env` 的 `APP_ORIGIN`。Windows 可双击 `start.cmd`。生产部署设 `NODE_ENV=production`，使用 HTTPS 反向代理，示例见 `deploy/Caddyfile.example`。

也可以复制 `.env.example` 手动配置。`JWT_SECRET` 至少 32 字符，`ENCRYPTION_KEY` 必须为 64 位十六进制随机字符串。不要更换已经使用的加密密钥，否则历史机器人 Secret 和实例 RCON 密码无法解密。

## GitHub Actions 前后端部署

GitHub Pages 可以发布浏览器前端。Nest API 和 MySQL 继续运行在自己的服务器，主机助手、QQ 回调和好友联机清单都连接 API 地址。用于正式商用时，请在自己的 HTTPS 站点托管管理后台。GitHub Pages 对商用 SaaS 有使用限制，也不建议通过 Pages 站点处理密码等敏感数据。[GitHub Pages 使用限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)

工作流通过 SSH 将 Nest API 发布到 Linux 服务器并由 PM2 启动，健康检查通过后发布 Pages 前端。首次接入、仓库 Secrets、服务器持久目录和回滚见 [SSH 与 PM2 部署](docs/PM2-DEPLOYMENT.md)。

## 接入游戏主机

1. 后台进入「主机管理」，添加主机并取得一次性接入码。
2. 从主机管理下载 Windows 主机助手并完整解压，双击 `ArkHostAgent.cmd`，填写游戏工作目录和接入码。下载时后台会写入管理地址。可设置为 Windows 用户登录后自动启动。
3. Linux 或从源码运行时，在游戏主机准备依赖并执行 `pnpm --filter @ark-control/agent build`。按后台命令接入，例如：

```sh
pnpm agent -- --enroll https://ark.example.com --code 一次性接入码 --root D:\ArkHost
```

Linux 把 root 换成 `/srv/ark-host`。本机可使用 `http://127.0.0.1:3000`。接入码一小时有效、仅使用一次，之后使用保存在助手配置中的专用令牌。

助手默认配置位于运行目录下 `.data/agent/config.json`，可通过 `--config` 指定绝对路径。主机文件都写入专用 root。助手退出后游戏进程继续运行，助手重新启动会核对程序路径，避免误操作复用的 PID。

Windows 开机运行可在具有任务注册权限的 PowerShell 执行 `scripts/register-agent.ps1 -ConfigPath 助手配置绝对路径`；Linux 服务示例见 `deploy/ark-agent.service`。

接入后新建地图，先准备服务端再启动。默认直接共用本机 `maps` 中同一 Steam 分支的文件；没有可用文件时才通过 SteamCMD 下载。多张地图可以共用一套地图资源，各自的配置、存档和日志保存在 `instances`。启动成功以本机 RCON 可响应为依据；外部玩家能否连接还取决于路由和防火墙。

当前不会扫描或导入 Steam 游戏安装目录。安装前会独立初始化 SteamCMD 并刷新应用信息；退出码 7 或明确的 `8 + Missing configuration` 会自动重试一次。失败时地图「任务」显示具体错误，主机助手保留应用安装和连接日志。安装路径、诊断日志与更新方法见 [安装排错说明](docs/INSTALL-TROUBLESHOOTING.md)。

地图列表与详情支持关闭、启动/重启、删除和安装失败后的重新安装。删除地图只回收该地图的数据，共用程序和地图资源留在 `maps`。「服务端文件」显示主机、路径、空间、版本及所有关联地图，也可以下载、导入、重命名、打开目录和校验。要释放公共文件占用的磁盘空间，请在解除关联后从文件库单独删除。详见 [服务端文件管理](docs/SERVER-FILES.md) 和 [地图与主机操作](docs/MAP-HOST-LIFECYCLE.md)。

未运行地图可以离线直接删除，已有存档由助手连接后回收，下载文件继续保留。请同时更新后台和各主机助手；新版后台会暂停向旧助手下发删除任务，避免旧行为清空下载文件。助手重连会保留原配置与内网 HTTP 授权；旧配置迁移、后台错误日志和升级说明见 [助手重连排错](docs/AGENT-RECONNECT.md)。

地图启动时会持续显示阶段、等待时间、PID、RCON 检测及最近日志；超时和提前退出会明确标记失败。详见 [启动反馈与排错](docs/STARTUP-TROUBLESHOOTING.md)。

## 好友免安装联机

Windows x64、Steam ASE 可以在「好友联机」创建入口与专属 `.exe`，朋友双击后自动连接、获取最新地址，并通过 Steam 进服。后台更换目标地图或游戏主机后，原客户端自动跟随；已在游戏中的玩家需要重新进服。

运行 `pnpm build` 会同时构建客户端。运行后台的本机也要接入主机助手，作为固定控制入口。无自有公网节点时利用 EasyTier 社区共享节点；跨网效果仍需朋友实测。操作、凭据范围和部署限制见 [好友联机说明](docs/FRIEND-CONNECT.md)。

## QQ 机器人

1. 「QQ 机器人」中保存你的默认机器人，或客户自带的 AppID / AppSecret。
2. 验证凭据。如果配置了腾讯 IP 白名单，需要允许管理服务的公网出口 IP。
3. 选择事件入口。推荐 HTTPS 回调：复制机器人卡片中的地址，在 QQ 开放平台配置公网 HTTPS 回调地址并订阅群 @机器人消息。服务端完成地址校验及 Ed25519 验签。没有公网回调入口且账号支持长连接时，可选 WebSocket，由后台分别建立连接。一个机器人只使用一种事件入口。
4. 把机器人加入目标群、允许主动消息；在后台生成绑定码，在目标群 @这台机器人 并发送绑定指令。
5. 绑定群出现后修改群备注，点击测试发送。在群内核对结果。
6. 「部落订阅」中由管理员设置地图实例、部落 ID、名称、机器人及其目标群。

HTTPS 回调地址形如 `https://ark.example.com/api/qq/webhook/机器人ID`，每台机器人不同。公网代理使用平台允许的 443 端口。客户自带机器人也要在其 QQ 开放平台填写对应回调地址；AppID 与 Secret 本身不会自动创建群绑定。开发环境的 localhost 地址不能供腾讯回调。

订阅会固定绑定具体机器人；修改全局默认选项只影响之后的新配置，不会把旧消息静默转发给另一台机器人。切换订阅机器人时需要重新选择属于它的群。密钥 AES-256-GCM 加密保存，前端不返回 Secret。

默认 30 秒固定合并窗口，以首条到达管理服务的时间为起点。去掉游戏时间和颜色标记后正文完全相同才合并，实体名或等级不同分别发送：

```text
孤岛-飞龙部落： 你的霸王龙已死亡 (3)
```

原始事件和待发送消息均在 MySQL 中持久保存。相同 `instanceId + sourceId` 重报只接收一次。发送队列按实际机器人限频：未认证 30 条/分钟，认证 60 条/分钟；单群关系 20 条/分钟、1000 条/天。超限保留待重试。平台最终权限以对应账号为准。

网络中断等导致发送结果不确定时，标为「发送结果待确认」并等待管理员核对，避免自动重试造成重复。API 接受消息不等于最终可见或成员已阅读。

## 部落日志来源

助手支持带部落 ID 的原生日志和结构化 JSONL。原生格式不能识别归属时，会在运行日志提示，绝不根据同名猜测并发送到其他部落。

Windows 提供 `native/ArkTribeBridge` 服务端插件源码。使用 ASE ArkApi SDK 编译后放到每个实例的插件目录；客户端无需安装此插件。插件监听原生 AddToTribeLog，输出部落 ID 和正文。助手优先读取插件 JSONL。SDK / DLL 必须与实际 ASE 版本匹配，需在真实服务器验收。

Linux 原生服务端不直接加载 Windows ArkApi DLL。需要确认原生日志具有部落标识，或使用相同 JSONL 约定的 Linux 侧采集适配器。严格部落分流建议先部署 Windows 游戏主机。

## 备份、互通与更新

备份保存 `ShooterGame/Saved`（世界、角色、部落、配置和日志），稳定复制后压缩上传，校验 SHA256。恢复先备份当前 Saved，再校验并替换；原目录也会保留在实例目录中。压缩包路径和符号链接均校验，防止写出专用目录。

互通组会自动设置 cluster ID 和本机互通目录。跨主机需要在助手接入时传 `--cluster-root`，指向各机器实际共享的目录；仅使用相同 cluster ID 不能自动建立跨机器文件共享。跨图传送目录不在单地图 Saved 备份中，应由共享存储单独备份；恢复前要求同组地图全部停止。

更新服务端前自动备份。地图详情的「模组 → 编辑」可多选常用 Workshop 模组，也可输入数字 ID。两个入口共用一份去重列表，使用上下箭头调整加载顺序。手写配置中的 `ActiveMods` 优先生效。Workshop 下载与 ASE 自动模组管理配合，实际解包和加载以启动日志为准。

当前只保留原始备份，不自动删除历史文件。请按实际空间规划后台和主机备份目录，并为在线备份失败准备停服备份。

## 工程与验证

本次交付的结果和接入边界见 [验收记录](docs/TEST-RESULTS.md)，复现步骤见 [验证说明](docs/verification.md)。

```sh
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

规则测试涵盖消息模板、内容归一化、来源解析、端口冲突、文件路径安全及 RCON 协议。执行 `pnpm test:e2e` 验证真实 MySQL / HTTP、固定 30 秒窗口、重复上报、后台重启恢复、游戏替身进程启停及浏览器页面；需要 Windows、MySQL 服务端程序、.NET Framework C# 编译器及 Edge / Chrome，详细见 `docs/verification.md`。

- `apps/web`：路由懒加载、错误边界、五主题策略、i18n、Zustand 全局状态与请求缓存。
- `apps/api`：统一响应/异常、短期访问令牌和 HttpOnly 刷新令牌、主机任务、QQ 适配与持久发送队列。
- `apps/agent`：出站接入、进程核对、RCON、SteamCMD、存档和日志游标。
- `common`：共享类型、业务校验、数据字典和纯业务规则。
- `docs/requirements.md`：确认需求与验收边界；`GLOSSARY.md`：领域词汇。

QQ 接口实现参照官方文档：[获取访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)、[HTTPS 回调](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html)、[签名校验](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html)、[群消息接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)。

当前管理服务按单个工作进程部署。所有写事务经数据库锁串行化，适合先运行和实测订阅规模；大规模部署应根据负载对事件表和发送队列进一步分区。

真实 ASE 启动、Workshop 下载和真实 QQ 群消息必须在接入实际主机/机器人后验收；自动检查不会下载完整游戏或给真实群发消息。
