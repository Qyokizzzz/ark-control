// Local verification fixture only. This is not an ARK server.
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

class FakeArk {
  static string saved;
  static string password;
  static int port = 27020;
  static int points = 1000;
  static readonly System.Collections.Generic.HashSet<string> groups = new System.Collections.Generic.HashSet<string> { "Default" };
  static string Management(string command) {
    lock(gate) {
      File.AppendAllText(Path.Combine(saved,"management-commands.txt"),command + "\n");
      string[] parts=command.Trim().Split(' ');
      if(parts[0]=="GetPlayerPoints")return "Player has " + points + " points\n";
      if(parts[0]=="ChangePoints") { int amount; if(parts.Length<3 || !Int32.TryParse(parts[2],out amount) || points+amount<0)return "Couldn't set points\n"; points+=amount;File.WriteAllText(Path.Combine(saved,"points.txt"),points.ToString());if(File.Exists(Path.Combine(saved,"coins-timeout.txt")))Thread.Sleep(15000);return "Successfully set points\n"; }
      if(parts[0]=="Permissions.PlayerGroups")return "Groups: " + String.Join(", ",groups);
      if(parts[0]=="Permissions.AddTimed") {groups.Add(parts[2]);return "Successfully added timed group";}
      if(parts[0]=="Permissions.RemoveTimed") {groups.Remove(parts[2]);return "Successfully removed timed group";}
      if(parts[0]=="ArkShop.Reload")return "Successfully reloaded config";
      if(parts[0]=="BanPlayer")return "Successfully banned player";
      if(parts[0]=="UnBanPlayer")return "Successfully unbanned player";
      return "Server received";
    }
  }
  static readonly object gate = new object();
  static byte[] ReadExact(Stream stream, int count) { var data = new byte[count]; int offset = 0; while(offset < count) { int read = stream.Read(data, offset, count-offset); if(read == 0) throw new EndOfStreamException(); offset += read; } return data; }
  static void Reply(Stream stream, int id, int type, string message) { byte[] body=Encoding.UTF8.GetBytes(message); using(var writer=new BinaryWriter(stream, Encoding.UTF8, true)) { writer.Write(body.Length+10); writer.Write(id); writer.Write(type); writer.Write(body); writer.Write((byte)0); writer.Write((byte)0); writer.Flush(); } }
  static void Save() { lock(gate) { Directory.CreateDirectory(Path.Combine(saved,"SavedArks")); File.WriteAllText(Path.Combine(saved,"SavedArks","TheIsland.ark"),"verification-world:"+DateTime.UtcNow.ToString("O")); File.WriteAllText(Path.Combine(saved,"SavedArks","123.arktribe"),"verification-tribe"); string marker=Path.Combine(saved,"emit-final-event.txt"); if(File.Exists(marker)) { Directory.CreateDirectory(Path.Combine(saved,"Logs")); File.WriteAllText(Path.Combine(saved,"Logs","final-tribe.log"),File.ReadAllText(marker)); } } }
  static void Serve(object value) { using(var client=(TcpClient)value) { try { var stream=client.GetStream(); bool authorized=false; while(true) { int size=BitConverter.ToInt32(ReadExact(stream,4),0); if(size<10 || size>1048576) return; byte[] packet=ReadExact(stream,size); int id=BitConverter.ToInt32(packet,0); int type=BitConverter.ToInt32(packet,4); string text=Encoding.UTF8.GetString(packet,8,size-10); if(type==3) { authorized=text==password; Reply(stream,authorized?id:-1,2,""); } else if(authorized) { if(text.Equals("ListPlayers",StringComparison.OrdinalIgnoreCase)) Reply(stream,id,0,"0. Test Survivor, 76561198000000001"); else if(text.Equals("SaveWorld",StringComparison.OrdinalIgnoreCase)) { Save(); Reply(stream,id,0,"World saved"); } else if(text.Equals("DoExit",StringComparison.OrdinalIgnoreCase)) { Save(); Reply(stream,id,0,"Stopping"); Thread.Sleep(100); Environment.Exit(0); } else Reply(stream,id,0,Management(text)); } } } catch(IOException) {} catch(SocketException) {} } }
  static void Main() {
    string executable=System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName;
    string project = Path.Combine(Environment.CurrentDirectory, "..", "..", "..", "ShooterGame", "ShooterGame.uproject");
    if (!File.Exists(project) || new FileInfo(project).Length == 0) {
      Console.Error.WriteLine("Failed to open descriptor file '../../../ShooterGame/ShooterGame.uproject'");
      Environment.Exit(43);
    }
    saved=Path.GetFullPath(Path.Combine(Path.GetDirectoryName(executable),"..","..","Saved"));
    string ini=Path.Combine(saved,"Config","WindowsServer","GameUserSettings.ini");
    const string harvestKey = "HarvestAmountMultiplier=";
    string harvest = "1";
    string[] lines = File.ReadAllLines(ini);
    if (File.Exists(Path.Combine(saved, "rewrite-harvest-on-start.txt"))) {
      lines = Array.FindAll(lines, line => !line.StartsWith(harvestKey, StringComparison.OrdinalIgnoreCase));
      File.WriteAllLines(ini, lines, Encoding.Unicode);
    }
    foreach(var line in lines) {
      if(line.StartsWith("RCONPort=")) port=int.Parse(line.Substring(9));
      if(line.StartsWith("ServerAdminPassword=")) password=line.Substring(20);
      if (line.StartsWith(harvestKey, StringComparison.OrdinalIgnoreCase))
        harvest = line.Substring(harvestKey.Length);
    }
    foreach (string argument in Environment.GetCommandLineArgs()) {
      foreach (string option in argument.Split('?')) {
        if (option.StartsWith(harvestKey, StringComparison.OrdinalIgnoreCase))
          harvest = option.Substring(harvestKey.Length);
        if (option.StartsWith("SessionName="))
          File.WriteAllText(Path.Combine(saved, "launch-session-name.txt"), option.Substring("SessionName=".Length));
      }
    }
    File.WriteAllText(Path.Combine(saved, "launch-harvest.txt"), harvest);
    if(File.Exists(Path.Combine(saved,"points.txt")))Int32.TryParse(File.ReadAllText(Path.Combine(saved,"points.txt")),out points);
    if(File.Exists(Path.Combine(saved,"require-url-admin.txt"))) {
      password="";
      foreach(string argument in Environment.GetCommandLineArgs())foreach(string option in argument.Split('?'))if(option.StartsWith("ServerAdminPassword="))password=option.Substring("ServerAdminPassword=".Length);
      var remaining=new System.Collections.Generic.List<string>();foreach(string line in File.ReadAllLines(ini))if(!line.StartsWith("ServerAdminPassword="))remaining.Add(line);File.WriteAllLines(ini,remaining.ToArray());
      Console.WriteLine("Commandline: " + String.Join(" ",Environment.GetCommandLineArgs()));
      if(String.IsNullOrEmpty(password)) { Console.WriteLine("LOCAL FIXTURE: missing launch admin password, RCON disabled");Thread.Sleep(60000);return; }
    }
    Save();
    Directory.CreateDirectory(Path.Combine(saved,"Logs"));
    string startupLog=Path.Combine(saved,"Logs","ShooterGame.log");
    Console.WriteLine("LOCAL VERIFICATION: loading map");
    File.AppendAllText(startupLog,"LOCAL VERIFICATION: loading map\n");
    int delay=0;
    string delayFile=Path.Combine(saved,"startup-delay.txt");
    if(File.Exists(delayFile)) int.TryParse(File.ReadAllText(delayFile),out delay);
    Thread.Sleep(Math.Max(0,Math.Min(60000,delay)));
    if(File.Exists(Path.Combine(saved,"startup-crash.txt"))) {
      Console.WriteLine("LOCAL VERIFICATION: startup failed before RCON");
      File.AppendAllText(startupLog,"LOCAL VERIFICATION: startup failed before RCON\n");
      Environment.Exit(42);
    }
    var listener=new TcpListener(IPAddress.Loopback,port);
    listener.Start();
    Console.WriteLine("LOCAL VERIFICATION FIXTURE READY");
    while(true) ThreadPool.QueueUserWorkItem(Serve,listener.AcceptTcpClient());
  }
}
