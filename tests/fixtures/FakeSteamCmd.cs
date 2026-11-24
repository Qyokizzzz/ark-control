using System;
using System.IO;

// Local verification only: this process does not contact Steam or download game files.
internal static class FakeSteamCmd {
    private static int Main(string[] args) {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        File.AppendAllText(Path.Combine(root, "commands.txt"), String.Join(" ", args) + Environment.NewLine);
        if (args.Length == 1 && args[0] == "+quit") {
            File.WriteAllText(Path.Combine(root, "initialized.txt"), "ready");
            Console.WriteLine("SteamCMD initialization complete.");
            return 0;
        }
        if(Array.IndexOf(args,"+app_info_print")>=0) {Console.WriteLine("\"376030\" { \"depots\" { \"branches\" { \"public\" { \"buildid\" \"123456\" } \"preaquatica\" { \"buildid\" \"987654\" } } } }");return 0;}
        int installDir = Array.IndexOf(args, "+force_install_dir");
        int login = Array.IndexOf(args, "+login");
        int refresh = Array.IndexOf(args, "+app_info_update");
        int update = Array.IndexOf(args, "+app_update");
        if (!File.Exists(Path.Combine(root, "initialized.txt")) || installDir < 0 ||
            login <= installDir || refresh <= login || update <= refresh || args[refresh + 1] != "1") {
            Console.Error.WriteLine("ERROR! Fixture requires initialization and metadata refresh before app_update.");
            return 9;
        }
        string counter = Path.Combine(root, "attempts.txt");
        int attempts = File.Exists(counter) ? Int32.Parse(File.ReadAllText(counter)) : 0;
        File.WriteAllText(counter, (attempts + 1).ToString());
        string modeFile = Path.Combine(root, "missing-config.txt");
        if (File.Exists(modeFile)) {
            string mode = File.ReadAllText(modeFile).Trim();
            string metadataCounter = Path.Combine(root, "metadata-" + mode + "-attempts.txt");
            int metadataAttempts = File.Exists(metadataCounter) ? Int32.Parse(File.ReadAllText(metadataCounter)) : 0;
            File.WriteAllText(metadataCounter, (metadataAttempts + 1).ToString());
            if (mode == "always" || metadataAttempts == 0) {
                string logs = Path.Combine(root, "logs");
                Directory.CreateDirectory(logs);
                File.WriteAllText(Path.Combine(logs, "content_log.txt"), "App 376030: installation metadata unavailable (local fixture).\n");
                File.WriteAllText(Path.Combine(logs, "connection_log.txt"), "Steam connection diagnostic (local fixture).\n");
                Console.Error.WriteLine("ERROR! Failed to install app '376030' (Missing configuration)");
                return 8;
            }
            string directory = args[installDir + 1];
            string game = Path.Combine(directory, "ShooterGame", "Binaries", "Win64");
            string template = Path.Combine(root, "fixture-game.exe");
            string target = Path.Combine(game, "ShooterGameServer.exe");
            if (File.Exists(template) && !File.Exists(target)) {
                Directory.CreateDirectory(game);
                File.Copy(template, target);
            }
            string maps = Path.Combine(directory, "ShooterGame", "Content", "Maps");
            Directory.CreateDirectory(maps);
            File.WriteAllText(Path.Combine(maps, "TheIsland.umap"), "fixture island asset");
            File.WriteAllText(Path.Combine(directory, "ShooterGame", "ShooterGame.uproject"), "{\"FileVersion\":3}");
            string steamapps = Path.Combine(directory, "steamapps");
            Directory.CreateDirectory(steamapps);
            bool beta = Array.IndexOf(args, "preaquatica") >= 0;
            File.WriteAllText(Path.Combine(steamapps, "appmanifest_376030.acf"), "\"buildid\" \"" + (beta ? "987654" : "123456") + "\"");
            Console.WriteLine("Success! App '376030' fully installed.");
            return 0;
        }
        Console.WriteLine("SteamCMD local verification fixture");
        Console.Error.WriteLine("ERROR! Failed to install app '376030' (Disk write failure)");
        return 7;
    }
}
