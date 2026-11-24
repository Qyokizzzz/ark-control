# EasyTier

本程序通过独立进程调用未经修改的 EasyTier 2.6.4 官方 Windows x86_64 发行文件。
EasyTier 由其原作者及贡献者版权所有，依据 GNU LGPL v3 许可分发。

- 项目及完整源代码：<https://github.com/EasyTier/EasyTier/tree/v2.6.4>
- 官方发行文件：<https://github.com/EasyTier/EasyTier/releases/tag/v2.6.4>
- 许可证：`vendor/EasyTier-LICENSE.txt`（LGPL v3），`vendor/GPL-3.0.txt`。
- ZIP SHA-256：`27af91e270e554709b048bd32327fefd2dfce5062ae1e8701af7550c6f525f84`

ArkConnect 的启动器源码位于本目录。可以修改源码、替换运行时并重新构建；若使用不同的上游构建，请同步修改校验值和版本，保留相应源代码及许可证。
运行时没有静态链接进 ArkConnect：官方 ZIP 仅作为资源携带，展开后作为单独的进程运行。
客户端解压缓存位于 `%LOCALAPPDATA%/ArkConnect`，不安装系统服务或虚拟网卡。

EasyTier 社区共享节点由第三方运营，节点地址可由服主配置。本项目不运营公共中继，也不承诺第三方节点的带宽、延迟或可用性。
