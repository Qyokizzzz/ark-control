#include <API/ARK/Ark.h>
#include <json.hpp>
#include <Windows.h>
#include <objbase.h>

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace {
using json = nlohmann::json;
namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;
constexpr auto lifetime = std::chrono::seconds(60);
constexpr char callback_id[] = "ArkControlShop.Poll";
constexpr char chat_command[] = "/as";

struct Pending {
  uint64 steam;
  bool purchase;
  Clock::time_point deadline;
  std::optional<json> receipt;
  bool attempted = false;
};

fs::path queue_dir;
std::unordered_map<std::string, Pending> pending;

void Whisper(AShooterPlayerController* player, const std::string& text) {
  if (!player) return;
  const auto wide = ArkApi::Tools::Utf8Decode(text);
  ArkApi::GetApiUtils().SendChatMessage(player, "ArkControl", L"{}", wide);
}

fs::path Record(const std::string& id, const char* name) {
  return queue_dir / (id + "." + name + ".json");
}

bool Write(const fs::path& path, const json& value) {
  auto temporary = path;
  temporary += L".tmp";
  std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
  stream << value.dump();
  stream.close();
  return stream.good() && MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
}

std::string RequestId() {
  GUID guid{};
  if (FAILED(CoCreateGuid(&guid))) throw std::runtime_error("cannot generate order ID");
  char value[37]{};
  std::snprintf(value, sizeof(value), "%08lx-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                guid.Data1, guid.Data2, guid.Data3, guid.Data4[0], guid.Data4[1], guid.Data4[2],
                guid.Data4[3], guid.Data4[4], guid.Data4[5], guid.Data4[6], guid.Data4[7]);
  return value;
}

int Positive(const std::string& text, int maximum) {
  int result = 0;
  const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), result);
  return error == std::errc{} && end == text.data() + text.size() && result > 0 && result <= maximum ? result : 0;
}

long long UnixMilliseconds() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void Chat(AShooterPlayerController* player, FString* message, EChatSendMode::Type) {
  if (!player || !message) return;
  try {
    if (ArkApi::Tools::IsPluginLoaded("ArkShop")) {
      Whisper(player, "此地图已加载 ArkShop。请用 /shop 查看商品。");
      return;
    }
    std::istringstream input(message->ToString());
    std::string root, command, first, second, extra;
    input >> root >> command >> first >> second >> extra;
    if (root != chat_command) return;

    const auto steam = ArkApi::IApiUtils::GetSteamIdFromController(player);
    const std::string steam_id = std::to_string(steam);
    if (steam_id.size() != 17 || steam_id.rfind("765", 0) != 0) return;
    json request{{"steamId", steam_id}, {"kind", command}, {"createdAt", UnixMilliseconds()}};
    const bool purchase = command == "buy";
    if (command == "shop" && second.empty() && (first.empty() || Positive(first, 100))) {
      request["page"] = first.empty() ? 1 : Positive(first, 100);
    } else if (command == "points" && first.empty()) {
      // Balance requests have no arguments.
    } else if (purchase && extra.empty() && !first.empty() && first.size() <= 80 &&
               first.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-") == std::string::npos &&
               (second.empty() || Positive(second, 100))) {
      request["productId"] = first;
      request["quantity"] = second.empty() ? 1 : Positive(second, 100);
    } else {
      Whisper(player, "用法 /as shop [页码] | /as points | /as buy 商品编号 [数量]");
      return;
    }
    if (pending.size() >= 300 || std::any_of(pending.begin(), pending.end(), [steam](const auto& item) {
          return item.second.steam == steam && !item.second.receipt;
        })) {
      Whisper(player, "已有商店请求正在处理，请稍后再试。");
      return;
    }
    const auto id = RequestId();
    request["id"] = id;
    pending.emplace(id, Pending{steam, purchase, Clock::now() + lifetime, std::nullopt});
    if (!Write(Record(id, "request"), request)) {
      pending.erase(id);
      Whisper(player, "商店请求未提交，请联系管理员。");
    }
  } catch (const std::exception&) {
    Whisper(player, "商店暂时无法处理该请求。");
  }
}

struct Outcome {
  const char* state;
  const char* reason;
};

struct StatOverride {
  EPrimalItemStat::Type stat;
  int value;
};

