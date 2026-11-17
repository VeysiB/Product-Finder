using System.Text.RegularExpressions;

namespace ProductSearch.Core;

/// <summary>
/// Ürün özelliklerinden, adından ve satıcı başlıklarından işletim sistemini normalize eder.
/// "Windows 10", "Windows 11 Pro", "Win11", "W11H" gibi tüm yazımlar "windows" olarak kabul edilir.
/// </summary>
public static partial class OperatingSystemDetector
{
    public static readonly IReadOnlyList<string> Known =
        ["windows", "macos", "freedos", "linux", "chromeos", "android", "ios", "harmonyos"];

    public static readonly IReadOnlyDictionary<string, string> DisplayNames = new Dictionary<string, string>
    {
        ["windows"] = "Windows (10, 11, Home, Pro...)",
        ["macos"] = "macOS",
        ["freedos"] = "FreeDOS / İşletim sistemsiz",
        ["linux"] = "Linux / Ubuntu / Pardus",
        ["chromeos"] = "ChromeOS",
        ["android"] = "Android",
        ["ios"] = "iOS / iPadOS",
        ["harmonyos"] = "HarmonyOS",
    };

    /// <summary>Akakçe aramasına eklenebilecek anahtar kelime (adında işletim sistemi geçen ürünleri yakalamak için).</summary>
    public static string? SearchKeyword(string os) => os switch
    {
        "windows" => "windows",
        "freedos" => "freedos",
        "linux" => "ubuntu",
        "chromeos" => "chromebook",
        "android" => "android",
        "harmonyos" => "harmonyos",
        _ => null,
    };

    /// <summary>Özellik → ad → satıcı başlıkları sırasıyla işletim sistemini bulur.</summary>
    public static string? Detect(IReadOnlyDictionary<string, string>? specs, string? name, IEnumerable<string?>? offerTitles = null)
    {
        if (specs is not null)
        {
            foreach (var (k, v) in specs)
            {
                if (IsOsKey(k) && Normalize(v) is { } fromSpec) return fromSpec;
            }
        }
        if (FromName(name) is { } fromName) return fromName;

        if (offerTitles is not null)
        {
            // Satıcı başlıklarında en çok geçen işletim sistemi
            var best = offerTitles.Select(FromName).Where(o => o is not null)
                .GroupBy(o => o).OrderByDescending(g => g.Count()).FirstOrDefault();
            if (best is not null) return best.Key;
        }
        return null;
    }

    private static bool IsOsKey(string key)
    {
        var k = TextUtil.Fold(key);
        return k.Contains("isletim sistemi") || k is "os" or "yazilim" or "platform";
    }

    /// <summary>Kullanıcı girdisini veya özellik değerini normalize eder.</summary>
    public static string? Normalize(string? value)
    {
        var v = TextUtil.Fold(value);
        if (v.Length == 0) return null;
        if (Known.Contains(v)) return v;
        if (WindowsRx().IsMatch(v)) return "windows";
        if (v.Contains("mac")) return "macos";
        if (v.Contains("dos") || v.Contains("yok") || v.Contains("sistemsiz") || v is "fd" or "none" or "no os") return "freedos";
        if (v.Contains("linux") || v.Contains("ubuntu") || v.Contains("pardus") || v.Contains("debian")) return "linux";
        if (v.Contains("chrome")) return "chromeos";
        if (v.Contains("android")) return "android";
        if (v.Contains("ipados") || v.Contains("ios")) return "ios";
        if (v.Contains("harmony")) return "harmonyos";
        return FromName(v);
    }

    public static string? FromName(string? name)
    {
        var n = TextUtil.Fold(name);
        if (n.Length == 0) return null;
        if (WindowsRx().IsMatch(n)) return "windows";
        if (FreeDosRx().IsMatch(n)) return "freedos";
        if (n.Contains("macbook") || n.Contains("imac") || n.Contains("mac mini") || n.Contains("mac studio") || n.Contains("macos")) return "macos";
        if (n.Contains("chromebook") || n.Contains("chrome os") || n.Contains("chromeos")) return "chromeos";
        if (n.Contains("ubuntu") || n.Contains("linux") || n.Contains("pardus")) return "linux";
        if (n.Contains("iphone") || n.Contains("ipad")) return "ios";
        if (n.Contains("harmonyos")) return "harmonyos";
        if (n.Contains("android")) return "android";
        return null;
    }

    // windows, windows10, windows 11 pro, win10, win 11, w10, w11h, w11p, w11 home ...
    [GeneratedRegex(@"windows|\bwin ?1[01]|\bw1[01](?: ?(?:home|pro|h|p))?\b|\bwin(?:dows)? ?(?:home|pro)\b")]
    private static partial Regex WindowsRx();

    [GeneratedRegex(@"free ?dos|\bfdos\b|\bdos\b|isletim sistemi yok|\bos yok\b|isletim sistemsiz")]
    private static partial Regex FreeDosRx();
}
