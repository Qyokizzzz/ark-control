# GitHub Actions 与 PM2 部署

将项目内容提交到仓库根目录。在仓库 **Settings → Pages → Source** 选择 **GitHub Actions**。工作流 **Deploy Ark Control** 在默认分支上运行。GitHub 托管 Runner 拉取源码并构建前后端，随 API 发布包上传部署脚本。自托管 Runner 下载这份产物并在阿里云 ECS 本机发布 API。API 健康检查通过后发布 Pages。

## 仓库配置

1. 在 **Settings → Secrets and variables → Actions → Secrets** 设置仓库级 Secret `SERVER_HOST`。填写 API 域名、IP 或完整 HTTPS 来源，例如 `https://ark-api.example.com`。Pages 构建会将该 HTTPS 地址写入前端产物。
2. 在 **Settings → Actions → Runners** 将 ECS 上的 Runner 注册到该仓库。后端任务使用 `self-hosted` 和 `Linux` 标签调度。Runner 通过出站 HTTPS 访问 GitHub 和构建产物。 [GitHub Runner 网络要求](https://docs.github.com/en/actions/reference/runners/self-hosted-runners#communication-between-self-hosted-runners-and-github)
3. 可在 **Settings → Secrets and variables → Actions → Variables** 设置 `SERVER_DEPLOY_DIR`，填写 ECS 上的绝对路径。默认使用运行 Runner 的 Linux 用户的 `~/ark-control`。

## 服务器首次准备

1. 以运行 Runner 的 Linux 用户准备 Node.js 22.18+ 和 PM2。确认 Runner 的工作环境能找到 `node`、`pm2`、`tar` 和 `flock`（util-linux），且用户可写部署目录。GitHub 托管 Runner 将生产依赖打入发布包，ECS 运行解包后的 API。
2. 准备 MySQL 和应用数据库账号。将生产配置放到部署目录的 `shared/.env.prod`。已有部署可使用旧的 `shared/.env` 作为回退。初次配置可复制环境变量模板并填写数据库账号、应用密钥和初始管理员。沿用已有后台时，请保留数据库配置和密钥，并将已有的 `.data` 放到 `shared/.data`。自定义数据路径可在 `.env.prod` 中使用绝对路径。[环境变量模板](../.env.example)
3. 保持 API 在本机监听，经 HTTPS 反向代理对外提供服务。若 Pages 地址为 `https://your-account.github.io/ark-control/`，服务器配置可按下面填写。Caddy 可将 `ark-api.example.com` 反向代理到 `127.0.0.1:3000`。

   ```dotenv
   NODE_ENV=production
   API_HOST=127.0.0.1
   API_PORT=3000
   APP_ORIGIN=https://ark-api.example.com
   WEB_ORIGIN=https://your-account.github.io
   ```

4. 将已有的 Windows 主机助手包和独立商店插件包放进 `shared/artifacts/`。使用好友联机时，将已构建的 `ArkConnect.exe` 和 EasyTier 组件分别放到 `shared/native/ArkConnect/dist/` 和 `shared/native/ArkConnect/vendor/`。这些目录在后续发布中持续使用。
5. 从手工部署或另一个 Linux 用户切换时，用原用户停止旧后台并释放 `API_PORT`。若旧后台由 PM2 管理，可用 `pm2 delete ark-control-api` 移除旧进程。在 Actions 运行 **Deploy Ark Control**，之后推送默认分支会自动部署。Pages 地址形如 `https://your-account.github.io/ark-control/#/hosts`。跨站登录续期需要浏览器支持分区 Cookie。

## 运行与故障检查

PM2 进程名为 `ark-control-api`。工作流先校验和解包，再由 PM2 启动新版本，核对 `/api/health` 中的版本标识。失败时尝试恢复上一个已发布版本，并停止本次 Pages 发布。健康检查通过后调用 `pm2 save`，保留当前和上一个发布目录。配置、数据和下载组件留在 `shared`，MySQL 沿用服务器的实例。版本回滚恢复程序文件。

以部署用户执行 `pm2 status` 或 `pm2 logs ark-control-api` 查看状态。需要开机恢复时，在服务器上执行一次 `pm2 startup`，按 PM2 输出安装启动服务。[PM2 启动恢复说明](https://doc.pm2.io/en/runtime/guide/startup-hook/)
