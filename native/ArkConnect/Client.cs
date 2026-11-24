using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace ArkConnect {
    internal sealed class ViewState {
        internal string Status, Detail, Name, Map;
        internal int Revision;
        internal bool Ready;
    }
    internal sealed class Client : IDisposable {
        private const string ArkSteamAppId = "346110";
        private const int QueryResponseTimeoutMs = 2500;
        private readonly Bootstrap bootstrap;
        private readonly Core core;
        private readonly string loopback;
        private int controlPort;
        private readonly Action<ViewState> update;
        private readonly HttpClient http;
        private readonly bool noLaunch;
        private Manifest current;
        private string activeFingerprint;
        private long lastIssued, lastFresh;
        private int revision;
        private bool autoOpened;
        internal bool Ready { get; private set; }
        private void Restart(Manifest target) {
            // Windows may retain TCP sessions on the previous local listener after a restart.
            // Use a fresh control port so address refresh does not wait for TIME_WAIT to expire.
            controlPort = Core.FreeTcpPort(loopback);
            core.Start(bootstrap, target, controlPort, loopback);
        }
        internal Client(Bootstrap bootstrap, string directory, string loopback, bool noLaunch, Action<ViewState> update) {
            this.bootstrap = bootstrap; this.loopback = loopback; this.noLaunch = noLaunch; this.update = update;
            core = new Core(directory); controlPort = Core.FreeTcpPort(loopback);
            http = new HttpClient(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(5), MaxResponseContentBufferSize = 524288 };
            http.DefaultRequestHeaders.Add("X-Connect-Key", bootstrap.Token);
            if (!String.IsNullOrEmpty(bootstrap.DeviceId)) { http.DefaultRequestHeaders.Add("X-Connect-Device",bootstrap.DeviceId); http.DefaultRequestHeaders.Add("X-Connect-Device-Consent","v1"); }
            http.DefaultRequestHeaders.ConnectionClose = true;
        }
        private void Publish(string status, string detail, bool ready) {
            Ready = ready;
            update(new ViewState { Status = status, Detail = detail, Ready = ready,
                Name = current == null ? "好友联机" : current.Name, Map = current == null ? "正在获取地图" : current.Map, Revision = revision });
        }
        // Returns true only when the server has revoked this specific invite. The window can then
        // exit as well, which releases the portable executable for a subsequent local rebuild.
        internal async Task<bool> Run(CancellationToken cancel) {
            Publish("正在连接", "首次启动将展开联机组件，请稍候。", false);
            try { await Task.Run(() => Restart(null)); }
            catch (Exception error) { Publish("无法启动", error.Message, false); return false; }
            while (!cancel.IsCancellationRequested) {
                RouteCheck routes = null;
                try {
                    if (!core.IsAlive) { activeFingerprint = null; await Task.Run(() => Restart(null)); }
                    string origin = bootstrap.ManifestOrigin ?? ("http://" + loopback + ":" + controlPort);
                    string address = origin.TrimEnd('/') + "/api/connect/" + bootstrap.InviteId + "/manifest";
                    using (var response = await http.GetAsync(address, cancel)) {
                        if (response.StatusCode == HttpStatusCode.Unauthorized || response.StatusCode == HttpStatusCode.Forbidden) {
                            core.Stop(); Publish("联机包已停用", "请联系服主重新启用此联机包。", false); return true;
                        }
                        if (!response.IsSuccessStatusCode) throw new IOException("后台暂时不可用，请确认服主的后台和主机助手已开启。");
                        Manifest next = Protocol.Verify(await response.Content.ReadAsStringAsync(), bootstrap, revision, lastIssued);
                        bool changed = current != null && current.Fingerprint != next.Fingerprint;
                        current = next; revision = next.Revision; lastIssued = next.IssuedAt; lastFresh = Protocol.Now;
                        if (activeFingerprint != next.Fingerprint) {
                            Publish(changed ? "目标已更新" : "正在连接游戏", changed ? "正在切换连接，已进入游戏的玩家需要重新进服。" : "正在建立游戏通道。", false);
                            await Task.Run(() => Restart(next));
                            activeFingerprint = next.Fingerprint;
                            Console.WriteLine("TARGET revision=" + revision + " ip=" + next.Ip + " game=" + next.GamePort + " query=" + next.QueryPort);
                            await Task.Delay(800, cancel);
                        }
                        if (!next.Enabled) { Publish(next.DeviceBlocked ? "玩家或设备已被封禁" : "服主已暂停联机", next.DeviceBlocked ? "游戏通道已关闭，请联系服主核实；解封后会自动检查。" : "客户端会继续检查，恢复开放后自动重连。", false); }
                        else {
                            bool reachable = await Task.Run(() => QueryGame(loopback, next.QueryPort));
                            if (reachable) {
                                Publish("可以进入游戏", "Steam 将使用本机转发入口 " + loopback + ":" + next.QueryPort + "。进服时请保持本窗口开启。", true);
                                if (bootstrap.AutoLaunch && !autoOpened && !noLaunch) { autoOpened = true; Join(); }
                                Console.WriteLine("READY revision=" + revision + " query=" + next.QueryPort);
                            } else {
                                routes = await Task.Run(() => core.CheckRoutes(next.Ip));
                                if (routes.HasTarget == false)
                                    Publish("等待游戏主机", "已连接服主后台。目标游戏主机的联机路由尚未建立，正在重试。", false);
                                else if (!next.Running)
                                    Publish("等待地图就绪", "后台显示地图尚未就绪，Steam 查询端口暂未回包。", false);
                                else
                                    Publish("等待 Steam 查询", "地图已运行。暂未通过联机转发收到 UDP " + next.QueryPort + " 的 Steam 查询回包。", false);
                            }
                        }
                    }
                } catch (OperationCanceledException) { if (cancel.IsCancellationRequested) break; Publish("连接重试中", "正在等待后台响应，稍后自动重试。", false); }
                catch (Exception error) { Publish("连接重试中", SafeError(error), false); }
                if (!Ready && core.IsAlive && (routes ?? await Task.Run(() => core.CheckRoutes(null))).AddressConflict) {
                    core.RotateAddress(); activeFingerprint = null;
                    Publish("正在重新分配连接地址", "检测到地址冲突，正在自动恢复连接。", false);
                    await Task.Run(() => Restart(null));
                }
                if (lastFresh > 0 && Protocol.Now - lastFresh > 120000 && activeFingerprint != null) {
                    // Expired permissions may not leave game forwarding open indefinitely.
                    await Task.Run(() => Restart(null)); activeFingerprint = null;
                    Publish("等待服主后台", "地址授权已过期，恢复连接后自动重试。", false);
                }
                try { await Task.Delay(5000, cancel); } catch (OperationCanceledException) { break; }
            }
            return false;
        }
        private static string SafeError(Exception error) {
            if (error is SocketException) return "本机游戏端口被占用。请关闭重复的联机客户端；服主本机可直接进入游戏。";
            if (error is HttpRequestException) return "尚未连通服主后台，正在自动重试。请确认双方允许此程序联网。";
            if (error is InvalidDataException || error is IOException || error is InvalidOperationException) return error.Message;
            return "连接暂时失败，将自动重试。请检查网络或联系服主。";
        }
        internal void Join() {
            if (!Ready || current == null) return;
            // Steam's generic connect URI currently reports an invalid server AppID for ARK.
            // Launch the owned ARK client and pass its local EasyTier query endpoint as +connect instead.
            Process.Start(new ProcessStartInfo("steam://run/" + ArkSteamAppId + "//+connect%20" + loopback + ":" + current.QueryPort + "/") { UseShellExecute = true });
        }
        internal static bool QueryGame(string address, int port) {
            try {
                using (var socket = new UdpClient()) {
                    // A2S_INFO can require a challenge and an info reply over the relay.
                    socket.Client.ReceiveTimeout = QueryResponseTimeoutMs; socket.Connect(address, port);
                    byte[] request = new byte[] {255,255,255,255,0x54};
                    byte[] query = Encoding.ASCII.GetBytes("Source Engine Query\0");
                    var packet = new byte[request.Length + query.Length]; Array.Copy(request, packet, request.Length); Array.Copy(query, 0, packet, request.Length, query.Length);
                    socket.Send(packet, packet.Length); IPEndPoint remote = null;
                    byte[] reply = socket.Receive(ref remote);
                    if (reply.Length == 9 && IsQueryReply(reply, 0x41)) {
                        var challenged = new byte[packet.Length + 4]; Array.Copy(packet, challenged, packet.Length); Array.Copy(reply, 5, challenged, packet.Length, 4);
                        socket.Send(challenged, challenged.Length); reply = socket.Receive(ref remote);
                    }
                    return reply.Length > 6 && IsQueryReply(reply, 0x49);
                }
            } catch (SocketException) { return false; }
        }
        private static bool IsQueryReply(byte[] reply, byte kind) {
            return reply[0] == 255 && reply[1] == 255 && reply[2] == 255 && reply[3] == 255 && reply[4] == kind;
        }
        public void Dispose() { http.Dispose(); core.Dispose(); }
    }
}