std::vector<StatOverride> Stats(UPrimalItem* prototype, const json& line) {
  std::vector<StatOverride> overrides;
  const std::pair<const char*, EPrimalItemStat::Type> stats[] = {
    {"armor", EPrimalItemStat::Armor}, {"durability", EPrimalItemStat::MaxDurability},
    {"damage", EPrimalItemStat::WeaponDamagePercent},
  };
  for (const auto& [field, stat] : stats) {
    if (!line.contains(field)) continue;
    const auto size = GetStructSize<FItemStatInfo>();
    if (size <= 0 || size > 4096) throw std::runtime_error("invalid stat size");
    constexpr auto alignment = sizeof(std::max_align_t);
    std::vector<std::max_align_t> storage((size + alignment - 1) / alignment);
    auto* info = reinterpret_cast<FItemStatInfo*>(storage.data());
    prototype->GetItemStatInfo(info, stat);
    if (!info->bUsed()()) throw std::runtime_error("item does not have this stat");
    const double base = info->InitialValueConstantField() + (info->bDisplayAsPercent()() ? 100.0 : 0.0);
    const double step = base * info->RandomizerRangeMultiplierField() * info->StateModifierScaleField();
    if (step <= 0 || !std::isfinite(step)) throw std::runtime_error("stat cannot be customized");
    const auto raw = std::clamp((line.at(field).get<double>() - base) / step, 0.0, 65535.0);
    overrides.push_back({stat, static_cast<int>(std::lround(raw))});
  }
  return overrides;
}

Outcome Deliver(AShooterPlayerController* player, const json& reply, bool& attempted) {
  if (ArkApi::IApiUtils::IsPlayerDead(player) || !player->PlayerStateField())
    return {"failed", "玩家已离线或角色未就绪。"};
  if (ArkApi::Tools::IsPluginLoaded("ArkShop")) return {"failed", "此地图已启用 ArkShop。"};
  const auto& delivery = reply.at("delivery");
  const int quantity = reply.at("quantity");
  if (!delivery.is_array() || delivery.empty() || delivery.size() > 10 || quantity < 1 || quantity > 100)
    return {"failed", "商品发货配置无效。"};

  if (delivery.size() == 1 && delivery.front().at("kind") == "dino") {
    const auto& line = delivery.front();
    FString blueprint(line.at("blueprint").get<std::string>());
    const int level = line.at("level");
    auto* type = UVictoryCore::BPLoadClass(&blueprint);
    if (quantity != 1 || level < 1 || level > 1000 || !type ||
        !type->IsChildOf(APrimalDinoCharacter::GetPrivateStaticClass()))
      return {"failed", "找不到有效的恐龙蓝图。"};
    attempted = true;
    if (!ArkApi::GetApiUtils().SpawnDino(player, blueprint, nullptr, level, true, false))
      return {"uncertain", "恐龙发货没有返回可确认结果。"};
    return {"delivered", "已发放驯服恐龙。"};
  }

  auto* inventory = player->GetPlayerInventoryComponent();
  if (!inventory) return {"failed", "玩家背包尚未就绪。"};
  struct ItemGrant {
    UClass* type;
    int amount;
    int stack;
    float quality;
    bool blueprint_only;
    std::vector<StatOverride> stats;
  };
  std::vector<ItemGrant> grants;
  int slots = 0;
  for (const auto& line : delivery) {
    if (line.at("kind") != "item") return {"failed", "商品类型无效。"};
    FString blueprint(line.at("blueprint").get<std::string>());
    auto* type = UVictoryCore::BPLoadClass(&blueprint);
    const int amount = line.at("amount");
    if (!type || !type->IsChildOf(UPrimalItem::GetPrivateStaticClass()) || amount < 1 || amount > 10000 / quantity)
      return {"failed", "物品蓝图或数量无效。"};
    auto* prototype = static_cast<UPrimalItem*>(type->GetDefaultObject(true));
    if (!prototype) return {"failed", "无法加载物品蓝图。"};
    auto stats = Stats(prototype, line);
    const bool blueprint_only = line.at("blueprintOnly");
    const int stack = blueprint_only || !stats.empty() ? 1 : std::max(1, prototype->GetMaxItemQuantity(ArkApi::GetApiUtils().GetWorld()));
    const int total = quantity * amount;
    slots += (total - 1) / stack + 1;
    grants.push_back({type, total, stack, line.at("quality"), blueprint_only, std::move(stats)});
  }
  if (slots > 100) return {"failed", "本次物品需要太多背包格，请减少数量。"};
  const int limit = inventory->AbsoluteMaxInventoryItemsField();
  if (limit > 0 && inventory->InventoryItemsField().Num() + slots > limit)
    return {"failed", "背包格不足，清理后再购买。"};
  for (const auto& grant : grants) {
    for (int left = grant.amount; left > 0;) {
      const int amount = std::min(left, grant.stack);
      attempted = true;
      auto* item = UPrimalItem::AddNewItem(grant.type, inventory, false, true, grant.quality,
          !grant.blueprint_only, amount, grant.blueprint_only, 0, false, nullptr, 0, false, false);
      if (!item || item->GetItemQuantity() != amount)
        return {"uncertain", "物品未返回完整发货结果，请核对背包。"};
      for (const auto& [stat, value] : grant.stats) {
        item->SetItemStatValues(stat, value);
        if (stat == EPrimalItemStat::MaxDurability) item->ItemDurabilityField() = item->GetItemStatModifier(stat);
      }
      if (!grant.stats.empty()) item->UpdatedItem(false);
      left -= amount;
    }
  }
  return {"delivered", "物品已发放到背包。"};
}

