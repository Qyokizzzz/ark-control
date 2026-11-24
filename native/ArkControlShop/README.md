# ArkControlShop 独立聊天商店

运行环境为 Windows x64 的《方舟：生存进化》专用服务端和 ASE ArkApi 3.55 或以上。预编译 DLL 使用 [ASE ArkApi SDK](https://github.com/ServersHub/Framework-ArkServerApi/tree/d9d1497a540d7edf33d573edffe7656404a09682) 及 MSVC v143 构建。游戏主机需安装 x64 Microsoft Visual C++ 2015–2022 运行库。

在地图停止时，将插件包中的 `ArkControlShop` 文件夹放入这张地图的 `ShooterGame\Binaries\Win64\ArkApi\Plugins`。同级 `Win64` 应有 ASE ArkApi 的 `version.dll`。共享服务端文件的地图也各自有 `instances\<地图ID>\ShooterGame\Binaries\Win64`，需要在各自的平台目录安装插件。独立模式启用前，将 ArkShop 文件夹移出这个 `Plugins` 目录。

后台选择「独立商店」后启动地图，检查 ArkApi 日志是否加载 `ArkControlShop`。先给测试玩家发少量金币，再在游戏里执行 `/as points`、`/as shop` 和 `/as buy 商品编号`。预编译 DLL 已链接 SDK。实际 `preaquatica` 358 与公开 361 服务端的 ArkApi 加载、商品品质和发货需要按分支实测。

## 从源码编译

在 Windows 安装 CMake 和 Visual Studio C++ x64 工具。`ARKAPI_SDK` 指向相应 ASE SDK 或仓库 checkout。根目录须能找到 SDK 的 `version/Core/Public` 和 `out_lib/ArkApi.lib`，或等效的 `include` 与 `lib`。

```powershell
cmake -S native/ArkControlShop -B native/ArkControlShop/dist -A x64 -T v143 -DARKAPI_SDK="C:/path/to/Framework-ArkServerApi"
cmake --build native/ArkControlShop/dist --config Release
cmake --install native/ArkControlShop/dist --config Release --prefix native/ArkControlShop/dist/package
```

## 商品发放定义

物品字段包括 `kind: "item"`、`blueprint`、`amount`、`quality`、`blueprintOnly`，可选 `armor`、`durability`、`damage`。武器伤害字段使用显示百分数，例如 `755`。图纸只在 `blueprintOnly` 为 `true` 时发放。商品可由多种物品组成。

恐龙字段为 `kind: "dino"`、`blueprint` 和 `level`。恐龙在玩家附近以驯服状态发放。

插件从服务器玩家控制器取得 SteamID64。由地图 `ShooterGame\Saved\ArkControlShop` 下的队列与主机助手交换请求、响应和回执。助手使用已有主机凭据访问管理端。每次购买使用唯一订单号，重复转交仍使用原来的扣款记录。游戏进程中断会留下需要核实的订单。
