# 可选 ArkShop 金币审计接入

普通商店日志不能保证覆盖所有在线奖励、扣币及外部修改。本目录提供本项目编写的结构化日志头文件，以及对已知 ArkShop Points.cpp 结构的补丁生成器，不包含第三方 ArkShop 二进制或完整源码。

在持有相应 ArkShop 源码、遵守其许可证的开发环境中：

```powershell
node native/ArkShopAudit/instrument.mjs 'D:\ArkShopSource\ArkShop\Private\Points.cpp' 'D:\ArkShopAuditReview'
```

输出文件夹必须尚不存在。生成器不修改输入文件；生成 `Points.cpp` 和 `ArkControlCommerce.h` 供审阅。它只接受已知的三个公共函数和成功路径，遇到其他版本会报错，不猜测挂钩。将审核后的文件合入自己的 ArkShop 工程，使用对应 **ASE** SDK 和 Windows x64 C++17 编译，先在测试服核对正常购买、奖励、转账、管理员增减以及插件加载/卸载。

成功的 AddPoints、SpendPoints、SetPoints 输出独立的 `points-credit`、`points-debit`、`points-set` 事件，包含请求变化量及操作前后采样余额。输出到该地图的 `ShooterGame/Saved/Logs/ArkControlCommerce.jsonl`，主机助手自动采集。每笔写入使用文件追加并请求写透，失败输出调试信息；不会将审计异常抛入游戏循环。

这份源码接入没有在本环境编译成真实游戏 DLL，也没有针对实际 358 / 361 SDK 验证。补丁转换器已做合成源码结构测试。游戏数据库提交和文件追加不是同一事务，其他插件绕过 Points API 直接写库仍不会被此头文件观察。前后余额受并发地图交易影响，不能将余额差强行当作单笔金额；商品/发货上下文由 ArkShop 商店日志或其他事件适配器补充。

后台管理员操作的审计和游戏 Points API 审计是不同来源，可能对应同一业务，应关联核对而不是将两条相加视为两次金币变化。协议、原始日志和部署说明见 [用户与商店说明](../../docs/PLAYER-SHOP.md)。
