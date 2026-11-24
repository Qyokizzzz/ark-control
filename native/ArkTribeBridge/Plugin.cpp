#include <API/ARK/Ark.h>
#include <Windows.h>
#include <chrono>
#include <ctime>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <mutex>
#include <sstream>
#include <string>

namespace {
std::mutex pending_mutex;
std::deque<std::string> pending;
std::string boot_id;
unsigned long long sequence = 0;
std::filesystem::path output_path;
std::filesystem::path players_path;
unsigned int player_ticks = 0;
DECLARE_HOOK(AShooterGameMode_AddToTribeLog, void, AShooterGameMode*, int, FString*);

std::string Escape(const std::string& value) {
  std::ostringstream result;
  for (unsigned char c : value) {
    switch(c) { case '"': result << "\\\""; break; case '\\': result << "\\\\"; break;
      case '\n': result << "\\n"; break; case '\r': result << "\\r"; break; case '\t': result << "\\t"; break;
      default: if(c < 0x20) result << "\\u" << std::hex << std::setw(4) << std::setfill('0') << int(c) << std::dec; else result << c; }
  }
  return result.str();
}
std::string Timestamp() {
  const auto now = std::chrono::system_clock::now(); const auto time = std::chrono::system_clock::to_time_t(now);
  std::tm utc{}; gmtime_s(&utc, &time); std::ostringstream value; value << std::put_time(&utc, "%Y-%m-%dT%H:%M:%SZ"); return value.str();
}
void SnapshotPlayers() {
  if (++player_ticks % 10 != 0) return;
  try {
    auto* world = ArkApi::GetApiUtils().GetWorld(); if (!world) return;
    std::ostringstream json; json << "{\"sampledAt\":\"" << Timestamp() << "\",\"players\":[";
    bool first = true;
    for (const auto& weak : world->PlayerControllerListField()) {
      auto* player = static_cast<AShooterPlayerController*>(weak.Get()); if (!player) continue;
      const auto steam = ArkApi::IApiUtils::GetSteamIdFromController(player); if (!steam) continue;
      FString remote; player->GetPlayerNetworkAddress(&remote);
      std::string address = remote.ToString();
      const auto colon = address.find(':'); if (colon != std::string::npos) address.resize(colon);
      if (!first) json << ','; first = false;
      json << "{\"steamId\":\"" << steam << "\",\"name\":\"" << Escape(ArkApi::IApiUtils::GetSteamName(player).ToString()) << "\"";
      if (!address.empty()) json << ",\"ip\":\"" << Escape(address) << "\"";
      json << '}';
    }
    json << "]}";
    const auto temporary = players_path.wstring() + L".tmp";
    { std::ofstream stream(temporary, std::ios::binary | std::ios::trunc); stream << json.str(); if (!stream.good()) return; }
    MoveFileExW(temporary.c_str(), players_path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
  } catch (...) { /* Optional observation must never interrupt the game. */ }
}
void Flush() {
  SnapshotPlayers();
  std::lock_guard<std::mutex> lock(pending_mutex);
  if(pending.empty()) return;
  std::ofstream stream(output_path, std::ios::binary | std::ios::app);
  if(!stream.is_open()) return;
  while(!pending.empty()) { stream << pending.front() << '\n'; stream.flush(); if(!stream.good()) return; pending.pop_front(); }
}
void Hook_AShooterGameMode_AddToTribeLog(AShooterGameMode* mode, int tribe_id, FString* text) {
  AShooterGameMode_AddToTribeLog_original(mode, tribe_id, text);
  if(!text) return;
  try {
    std::string name = std::to_string(tribe_id);
    if(auto* tribe = mode->TribesDataField().Find(tribe_id)) name = tribe->TribeNameField().ToString();
    std::lock_guard<std::mutex> lock(pending_mutex);
    const auto source_id = boot_id + ":" + std::to_string(++sequence);
    pending.emplace_back("{\"sourceId\":\"" + Escape(source_id) + "\",\"tribeId\":\"" + std::to_string(tribe_id) + "\",\"tribeName\":\"" + Escape(name) + "\",\"text\":\"" + Escape(text->ToString()) + "\",\"occurredAt\":\"" + Timestamp() + "\"}");
  } catch(...) { /* Never propagate a logging error into the game loop. */ }
}
void Load() {
  wchar_t executable[MAX_PATH]{}; GetModuleFileNameW(nullptr, executable, MAX_PATH);
  const auto directory = std::filesystem::path(executable).parent_path() / "ArkApi" / "Plugins" / "ArkTribeBridge";
  std::filesystem::create_directories(directory); output_path = directory / "events.jsonl";
  players_path = std::filesystem::path(executable).parent_path().parent_path().parent_path() / "Saved" / "Logs" / "ArkControlPlayers.json";
  std::filesystem::create_directories(players_path.parent_path());
  boot_id = Timestamp() + ":" + std::to_string(GetCurrentProcessId()) + ":" + std::to_string(GetTickCount64());
  ArkApi::GetHooks().SetHook("AShooterGameMode.AddToTribeLog", &Hook_AShooterGameMode_AddToTribeLog, &AShooterGameMode_AddToTribeLog_original);
  ArkApi::GetCommands().AddOnTimerCallback("ArkTribeBridge.Flush", &Flush);
}
void Unload() {
  ArkApi::GetCommands().RemoveOnTimerCallback("ArkTribeBridge.Flush");
  ArkApi::GetHooks().DisableHook("AShooterGameMode.AddToTribeLog", &Hook_AShooterGameMode_AddToTribeLog);
  Flush();
}
}
BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
  if(reason == DLL_PROCESS_ATTACH) { DisableThreadLibraryCalls(module); try { Load(); } catch(...) { return FALSE; } }
  else if(reason == DLL_PROCESS_DETACH) { try { Unload(); } catch(...) {} }
  return TRUE;
}
