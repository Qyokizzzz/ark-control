# ArkTribeBridge（Windows ASE 可选插件源码）

使用与你的 ASE 服务端匹配的社区 ArkApi SDK 和 Visual Studio C++ x64 工具链编译：

```sh
cmake -S . -B build -A x64 -DARKAPI_SDK=D:/ArkApiSDK
cmake --build build --config Release
```

停止地图后安装 ArkApi，再将 DLL 放到实例的：

```text
ShooterGame/Binaries/Win64/ArkApi/Plugins/ArkTribeBridge/ArkTribeBridge.dll
```

目录名与 DLL 名保持一致。启动后输出同目录 `events.jsonl`，助手优先采集。每条记录包含进程启动标识和序号，重传不会重复计数。游戏中已经实际生成的原生部落日志才会进入此钩子，不新增未被游戏记录的事件。

插件只在本机写 JSONL，不包含 QQ 凭据，不直接访问 QQ 网络。每秒刷新一次队列；进程突然崩溃前未刷新的少量事件可能无法保留。磁盘失败时队列保留于内存，需关注文件增长及空间。

**此仓库提供源码，未附预编译 DLL。**需要在实际 SDK 和游戏版本中完成编译、钩子兼容及部落归属验收。社区 ArkApi 的接口可能随版本变化；本地 Web / MySQL 自动测试不能代替游戏内验收。

# 新增玩家快照

本版源码除部落日志外，每约 10 秒将玩家 SteamID、名称和游戏观察 IP 写到 `ShooterGame/Saved/Logs/ArkControlPlayers.json`，供用户档案采集。代理转发可能使游戏观察到网关地址，后台不会据此推断玩家公网 IP，也拒绝封禁已知网关。设备标识由另行授权的联机客户端提供，游戏 DLL 不获取玩家机器码。

新增 C++ 源码尚未在本环境编译或进行真实 358 / 361 游戏兼容验证。请使用对应 ASE SDK 构建，不能将 ASA SDK 替代。可选金币审计见 [ArkShopAudit](../ArkShopAudit/README.md)。
