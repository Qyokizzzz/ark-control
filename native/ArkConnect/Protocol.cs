using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace ArkConnect {
    internal static class Json {
        internal static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer { MaxJsonLength = 524288 };
        internal static Dictionary<string, object> Parse(string text) { return Serializer.Deserialize<Dictionary<string, object>>(text); }
        internal static string Text(Dictionary<string, object> item, string key) { return Convert.ToString(item[key]); }
        internal static int Number(Dictionary<string, object> item, string key) { return Convert.ToInt32(item[key]); }
        internal static long Long(Dictionary<string, object> item, string key) { return Convert.ToInt64(item[key]); }
        internal static bool Bool(Dictionary<string, object> item, string key) { return Convert.ToBoolean(item[key]); }
        internal static Dictionary<string, object> Object(Dictionary<string, object> item, string key) { return (Dictionary<string, object>)item[key]; }
        internal static string Quote(string text) { return Serializer.Serialize(text); }
        internal static string[] Strings(Dictionary<string, object> item, string key) {
            var list = (System.Collections.IEnumerable)item[key];
            var values = new List<string>();
            foreach (object value in list) values.Add(Convert.ToString(value));
            return values.ToArray();
        }
    }
    internal sealed class Bootstrap {
        internal string SteamId, DeviceId, DeviceScope;
        internal string NetworkId, InviteId, Token, NetworkName, NetworkSecret, ControllerIp, ManifestOrigin;
        internal int ControllerPort;
        internal bool AutoLaunch;
        internal string[] Peers;
        internal RSAParameters PublicKey;
        private static byte[] Decode(string value) {
            string text = value.Replace('-', '+').Replace('_', '/');
            return Convert.FromBase64String(text.PadRight((text.Length + 3) / 4 * 4, '='));
        }
        internal static Bootstrap Read(string path) {
            byte[] magic = Encoding.ASCII.GetBytes("ARKCONNECT-V1-END");
            byte[] bytes;
            using (var file = File.OpenRead(path)) {
                if (file.Length < magic.Length + 4) throw new InvalidDataException("请从管理后台下载好友联机包。");
                file.Seek(-magic.Length - 4, SeekOrigin.End);
                using (var reader = new BinaryReader(file)) {
                    int size = reader.ReadInt32();
                    byte[] tail = reader.ReadBytes(magic.Length);
                    if (size <= 0 || size > 65536 || file.Length < size + magic.Length + 4 || Encoding.ASCII.GetString(tail) != "ARKCONNECT-V1-END")
                        throw new InvalidDataException("请从管理后台下载好友联机包，此文件尚未配置入口。");
                    file.Seek(-magic.Length - 4 - size, SeekOrigin.End);
                    bytes = reader.ReadBytes(size);
                }
            }
            var item = Json.Parse(Encoding.UTF8.GetString(bytes));
            if (Json.Number(item, "version") != 1) throw new InvalidDataException("客户端版本不兼容，请重新下载联机包。");
            var key = Json.Object(item, "publicKey");
            var bootstrap = new Bootstrap {
                SteamId = item.ContainsKey("steamId") ? Json.Text(item,"steamId") : null,
                DeviceScope = item.ContainsKey("deviceScope") ? Json.Text(item,"deviceScope") : Json.Text(item,"networkId"),
                NetworkId = Json.Text(item, "networkId"), InviteId = Json.Text(item, "inviteId"), Token = Json.Text(item, "inviteToken"),
                NetworkName = Json.Text(item, "networkName"), NetworkSecret = Json.Text(item, "networkSecret"),
                ControllerIp = Json.Text(item, "controllerIp"), ControllerPort = Json.Number(item, "controllerPort"),
                ManifestOrigin = item.ContainsKey("manifestOrigin") ? Json.Text(item, "manifestOrigin") : null,
                Peers = Json.Strings(item, "peers"), AutoLaunch = Json.Bool(item, "autoLaunch"),
                PublicKey = new RSAParameters { Modulus = Decode(Json.Text(key, "n")), Exponent = Decode(Json.Text(key, "e")) }
            };
            Guid.Parse(bootstrap.NetworkId); Guid.Parse(bootstrap.InviteId);
            if (bootstrap.ControllerIp != "10.126.126.1" || bootstrap.ControllerPort < 1 || bootstrap.ControllerPort > 65535) throw new InvalidDataException("后台入口配置无效。");
            Uri origin;
            if (bootstrap.ManifestOrigin != null && (!Uri.TryCreate(bootstrap.ManifestOrigin, UriKind.Absolute, out origin) || origin.Scheme != "https" || origin.Host.Length == 0 || origin.UserInfo.Length != 0 || origin.AbsolutePath != "/" || origin.Query.Length != 0 || origin.Fragment.Length != 0)) throw new InvalidDataException("管理后台 HTTPS 地址无效。");
            Protocol.ValidatePeers(bootstrap.Peers);
            return bootstrap;
        }
    }
    internal sealed class Manifest {
        internal string Ip, Name, Map;
        internal int GamePort, QueryPort, Revision;
        internal long IssuedAt;
        internal bool Enabled, Running, DeviceBlocked;
        internal string[] Peers;
        internal string Fingerprint { get { return Enabled ? Ip + ":" + GamePort + ":" + QueryPort + ":" + String.Join(",", Peers) : "paused:" + String.Join(",", Peers); } }
    }
    internal static class Protocol {
        internal static void ValidatePeers(string[] peers) {
            if (peers.Length < 1 || peers.Length > 8) throw new InvalidDataException("引导节点配置无效。");
            foreach (string value in peers) {
                Uri uri;
                if (!Uri.TryCreate(value, UriKind.Absolute, out uri) || Array.IndexOf(new[] { "tcp", "udp", "ws", "wss" }, uri.Scheme) < 0 || String.IsNullOrEmpty(uri.Host) || !String.IsNullOrEmpty(uri.UserInfo) || !String.IsNullOrEmpty(uri.Query) || !String.IsNullOrEmpty(uri.Fragment))
                    throw new InvalidDataException("引导节点地址无效。");
            }
        }
        internal static long Now { get { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; } }
        internal static Manifest Verify(string envelope, Bootstrap bootstrap, int revision, long issuedAt) {
            var wrapper = Json.Parse(envelope);
            if (Json.Text(wrapper, "code") != "OK") throw new InvalidDataException("后台暂时无法提供联机配置。");
            var signed = Json.Object(wrapper, "data");
            byte[] payload = Convert.FromBase64String(Json.Text(signed, "payload"));
            byte[] signature = Convert.FromBase64String(Json.Text(signed, "signature"));
            using (var rsa = new RSACryptoServiceProvider()) {
                rsa.PersistKeyInCsp = false;
                rsa.ImportParameters(bootstrap.PublicKey);
                if (!rsa.VerifyData(payload, CryptoConfig.MapNameToOID("SHA256"), signature)) throw new InvalidDataException("联机配置签名不正确，已拒绝更新。");
            }
            var item = Json.Parse(Encoding.UTF8.GetString(payload));
            long now = Now, issued = Json.Long(item, "issuedAt"), expires = Json.Long(item, "expiresAt");
            if (Json.Text(item, "networkId") != bootstrap.NetworkId || Json.Text(item, "inviteId") != bootstrap.InviteId || issued > now + 30000 || expires < now || expires <= issued || expires - issued > 300000 || issued < issuedAt || Json.Number(item, "revision") < revision)
                throw new InvalidDataException("联机配置已过期或不属于此入口，请校准系统时间或联系服主。");
            var game = Json.Object(item, "game");
            var result = new Manifest { Ip = Json.Text(game, "ipv4"), Name = Json.Text(game, "name"), Map = Json.Text(game, "mapLabel"),
                DeviceBlocked = item.ContainsKey("deviceBlocked") && Json.Bool(item,"deviceBlocked"),
                GamePort = Json.Number(game, "gamePort"), QueryPort = Json.Number(game, "queryPort"), Revision = Json.Number(item, "revision"),
                IssuedAt = issued, Enabled = Json.Bool(item, "enabled"), Running = Json.Bool(game, "running"), Peers = Json.Strings(item, "peers") };
            if ((result.Ip != "10.126.126.1" && result.Ip != "10.126.126.2") || result.GamePort < 1024 || result.GamePort > 65534 || result.QueryPort < 1024 || result.QueryPort > 65535 || result.QueryPort == result.GamePort || result.QueryPort == result.GamePort + 1)
                throw new InvalidDataException("游戏端口配置无效。");
            ValidatePeers(result.Peers);
            return result;
        }
    }
}
