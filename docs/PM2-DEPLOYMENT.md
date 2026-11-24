# GitHub Actions、SSH 与 PM2 部署

将项目内容提交到仓库根目录。在仓库 **Settings → Pages → Source** 选择 **GitHub Actions**。工作流 **Deploy Ark Control** 在默认分支上运行，先构建前后端，再通过 SSH 发布 API，最后发布 Pages。

## 仓库配置

在 **Settings → Secrets and variables → Actions → Secrets** 设置以下值。

| Secret               | 填写内容                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `SERVER_HOST`        | 服务器 SSH 主机名或 IP，例如 `203.0.113.10`                                                                                     |
| `SERVER_USER`        | 负责部署和运行 PM2 的 Linux 用户                                                                                                |
| `SERVER_SSH_KEY`     | 此账户专用的无口令部署私钥。对应公钥加入服务器该用户的 `~/.ssh/authorized_keys`                                                 |
| `SERVER_KNOWN_HOSTS` | 从服务器控制台核对过的 OpenSSH 主机公钥行。22 端口使用 `主机名 ssh-ed25519 公钥`，其他端口使用 `[主机名]:端口 ssh-ed25519 公钥` |
| `SERVER_PORT`        | 可选，SSH 端口，默认 `22`                                                                                                       |

在同一页面的 **Variables** 设置 `VITE_API_ORIGIN`，例如 `https://ark-api.example.com`。这是浏览器访问的 HTTPS API 来源，会进入前端构建产物。可选变量 `SERVER_DEPLOY_DIR` 填写服务器绝对路径，默认使用 SSH 用户的 `~/ark-control`。

## 服务器首次准备

1. 使用部署用户准备 Node.js 22.18+ 和 PM2，并确认非交互式 SSH 能找到 `node` 和 `pm2`。服务器需要 `tar` 和 `flock`（util-linux）。部署用户需要能写入部署目录，GitHub Actions 运行器需要能访问服务器的 SSH 端口。GitHub 在运行器上构建并打包 Node 生产依赖，服务器直接运行解包后的 API。
2. 准备 MySQL 和应用数据库账号。将 API 的 `.env` 放到部署目录的 `shared/.env`。初次配置可复制 [环境变量模板](../.env.example)，填写数据库账号、应用密钥和初始管理员。如已有后台，沿用数据库配置和密钥，并将要继续使用的 `.data` 放到 `shared/.data`。现有环境使用自定义相对数据路径时，可在 `.env` 中改用对应的绝对路径。
3. 保持 API 在本机监听，经 HTTPS 反向代理对外提供服务。若 Pages 地址为 `https://your-account.github.io/ark-control/`，服务器配置可按下面填写。Caddy 可将 `ark-api.example.com` 反向代理到 `127.0.0.1:3000`。

   ```dotenv
   NODE_ENV=production
   API_HOST=127.0.0.1
   API_PORT=3000
   APP_ORIGIN=https://ark-api.example.com
   WEB_ORIGIN=https://your-account.github.io
   ```

4. 将已有的 Windows 主机助手包和独立商店插件包放进 `shared/artifacts/`。使用好友联机时，将已构建的 `ArkConnect.exe` 和 EasyTier 组件分别放到 `shared/native/ArkConnect/dist/` 和 `shared/native/ArkConnect/vendor/`。这些目录在后续发布中持续使用。
5. 若服务器正运行旧后台，首次切换时先停止旧后台并释放 `API_PORT`。在 Actions 运行 **Deploy Ark Control**，之后推送默认分支会自动部署。Pages 地址形如 `https://your-account.github.io/ark-control/#/hosts`。跨站登录续期需要浏览器支持分区 Cookie。

## 运行与故障检查

PM2 进程名为 `ark-control-api`。工作流先校验和解包，再由 PM2 启动新版本，核对 `/api/health` 中的版本标识。失败时尝试恢复上一个已发布版本，并停止本次 Pages 发布。健康检查通过后调用 `pm2 save`，保留当前和上一个发布目录。配置、数据和下载组件留在 `shared`，MySQL 沿用服务器的实例。版本回滚恢复程序文件。

以部署用户执行 `pm2 status` 或 `pm2 logs ark-control-api` 查看状态。需要开机恢复时，在服务器上执行一次 `pm2 startup`，按 PM2 输出安装启动服务。[PM2 启动恢复说明](https://doc.pm2.io/en/runtime/guide/startup-hook/)