void SetReceipt(Pending& request, const std::string& id, const Outcome& outcome) {
  request.receipt = json{{"id", id}, {"steamId", std::to_string(request.steam)},
                        {"outcome", outcome.state}, {"reason", outcome.reason}};
}

bool Complete(const std::string& id, Pending& request) {
  if (!Write(Record(id, "receipt"), *request.receipt)) return false;
  std::error_code ignored;
  fs::remove(Record(id, "reply"), ignored);
  return true;
}

bool Respond(const std::string& id, Pending& request) {
  if (request.receipt) return Complete(id, request);
  if (request.attempted) {
    SetReceipt(request, id, {"uncertain", "发货已尝试，回执中断。"});
    return Complete(id, request);
  }
  const bool expired = Clock::now() >= request.deadline;
  std::ifstream stream(Record(id, "reply"), std::ios::binary);
  if (!stream && !expired) return false;
  auto* player = ArkApi::GetApiUtils().FindPlayerFromSteamId(request.steam);
  Outcome outcome{"failed", "订单已过期，未发货。"};
  try {
    if (!expired) {
      const auto reply = json::parse(stream);
      stream.close();
      if (reply.contains("lines")) {
        for (const auto& line : reply.at("lines")) Whisper(player, line.get<std::string>());
        std::error_code ignored;
        fs::remove(Record(id, "reply"), ignored);
        return true;
      }
      if (request.purchase && UnixMilliseconds() < reply.at("expiresAt").get<long long>())
        outcome = Deliver(player, reply, request.attempted);
    }
  } catch (const std::exception&) {
    outcome = request.attempted ? Outcome{"uncertain", "发货中断，请联系管理员核对订单。"}
                        : Outcome{"failed", "商品无法发放，请联系管理员。"};
  }
  if (request.purchase) SetReceipt(request, id, outcome);
  Whisper(player, outcome.reason);
  return request.purchase ? Complete(id, request) : true;
}

void Tick() {
  unsigned int completed = 0;
  for (auto it = pending.begin(); it != pending.end() && completed < 12;) {
    try {
      if (Respond(it->first, it->second)) {
        it = pending.erase(it);
        ++completed;
        continue;
      }
    } catch (const std::exception&) {
      // A failed local write can be retried on a later tick, using the same receipt.
    }
    ++it;
  }
}
} // namespace

extern "C" __declspec(dllexport) void Plugin_Init() {
  try {
    std::wstring executable(32768, L'\0');
    const auto size = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
    if (size == 0 || size >= executable.size()) throw std::runtime_error("cannot locate game directory");
    executable.resize(size);
    queue_dir = fs::path(executable).parent_path().parent_path().parent_path() / "Saved" / "ArkControlShop";
    fs::create_directories(queue_dir);
    ArkApi::GetCommands().AddOnTimerCallback(callback_id, &Tick);
    ArkApi::GetCommands().AddChatCommand(chat_command, &Chat);
  } catch (const std::exception& error) {
    std::fprintf(stderr, "ArkControlShop initialization failed: %s\n", error.what());
    ArkApi::GetCommands().RemoveOnTimerCallback(callback_id);
  }
}

extern "C" __declspec(dllexport) void Plugin_Unload() {
  ArkApi::GetCommands().RemoveChatCommand(chat_command);
  ArkApi::GetCommands().RemoveOnTimerCallback(callback_id);
  for (auto& [id, request] : pending) {
    if (!request.purchase) continue;
    try {
      if (!request.receipt)
        SetReceipt(request, id, request.attempted ? Outcome{"uncertain", "商店卸载前已尝试发货。"}
                                                 : Outcome{"failed", "商店已卸载，未发货。"});
      Complete(id, request);
    } catch (const std::exception&) { }
  }
  pending.clear();
}
