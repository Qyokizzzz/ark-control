using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ArkConnect {
    internal sealed class Window : Form {
        private readonly Label status = new Label(), detail = new Label(), name = new Label(), map = new Label();
        private readonly Button join = new Button();
        private readonly CancellationTokenSource cancel = new CancellationTokenSource();
        private readonly Client client;
        private readonly string snapshot;
        private bool disposed;
        internal Window(Bootstrap bootstrap, string directory, string loopback, bool noLaunch, int duration, string snapshot) {
            this.snapshot = snapshot;
            Text = "方舟 · 好友联机"; ClientSize = new Size(540, 430); MinimumSize = new Size(500, 430);
            BackColor = Color.FromArgb(17, 21, 21); ForeColor = Color.FromArgb(236, 241, 235);
            Font = new Font("Microsoft YaHei UI", 10); StartPosition = FormStartPosition.CenterScreen;
            var logo = new Label { Text = "ARK / CONNECT", Font = new Font(Font.FontFamily, 13, FontStyle.Bold), ForeColor = Color.FromArgb(200, 239, 139), Bounds = new Rectangle(32, 26, 460, 30) };
            name.Bounds = new Rectangle(32, 83, 470, 40); name.Font = new Font(Font.FontFamily, 21, FontStyle.Bold); name.Text = "好友联机";
            map.Bounds = new Rectangle(34, 132, 460, 26); map.ForeColor = Color.FromArgb(158, 171, 162); map.Text = "自动连接服主服务器";
            status.Bounds = new Rectangle(34, 194, 460, 32); status.Font = new Font(Font.FontFamily, 14, FontStyle.Bold); status.Text = "正在准备";
            detail.Bounds = new Rectangle(34, 233, 460, 58); detail.ForeColor = Color.FromArgb(158, 171, 162);
            join.Text = "进入游戏"; join.Bounds = new Rectangle(32, 312, 470, 48); join.Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            join.FlatStyle = FlatStyle.Flat; join.FlatAppearance.BorderSize = 0; join.BackColor = Color.FromArgb(200, 239, 139); join.ForeColor = Color.FromArgb(20, 32, 19); join.Enabled = false;
            var footer = new Label { Text = "地址自动更新  ·  免虚拟网卡  ·  Steam 版方舟", ForeColor = Color.FromArgb(120, 139, 126), Bounds = new Rectangle(32, 385, 470, 24), Anchor = AnchorStyles.Left | AnchorStyles.Bottom };
            Controls.AddRange(new Control[] { logo, name, map, status, detail, join, footer });
            client = new Client(bootstrap, directory, loopback, noLaunch, OnUpdate);
            join.Click += delegate { try { client.Join(); } catch { MessageBox.Show(this, "无法打开 Steam，请确认已安装并登录 Steam。", Text); } };
            Shown += async delegate {
                if (duration > 0) cancel.CancelAfter(duration * 1000);
                bool revoked = await client.Run(cancel.Token);
                if ((duration > 0 || revoked) && !IsDisposed) Close();
            };
            FormClosing += delegate { cancel.Cancel(); };
        }
        private void OnUpdate(ViewState state) {
            if (IsDisposed || Disposing || !IsHandleCreated) return;
            BeginInvoke((Action)delegate {
                if (IsDisposed) return;
                name.Text = state.Name; map.Text = state.Map + (state.Revision > 0 ? "  ·  配置 " + state.Revision : "");
                status.Text = state.Status; detail.Text = state.Detail; join.Enabled = state.Ready;
                if (state.Ready && !String.IsNullOrEmpty(snapshot)) using (var bitmap = new Bitmap(Width, Height)) { DrawToBitmap(bitmap, new Rectangle(0, 0, Width, Height)); bitmap.Save(snapshot); }
            });
        }
        protected override void Dispose(bool disposing) { if (disposing && !disposed) { disposed = true; cancel.Cancel(); client.Dispose(); cancel.Dispose(); } base.Dispose(disposing); }
    }
    internal static class Program {
        private static string Argument(string[] args, string name) { int index = Array.IndexOf(args, name); return index >= 0 && index + 1 < args.Length ? args[index + 1] : null; }
        [STAThread]
        private static int Main(string[] args) {
            // A portable WinExe has no console code page. Write inherited diagnostic pipes directly.
            try {
                Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true });
                Console.SetError(new StreamWriter(Console.OpenStandardError(), new System.Text.UTF8Encoding(false)) { AutoFlush = true });
            } catch (IOException) { }
            bool headless = Array.IndexOf(args, "--headless") >= 0;
            try {
                if (!Environment.Is64BitOperatingSystem) throw new InvalidOperationException("好友联机需要 64 位 Windows。");
                var bootstrap = Bootstrap.Read(Assembly.GetExecutingAssembly().Location);
                string loopback = Argument(args, "--loopback") ?? "127.0.0.1";
                IPAddress ip;
                if (!IPAddress.TryParse(loopback, out ip) || ip.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork || !IPAddress.IsLoopback(ip)) throw new InvalidOperationException("客户端只能绑定本机回环地址。");
                string directory = Path.GetFullPath(Argument(args, "--state-dir") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ArkConnect", bootstrap.NetworkId, bootstrap.InviteId));
                Directory.CreateDirectory(directory);
                if (!String.IsNullOrEmpty(bootstrap.SteamId)) {
                    if (headless) {
                        // Diagnostic mode only accepts an explicit synthetic test identifier; never reads hardware silently.
                        string supplied = Argument(args,"--device-id");
                        if (supplied == null || !System.Text.RegularExpressions.Regex.IsMatch(supplied,"^[a-f0-9]{64}$")) throw new InvalidOperationException("绑定联机包需要在图形界面同意设备绑定。诊断模式请显式提供测试设备标识。");
                        bootstrap.DeviceId = supplied;
                    } else {
                        string consent = Path.Combine(directory,"device-consent-v1.txt");
                        if (!File.Exists(consent)) {
                            string message = "此联机包由服主绑定到 SteamID " + bootstrap.SteamId + "。\n\n是否同意读取 Windows 安装标识，经本服单独哈希后发送给服主，用于设备封禁？不发送原始安装标识，也不采集 MAC、磁盘序列号或公网 IP。\n\n设备标识可以因系统重装或修改而变化，不能作为永久硬件证明。不同意可取消并通过普通 Steam 方式进服。";
                            if (MessageBox.Show(message,"设备绑定说明",MessageBoxButtons.OKCancel,MessageBoxIcon.Information) != DialogResult.OK) return 0;
                        }
                        using (var key = Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine,Microsoft.Win32.RegistryView.Registry64).OpenSubKey(@"SOFTWARE\Microsoft\Cryptography")) {
                            string machine = key == null ? null : Convert.ToString(key.GetValue("MachineGuid"));
                            if (String.IsNullOrEmpty(machine)) throw new InvalidOperationException("无法读取 Windows 安装标识，请联系服主使用普通联机包。");
                            using (var hash = System.Security.Cryptography.SHA256.Create()) bootstrap.DeviceId = BitConverter.ToString(hash.ComputeHash(System.Text.Encoding.UTF8.GetBytes("ArkControl-device-v1\n" + bootstrap.DeviceScope + "\n" + machine))).Replace("-","").ToLowerInvariant();
                        }
                        File.WriteAllText(consent,"同意时间（UTC）：" + DateTime.UtcNow.ToString("o") + "\nSteamID：" + bootstrap.SteamId);
                    }
                }
                bool noLaunch = Array.IndexOf(args, "--no-launch") >= 0;
                int duration; Int32.TryParse(Argument(args, "--duration"), out duration);
                bool owner;
                using (var mutex = new Mutex(true, "Local\\ArkConnect-" + bootstrap.NetworkId, out owner)) {
                    if (!owner) throw new InvalidOperationException("此联机入口已在本机运行，请使用已打开的窗口。");
                    try {
                        if (headless) {
                            using (var cancel = new CancellationTokenSource())
                            using (var client = new Client(bootstrap, directory, loopback, true, state => Console.WriteLine("STATE " + state.Status + " | " + state.Name + " | " + state.Detail))) {
                                if (duration > 0) cancel.CancelAfter(duration * 1000);
                                Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs eventArgs) { eventArgs.Cancel = true; cancel.Cancel(); };
                                client.Run(cancel.Token).GetAwaiter().GetResult();
                            }
                        } else {
                            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
                            using (var window = new Window(bootstrap, directory, loopback, noLaunch, duration, Argument(args, "--snapshot"))) Application.Run(window);
                        }
                    } finally { mutex.ReleaseMutex(); }
                }
                return 0;
            } catch (Exception error) {
                if (headless) Console.Error.WriteLine(error.Message); else MessageBox.Show(error.Message, "方舟 · 好友联机", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 1;
            }
        }
    }
}
