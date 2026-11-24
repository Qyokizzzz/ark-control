# 安装服务端失败与已有游戏目录

## 先区分安装和启动

「安装服务端」在主机助手所在的游戏机器上调用 SteamCMD，下载/更新 ASE 专用服务端（App ID `376030`）。「启动」则运行这个服务端目录下的 `ShooterGameServer.exe`。

浏览器、管理后台与主机助手可以在不同电脑。安装、路径检查和磁盘日志均发生在**主机助手所在机器**；聊天或浏览器所在电脑的 Steam 游戏不会自动被另一台机器接管。

## 退出码 7 和 8 的处理

单独的退出码不能确定真实原因。本版在安装/更新服务端前先独立执行 `steamcmd +quit`，让 SteamCMD 完成自身更新，再运行安装命令。安装目录在登录前指定，匿名登录后执行 `app_info_update 1` 刷新应用信息，最后执行 `app_update 376030 validate`。不会更改游戏分支。

SteamCMD 返回 7 时会自动重试一次。返回 8 且实际输出包含 `ERROR! Failed to install app '376030' (Missing configuration)` 这类明确错误时，也会重试一次；每次安装尝试都会重新刷新应用信息。其他退出码 8（例如 `No subscription`）不会按此规则重试。重试后仍失败会如实显示失败，取消任务不会重新启动下载。

`Missing configuration` 出现在 SteamCMD 的应用安装阶段，指向 Steam 应用安装信息，不是要求你补写方舟的 `Game.ini`、`GameUserSettings.ini` 或后台的 `.env`。首次自更新、应用信息缓存或 Steam 连接异常等情况需要结合实际日志区分；这一行本身不能确定是哪一种。不要仅凭此错误删除游戏文件、重装后台或关闭安全软件。

`Failed to load cached hosts file ... using defaults` 表示缺少已缓存的更新节点列表后改用默认列表；它本身不是安装失败的充分证据。`Verifying ... complete` 与 `Clearing cached metrics` 也不能证明服务端下载成功。

仍失败时，以下位置能看到具体原因：

1. 地图详情顶部的错误信息、该地图的「任务」页：显示 SteamCMD 的关键错误和最近输出，保留换行。
2. 「运行日志」中的进程日志：有安装过程输出。
3. 运行 `pnpm agent` 的终端：显示失败的地图、操作与具体输出。运行 `pnpm start` 的 API 终端不负责执行安装。
4. 主机助手工作目录下 `logs/steamcmd/<任务ID>.log`：保存本次结束时的最近输出（尾部最多 65,536 个字符），另附关键错误行和新生成的原生诊断日志。初始化及安装重试的输出会放在同一个文件，以阶段标签区分。

SteamCMD 自己的 `tools/steamcmd/logs/bootstrap_log.txt`、`stderr.txt`、`content_log.txt`、`connection_log.txt` 若在本次运行中更新，也会被读取并加入安装失败详情，每个文件最多读取末尾 8 KiB。`content_log.txt` 更接近应用安装失败原因，`bootstrap_log.txt` 主要记录 SteamCMD 自身更新。未在本次更新或不存在的文件不会作为本次诊断附加。

例如助手根目录为 `D:\ArkHost` 时，原生日志位于 `D:\ArkHost\tools\steamcmd\logs`。如果本版重试后仍然报 `Missing configuration`，请提供该任务的完整安装日志，优先保留 `content_log.txt` 与 `connection_log.txt` 附录；不能只看最后的 `Shutdown`。

也可以在这台实际游戏主机上单独检查应用信息。先等后台的安装任务结束，再打开 PowerShell 执行：

```powershell
Set-Location 'D:\ArkHost\tools\steamcmd'
.\steamcmd.exe +quit
.\steamcmd.exe +login anonymous +app_info_update 1 +app_info_print 376030 +quit
```

这组命令不安装游戏，用于分开检查 SteamCMD 自更新、匿名登录及服务端应用信息。即使能打印应用信息，也仍需回后台完成真正的「安装服务端」，不能把这次检查当作安装完成。

如果仍失败，请复制**新失败任务的完整错误信息**。需要结合 `Disk write failure`、`No subscription`、连接失败等实际内容处理；退出码 7 本身不是磁盘、权限或网络故障的唯一判定。

安装失败且没有运行进程时，可再次点击安装。成功重试后会清除地图的旧错误提示，历史失败任务仍保留。

## 后台会自动检测我的方舟路径吗

当前不会扫描 Steam 游戏库，也没有「导入现有目录」入口。后台只检查每张地图自己的管理目录：

```text
<主机助手工作目录>\instances\<地图ID>\ShooterGame\Binaries\Win64\ShooterGameServer.exe
```

例如主机助手通过 `--root D:\ArkHost` 接入，地图文件就在 `D:\ArkHost\instances\<地图ID>`。根目录实际值保存在该助手使用的配置文件中，默认配置文件是 `.data/agent/config.json` 的 `root` 字段。

Steam 游戏本体（App `346110`）与专用服务端（App `376030`）分开管理。已有外部专用服务端可在「服务端文件 → 导入已有服务端」填写游戏主机上的完整目录，导入到 `maps` 后可供多张地图共用。原目录、存档和配置保留。助手管理目录里的旧服务端在停服后迁移到 `maps`，新地图默认共用同分支文件。详见 [服务端文件管理](SERVER-FILES.md)。

对于新地图，本版使用「安装服务端」下载独立副本。之后在同一地图执行更新会使用同一个管理目录。不要把 Steam 游戏库直接当作助手的 `--root`：助手仍会在其下面创建 `instances/<地图ID>`，并不会因此识别游戏本体。

参考：[ARK 官方社区的服务端安装说明](https://ark.wiki.gg/wiki/Dedicated_server_setup)、[Valve SteamCMD 文档](https://developer.valvesoftware.com/wiki/SteamCMD)。

排错参考：[SteamCMD 命令输出中的 app_info_update 定义](https://github.com/mdeguzis/steamcmd-wrapper/blob/master/steamcmdcommands.txt)、[服务端项目分开执行 SteamCMD 初始化和安装的实际用法](https://github.com/max-pfeiffer/valheim-dedicated-server-docker-helm/blob/main/build/Containerfile)。其他游戏的相同错误仅作为处理流程的参考，不能据此认定这台主机的具体原因。

## 如何部署此次修复

在实际运行管理后台和主机助手的电脑更新项目源码。在项目根目录执行 `pnpm build`，然后重启后台与主机助手，再次安装。保留原有 `.env`、`.data`、助手配置和游戏文件，不需要重新接入主机。

若后台和游戏助手分开部署，两边分别更新对应项目。仅替换当前聊天电脑上的源码，不会自动更新另一台机器正在运行的程序。
