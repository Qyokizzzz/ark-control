using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace ArkConnect {
    internal sealed class Job : IDisposable {
        private IntPtr handle;
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint size);
        [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr value);
        [StructLayout(LayoutKind.Sequential)] private struct BasicLimits {
            internal long PerProcessTime, PerJobTime;
            internal uint LimitFlags;
            internal UIntPtr MinWorkingSet, MaxWorkingSet;
            internal uint ActiveProcessLimit;
            internal UIntPtr Affinity;
            internal uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)] private struct IoCounters { internal ulong A, B, C, D, E, F; }
        [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits {
            internal BasicLimits Basic;
            internal IoCounters Io;
            internal UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }
        internal Job() {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new InvalidOperationException("无法创建联机进程容器。");
            var value = new ExtendedLimits(); value.Basic.LimitFlags = 0x2000;
            int size = Marshal.SizeOf(value); IntPtr pointer = Marshal.AllocHGlobal(size);
            try { Marshal.StructureToPtr(value, pointer, false); if (!SetInformationJobObject(handle, 9, pointer, (uint)size)) throw new InvalidOperationException("无法设置联机进程退出清理。"); }
            finally { Marshal.FreeHGlobal(pointer); }
        }
        internal void Add(Process process) {
            if (!AssignProcessToJobObject(handle, process.Handle)) {
                try { process.Kill(); } catch (InvalidOperationException) { }
                throw new InvalidOperationException("无法管理联机进程，请关闭后重试。");
            }
        }
        public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    }
    internal sealed class RouteCheck {
        internal bool AddressConflict;
        internal bool? HasTarget;
    }
    internal sealed class Core : IDisposable {
        private const string ArchiveHash = "27af91e270e554709b048bd32327fefd2dfce5062ae1e8701af7550c6f525f84";
        private readonly string directory, configPath, runtimeDirectory;
        private readonly string instanceId = Guid.NewGuid().ToString();
        private readonly Job job = new Job();
        private Process process;
        private string cliPath;
        private int rpcPort;
        private string deviceIp;
        internal Core(string directory) {
            this.directory = directory;
            Directory.CreateDirectory(directory);
            configPath = Path.Combine(directory, "core.toml");
            runtimeDirectory = Path.Combine(directory, "easytier-2.6.4");
            string addressFile = Path.Combine(directory, "device-ip.txt");
            if (File.Exists(addressFile)) deviceIp = File.ReadAllText(addressFile).Trim();
            IPAddress parsed;
            if (!IPAddress.TryParse(deviceIp, out parsed) || parsed.AddressFamily != AddressFamily.InterNetwork || parsed.GetAddressBytes()[0] != 10 || parsed.GetAddressBytes()[1] == 126) RotateAddress();
        }
        internal void RotateAddress() {
            byte[] bytes = new byte[3];
            using (var random = RandomNumberGenerator.Create()) do { random.GetBytes(bytes); } while (bytes[0] == 126);
            deviceIp = "10." + bytes[0] + "." + bytes[1] + "." + (1 + bytes[2] % 254);
            File.WriteAllText(Path.Combine(directory, "device-ip.txt"), deviceIp);
        }
        internal static int FreeTcpPort(string address) {
            var listener = new TcpListener(IPAddress.Parse(address), 0);
            listener.ExclusiveAddressUse = true;
            listener.Start(); int value = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); return value;
        }
        private string Runtime() {
            string archive = Path.Combine(directory, "easytier-2.6.4.zip");
            foreach (string name in new[] { "EasyTier-LICENSE.txt", "GPL-3.0.txt", "THIRD-PARTY-NOTICES.md" }) {
                using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
                using (var target = File.Create(Path.Combine(directory, name))) source.CopyTo(target);
            }
            using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("EasyTier.zip"))
            using (var sha = SHA256.Create()) {
                string hash = BitConverter.ToString(sha.ComputeHash(source)).Replace("-", "").ToLowerInvariant();
                if (hash != ArchiveHash) throw new InvalidDataException("联机核心完整性校验失败，请重新下载。");
            }
            if (!Directory.Exists(runtimeDirectory)) {
                using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("EasyTier.zip"))
                using (var target = File.Create(archive)) source.CopyTo(target);
                string temporary = runtimeDirectory + "-" + Guid.NewGuid().ToString("N");
                Directory.CreateDirectory(temporary);
                using (var zip = ZipFile.OpenRead(archive)) {
                    foreach (ZipArchiveEntry entry in zip.Entries) {
                        string target = Path.GetFullPath(Path.Combine(temporary, entry.FullName));
                        if (!target.StartsWith(temporary + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("联机核心路径无效。");
                        if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(target); continue; }
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        entry.ExtractToFile(target);
                    }
                }
                Directory.Move(temporary, runtimeDirectory);
            }
            string[] files = Directory.GetFiles(runtimeDirectory, "easytier-core.exe", SearchOption.AllDirectories);
            if (files.Length != 1) throw new InvalidDataException("缺少联机核心文件。");
            cliPath = Path.Combine(Path.GetDirectoryName(files[0]), "easytier-cli.exe");
            if (!File.Exists(cliPath)) throw new InvalidDataException("缺少联机控制组件。");
            // Compare the executable to the embedded, pinned archive on every launch.
            using (var source = Assembly.GetExecutingAssembly().GetManifestResourceStream("EasyTier.zip"))
            using (var zip = new ZipArchive(source, ZipArchiveMode.Read)) {
                foreach (var entry in zip.Entries) if (entry.Name == "easytier-core.exe" || entry.Name == "easytier-cli.exe") {
                    byte[] expected, actual;
                    using (var sha = SHA256.Create()) using (var item = entry.Open()) expected = sha.ComputeHash(item);
                    using (var sha = SHA256.Create()) using (var item = File.OpenRead(entry.Name == "easytier-core.exe" ? files[0] : cliPath)) actual = sha.ComputeHash(item);
                    if (BitConverter.ToString(expected) != BitConverter.ToString(actual)) throw new InvalidDataException("联机核心被修改，请重新下载联机包并清理其缓存。");
                }
            }
            return files[0];
        }
        internal bool IsAlive { get { return process != null && !process.HasExited; } }
        internal void Start(Bootstrap bootstrap, Manifest manifest, int controlPort, string loopback) {
            Stop();
            string executable = Runtime();
            do { rpcPort = FreeTcpPort("127.0.0.1"); } while (rpcPort == controlPort);
            var lines = new List<string> { "instance_id = " + Json.Quote(instanceId), "instance_name = \"ArkFriend\"", "dhcp = false", "ipv4 = " + Json.Quote(deviceIp),
                "listeners = [\"udp://0.0.0.0:0\", \"tcp://0.0.0.0:0\"]", "rpc_portal = \"127.0.0.1:" + rpcPort + "\"", "tcp_whitelist = [\"0\"]", "udp_whitelist = [\"0\"]" };
            lines.Add("[network_identity]"); lines.Add("network_name = " + Json.Quote(bootstrap.NetworkName)); lines.Add("network_secret = " + Json.Quote(bootstrap.NetworkSecret));
            foreach (string peer in manifest == null ? bootstrap.Peers : manifest.Peers) { lines.Add("[[peer]]"); lines.Add("uri = " + Json.Quote(peer)); }
            if (bootstrap.ManifestOrigin == null) {
                lines.Add("[[port_forward]]"); lines.Add("bind_addr = " + Json.Quote(loopback + ":" + controlPort));
                lines.Add("dst_addr = " + Json.Quote(bootstrap.ControllerIp + ":" + bootstrap.ControllerPort)); lines.Add("proto = \"tcp\"");
            }
            if (manifest != null && manifest.Enabled) {
                foreach (int port in new[] { manifest.GamePort, manifest.GamePort + 1, manifest.QueryPort }) {
                    // Fail visibly if a game or a second launcher already owns the local UDP port.
                    using (var check = new UdpClient()) { check.ExclusiveAddressUse = true; check.Client.Bind(new IPEndPoint(IPAddress.Parse(loopback), port)); }
                    lines.Add("[[port_forward]]"); lines.Add("bind_addr = " + Json.Quote(loopback + ":" + port));
                    lines.Add("dst_addr = " + Json.Quote(manifest.Ip + ":" + port)); lines.Add("proto = \"udp\"");
                }
            }
            lines.Add("[flags]"); lines.Add("no_tun = true"); lines.Add("enable_encryption = true"); lines.Add("enable_ipv6 = true"); lines.Add("disable_upnp = true"); lines.Add("bind_device = false"); lines.Add("relay_network_whitelist = \"\"");
            File.WriteAllText(configPath, String.Join("\n", lines) + "\n", new UTF8Encoding(false));
            process = new Process { StartInfo = new ProcessStartInfo(executable, "-c \"" + configPath + "\" --rpc-portal 127.0.0.1:" + rpcPort + " --no-tun true --disable-upnp true") {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = directory,
                RedirectStandardError = true, RedirectStandardOutput = true } };
            // Do not copy upstream configuration dumps containing network keys into launcher logs.
            process.OutputDataReceived += delegate { }; process.ErrorDataReceived += delegate { };
            process.Start(); job.Add(process); process.BeginOutputReadLine(); process.BeginErrorReadLine();
        }
        private string RunCommand(string arguments) {
            arguments = "-p 127.0.0.1:" + rpcPort + " " + arguments;
            using (var command = new Process { StartInfo = new ProcessStartInfo(cliPath, arguments) {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = directory,
                RedirectStandardOutput = true, RedirectStandardError = true } }) {
                command.Start(); job.Add(command);
                var output = command.StandardOutput.ReadToEndAsync(); var error = command.StandardError.ReadToEndAsync();
                if (!command.WaitForExit(10000)) { command.Kill(); throw new IOException("游戏通道更新超时，正在自动重试。"); }
                System.Threading.Tasks.Task.WaitAll(output, error);
                if (command.ExitCode != 0) throw new IOException("游戏通道更新失败，正在自动重试。");
                return output.Result;
            }
        }
        internal RouteCheck CheckRoutes(string targetIp) {
            var result = new RouteCheck();
            try {
                var routes = Json.Serializer.Deserialize<object[]>(RunCommand("-o json route"));
                if (targetIp != null) result.HasTarget = false;
                foreach (var value in routes) {
                    var route = (Dictionary<string, object>)value;
                    if (Json.Number(route, "path_len") <= 0) continue;
                    string ip = Json.Text(route, "ipv4").Split('/')[0];
                    if (ip == deviceIp) result.AddressConflict = true;
                    if (ip == targetIp) result.HasTarget = true;
                }
            } catch { result.HasTarget = null; }
            return result;
        }
        internal void Stop() {
            if (process == null) return;
            try { if (!process.HasExited) { process.Kill(); process.WaitForExit(3000); } } catch (InvalidOperationException) { }
            process.Dispose(); process = null;
        }
        public void Dispose() {
            Stop(); job.Dispose();
            try { if (File.Exists(configPath)) File.Delete(configPath); } catch (IOException) { }
        }
    }
}
