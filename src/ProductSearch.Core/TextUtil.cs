using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace ProductSearch.Core;

public static partial class TextUtil
{
    private static readonly CultureInfo Tr = CultureInfo.GetCultureInfo("tr-TR");

    /// <summary>Türkçe karakterleri sadeleştirip küçük harfe çevirir (karşılaştırma için).</summary>
    public static string Fold(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return "";
        var lower = s.ToLower(Tr)
            .Replace('ı', 'i').Replace('ş', 's').Replace('ğ', 'g')
            .Replace('ü', 'u').Replace('ö', 'o').Replace('ç', 'c');
        var sb = new StringBuilder(lower.Length);
        foreach (var c in lower.Normalize(NormalizationForm.FormD))
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark) sb.Append(c);
        }
        return Spaces().Replace(sb.ToString(), " ").Trim();
    }

    /// <summary>Metindeki tüm kelimeler hedefte geçiyor mu? (sıra önemsiz)</summary>
    public static bool ContainsAllTokens(string haystack, string? needle)
    {
        if (string.IsNullOrWhiteSpace(needle)) return true;
        var h = Fold(haystack);
        var hCompact = h.Replace(" ", "").Replace("-", "");
        foreach (var token in Fold(needle).Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            if (!h.Contains(token) && !hCompact.Contains(token.Replace("-", ""))) return false;
        }
        return true;
    }

    private static readonly HashSet<string> StopWords = ["ve", "ile", "icin", "the", "and", "for", "en", "ucuz", "fiyat", "fiyati"];

    /// <summary>Aramadaki kelimelerin ürün adında geçme oranı (0-1). Kelime bazlı; uzun kelimelerde ek toleransı vardır.</summary>
    public static double RelevanceScore(string name, string query)
    {
        var tokens = Words(query).Where(t => !StopWords.Contains(t)).Distinct().ToList();
        if (tokens.Count == 0) return 1;
        var words = Words(name);
        var compact = string.Concat(words);
        var hit = 0;
        foreach (var t in tokens)
        {
            if (words.Contains(t) ||
                (t.Length >= 5 && words.Any(w => w.StartsWith(t) || (w.Length >= 5 && t.StartsWith(w)))) ||
                (t.Any(char.IsDigit) && compact.Contains(t)))
                hit++;
        }
        return (double)hit / tokens.Count;
    }

    private static readonly string[] AccessoryWords =
    [
        "kilif", "kilifi", "koruyucu", "koruyucusu", "kapak", "kapagi", "temperli", "nano cam", "ekran cami", "canta", "cantasi",
        "uyumlu", "yedek", "stand", "standi", "tutucu", "tutucusu", "sticker", "kaplama", "kordon", "kayis", "askisi",
        "sarj aleti", "sarj cihazi", "adaptor", "adaptoru", "kablo", "kablosu", "dokunmatik kalem", "kalem ucu", "klavye kilif",
        "sogutucu", "fan", "dock", "hub", "dongle", "alicisi", "donusturucu", "grafik tablet", "cizim tableti",
        "oyun denetleyicisi", "gamepad", "mouse pad", "lisans", "office"
    ];

    /// <summary>Ürün adı aksesuar gibi mi görünüyor? (aramada da geçen kelimeler sayılmaz)</summary>
    public static bool LooksLikeAccessory(string name, string query)
    {
        var n = " " + string.Join(' ', Words(name)) + " ";
        var q = " " + string.Join(' ', Words(query)) + " ";
        foreach (var w in AccessoryWords)
        {
            var key = " " + w + " ";
            if (n.Contains(key) && !q.Contains(key)) return true;
        }
        return false;
    }

    public static List<string> Words(string? s) =>
        NonWord().Split(Fold(s)).Where(w => w.Length > 0).ToList();

    /// <summary>"28.349,05 TL" veya "28349.05" -> 28349.05</summary>
    public static decimal? ParsePrice(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = s.Trim();
        // JSON-LD invariant format: "28349.05"
        if (InvariantNumber().IsMatch(s) &&
            decimal.TryParse(s, NumberStyles.Number, CultureInfo.InvariantCulture, out var inv))
            return inv;

        var m = TrNumber().Match(s);
        if (!m.Success) return null;
        var digits = m.Value.Replace(".", "").Replace(" ", "").Replace(",", ".");
        return decimal.TryParse(digits, NumberStyles.Number, CultureInfo.InvariantCulture, out var d) ? d : null;
    }

    public static string FormatPrice(decimal price) => price.ToString("N2", Tr) + " TL";

    [GeneratedRegex(@"\s+")] private static partial Regex Spaces();
    [GeneratedRegex(@"[^\p{L}\p{N}]+")] private static partial Regex NonWord();
    [GeneratedRegex(@"^\d+(\.\d+)?$")] private static partial Regex InvariantNumber();
    [GeneratedRegex(@"\d{1,3}(?:[.\s]\d{3})*(?:,\d+)?|\d+(?:,\d+)?")] private static partial Regex TrNumber();
}
