#pragma once
#include <Windows.h>
#include <atomic>
#include <chrono>
#include <ctime>
#include <filesystem>
#include <iomanip>
#include <mutex>
#include <sstream>
#include <string>

// Optional source integration for ASE ArkShop. No ArkShop implementation is redistributed here.
// A game mutation and a file append are separate commits; audit I/O failure must be monitored.
namespace ArkControlCommerce {
inline std::mutex gate;
inline std::atomic<unsigned long long> sequence{0};
inline const unsigned long long boot = GetTickCount64();
inline std::string Timestamp() {
  const auto now = std::chrono::system_clock::now();
  const auto value = std::chrono::system_clock::to_time_t(now);
  std::tm utc{}; gmtime_s(&utc, &value);
  const auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count() % 1000;
  std::ostringstream text; text << std::put_time(&utc, "%Y-%m-%dT%H:%M:%S") << '.' << std::setw(3) << std::setfill('0') << milliseconds << 'Z'; return text.str();
}
inline void Record(const char* kind, unsigned long long steam, long long delta, long long before, long long after) noexcept {
  try {
    wchar_t executable[32768]{}; const auto size = GetModuleFileNameW(nullptr, executable, 32768); if (!size || size >= 32768) return;
    const auto path = std::filesystem::path(executable).parent_path().parent_path().parent_path() / "Saved" / "Logs" / "ArkControlCommerce.jsonl";
    std::filesystem::create_directories(path.parent_path());
    std::ostringstream line; const auto time = Timestamp();
    line << "{\"eventId\":\"arkshop:" << GetCurrentProcessId() << ':' << boot << ':' << ++sequence << ":" << time << "\",\"steamId\":\"" << steam << "\",\"kind\":\"" << kind << "\",\"occurredAt\":\"" << time << "\",\"detail\":{\"delta\":" << delta << ",\"before\":" << before << ",\"after\":" << after << ",\"source\":\"ArkShop Points API\",\"balanceSemantics\":\"observed snapshots; concurrent maps may change balances\"}}\n";
    const std::string bytes = line.str(); std::lock_guard<std::mutex> lock(gate);
    const HANDLE file = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr);
    if (file == INVALID_HANDLE_VALUE) { OutputDebugStringA("ArkControlCommerce: cannot open audit file\n"); return; }
    DWORD written = 0; const bool ok = WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) && written == bytes.size();
    CloseHandle(file); if (!ok) OutputDebugStringA("ArkControlCommerce: incomplete audit write\n");
  } catch (...) { OutputDebugStringA("ArkControlCommerce: audit failed\n"); }
}
}
