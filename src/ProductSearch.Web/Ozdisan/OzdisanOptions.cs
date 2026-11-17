namespace ProductSearch.Web.Ozdisan;

/// <summary>Özdisan bileşeninin nasıl başlatılacağı (appsettings.json → "Ozdisan").</summary>
public sealed class OzdisanOptions
{
    /// <summary>Node.js çalıştırılabilir dosyası (PATH'te ise "node").</summary>
    public string NodePath { get; set; } = "node";

    /// <summary>Depoda Özdisan bileşeninin derlenmiş giriş dosyasının göreli yolu.</summary>
    public const string DefaultServerScript = "tools/ozdisan/dist/index.js";

    /// <summary>
    /// Özdisan bileşeninin derlenmiş giriş dosyası. Mutlak yol verilebilir; göreli yol ise içerik kökünden ve
    /// uygulama klasöründen başlayarak üst klasörlerde aranır (depo kökü, proje klasörü veya bin klasöründen çalıştırma).
    /// </summary>
    public string ServerScript { get; set; } = DefaultServerScript;

    /// <summary>Göreli <see cref="ServerScript"/> yolunu verilen başlangıç klasörlerinden yukarı doğru arayarak çözer.</summary>
    public static string ResolveScript(string configured, params string[] startDirs)
    {
        var path = Environment.ExpandEnvironmentVariables(string.IsNullOrWhiteSpace(configured) ? DefaultServerScript : configured.Trim());
        if (Path.IsPathRooted(path)) return Path.GetFullPath(path);
        foreach (var start in startDirs.Where(d => !string.IsNullOrEmpty(d)))
        {
            for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
            {
                var candidate = Path.GetFullPath(Path.Combine(dir.FullName, path));
                if (File.Exists(candidate)) return candidate;
            }
        }
        // Bulunamadı: hata mesajında anlamlı bir yol görünsün diye ilk başlangıç klasörüne göre döndür
        return Path.GetFullPath(Path.Combine(startDirs.FirstOrDefault(d => !string.IsNullOrEmpty(d)) ?? ".", path));
    }

    /// <summary>Varsayılan para birimi: TRY / USD / EUR (her istekte ayrıca seçilebilir).</summary>
    public string Currency { get; set; } = "TRY";

    /// <summary>Varsayılan dil: tr / en (her istekte ayrıca seçilebilir).</summary>
    public string Language { get; set; } = "tr";

    /// <summary>Datasheet indirme klasörü. Boşsa ~/Downloads/ozdisan-datasheets.</summary>
    public string? DownloadDir { get; set; }

    /// <summary>Tek bir araç çağrısı için en uzun süre (BOM 60 satırda ~1 dk sürebilir).</summary>
    public int ToolTimeoutSeconds { get; set; } = 180;

    public string ResolvedDownloadDir
    {
        get
        {
            if (!string.IsNullOrWhiteSpace(DownloadDir)) return Path.GetFullPath(Environment.ExpandEnvironmentVariables(DownloadDir));
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var downloads = Path.Combine(home, "Downloads");
            return Directory.Exists(downloads)
                ? Path.Combine(downloads, "ozdisan-datasheets")
                : Path.Combine(home, "ozdisan-datasheets");
        }
    }
}
