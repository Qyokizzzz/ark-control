# 多服主部署

## 平台上线

1. 创建一个空的 MySQL 数据库，运行 `pnpm install` 和 `pnpm run setup:prod`。使用 `.env.prod` 的 `DATABASE_NAME` 指向这个数据库。安装向导创建的账号拥有平台审核权限，也拥有自己的工作空间。已有数据的单服主数据库可以留存供原版使用。
2. 配置 `APP_ORIGIN` 为服主实际打开的公网 HTTPS 地址，配置反向代理，将管理网页和 `/api` 转发到同一个 Nest API。API 默认监听本机，Caddy 示例见 `deploy/Caddyfile.example`。
3. 执行 `pnpm -r build` 构建管理服务、网页和 Agent，再用 `pnpm start` 启动后台。在装有 Node.js 的 Windows x64 电脑上执行 `pnpm run build:agent-package` 可生成 `artifacts/ArkHostAgent-Windows-x64.zip`。将此安装包放进后台项目的 `artifacts` 目录，或者在 `.env.prod` 中将 `AGENT_WINDOWS_PACKAGE_PATH` 指向它的绝对路径。已有发布包可直接上传。
4. 需要好友联机时，在 Windows 上执行 `pnpm run build:connect`。若管理后台在其他系统运行，把 `native/ArkConnect/dist/ArkConnect.exe` 和配套的 `native/ArkConnect/vendor` 部署到后台对应位置或使用 `.env.prod` 设置路径。公网 HTTPS 部署时，好友端通过平台取签名后的地图地址，游戏流量走目标主机的 EasyTier 通道。

## 服主和协管

- 服主在登录页注册，然后在「我的工作空间」提交开通申请。平台管理员在「平台审核」开通空间，可设主机、地图及协管人数额度。暂停空间会暂停其管理 API 和 Agent 领取任务，已运行的游戏进程继续运行。
- 服主进入「成员与权限」填写受邀账号邮箱，再按整个空间、指定主机、地图或互通组勾选权限。主机授权可以勾选包含已有及以后新建的地图。生成邀请后，把一次性代码交给受邀人。对方用匹配邮箱注册或登录，在「我的工作空间」接受，之后可用顶部选择器切换空间。
- 成员与权限由该空间的服主维护。平台审核权限用于工作空间状态和额度。业务权限由 CASL 执行，按工作空间与资源匹配。权限编号采用十进制字符串保存 BigInt 位掩码。
- 互通组的用户、金币、VIP 和商店数据共用整组范围。需要协管组级数据时，授予互通组或工作空间权限。主机接入权限能替换该主机的接入凭据，接入者可控制该主机上的全部地图。断开主机会关闭其上的地图。
- 邀请默认有效七天。平台审核服主的申请，受邀人凭匹配邮箱和服主交付的一次性代码加入。注册暂采用邮箱作为账号标识。

## 游戏主机接入

1. 在当前空间的「主机管理」添加主机，取得有效期一小时的一次性接入码。主机地址用于展示进服地址，可填写游戏主机的 IP 或域名。
2. 从「主机管理」下载 Windows 主机助手。下载包的 `ArkHostAgent.json` 会带上后台配置的管理地址。若配置为回环地址且 API 监听局域网，则使用后台主机的局域网 IPv4 和 `API_PORT`。在游戏主机完整解压，双击 `ArkHostAgent.cmd`，填写专用游戏工作目录和接入码。后台显示主机在线后，可新建地图并准备服务端。
3. 需要自动启动时，退出前台助手，再打开同目录的 `ArkHostAgent.cmd`，选择 `3`。Windows 用户登录后启动助手。接入和运行日志都保存在该目录的 `state/agent.log`，失败时窗口会停留并显示退出码。使用原目录重新接入可沿用游戏文件和运行配置。
4. Linux 主机走源码接入，部署 Agent 与依赖并用 `deploy/ark-agent.service` 作为 systemd 服务示例。单机可配置 `--cluster-root`，跨主机要把它指到服主实际共享的存储。游戏内部的互通标识由工作空间与互通组共同生成。

## 默认 QQ 机器人

设置 `PLATFORM_QQ_APP_ID`、`PLATFORM_QQ_APP_SECRET`，认证后可设置 `PLATFORM_QQ_CERTIFIED=true`。在腾讯开放平台设置 `https://后台域名/api/qq/webhook/00000000-0000-4000-8000-000000000001` 为事件回调，订阅群内 @机器人消息。每个空间在自己的「QQ 机器人」页面生成绑定码、绑定群并配置部落订阅。群授权和订阅按空间隔离，机器人和群的实际发送额度由各订阅共享。服主也可以添加自己的 AppID/AppSecret，按机器人卡片提示配置回调。

部落日志来源与插件安装仍按 [原项目说明](../README.md#部落日志来源) 操作。

## 本地验收

先构建网页、管理服务和 Windows 助手。在 Windows PowerShell 中执行 `$env:ARK_VERIFY_ONLY_WORKSPACES='1'`，再执行 `pnpm run test:e2e`。脚本使用独立的临时 MySQL 实例、浏览器和模拟 QQ 服务，覆盖注册审核、授权与撤销、分空间资源隔离、下载安装包和真实 Agent 心跳。
