using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using AngleSharp.Dom;
using AngleSharp.Html.Parser;
using Microsoft.Extensions.Logging;

namespace ProductSearch.Core;

/// <summary>
/// Akakçe fiyat karşılaştırma sitesinden arama sonuçlarını ve ürün tekliflerini okur.
/// Akakçe; Hepsiburada, Trendyol, Idefix ve diğer satıcıların tekliflerini doğrudan ürün linkleriyle listeler.
/// </summary>
public sealed class AkakceClient(HttpClient http, ILogger<AkakceClient> logger)
{
    public const string BaseUrl = "https://www.akakce.com";
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(15);
    private static readonly ConcurrentDictionary<string, (DateTimeOffset At, string Html)> Cache = new();
    private readonly HtmlParser _parser = new();

    public static string SearchUrl(string query, int page = 1) =>
        $"{BaseUrl}/arama/?q={Uri.EscapeDataString(query)}" + (page > 1 ? $"&p={page}" : "");

    /// <summary>Akakçe arama sonuç sayfasındaki ürünleri döndürür. Failed: ilk sayfa okunamadı.</summary>
    public async Task<(List<ProductSummary> Items, bool Failed)> SearchAsync(string query, int pages, CancellationToken ct)
    {
        var results = new List<ProductSummary>();
        var seen = new HashSet<string>();
        for (var page = 1; page <= Math.Clamp(pages, 1, 5); page++)
        {
            var html = await GetHtmlAsync(SearchUrl(query, page), ct);
            if (html is null) return (results, page == 1);
            var doc = await _parser.ParseDocumentAsync(html, ct);
            var items = ParseSearchList(doc);
            var added = 0;
            foreach (var item in items)
            {
                if (seen.Add(item.Id)) { results.Add(item); added++; }
            }
            // Son sayfa ya da tekrar eden içerik (ör. kategori yönlendirmesi)
            if (added == 0 || doc.QuerySelector($"a[title='Sayfa {page + 1}']") is null) break;
        }
        return (results, false);
    }

    private static List<ProductSummary> ParseSearchList(IDocument doc)
    {
        var list = new List<ProductSummary>();
        foreach (var li in doc.QuerySelectorAll("ul.pl_v9 > li[data-pr]"))
        {
            var a = li.QuerySelector("a.iC") ?? li.QuerySelector("a[href]");
            var href = a?.GetAttribute("href");
            var name = (li.QuerySelector(".pn_v8")?.TextContent ?? a?.GetAttribute("title") ?? "").Trim();
            if (name.Length == 0) continue;

            var priceEl = li.QuerySelector(".pt_v9, .pt_v8");
            int? offerCount = null;
            var countText = priceEl?.QuerySelector("span")?.TextContent;
            if (countText is not null)
            {
                var digits = new string(countText.Where(char.IsDigit).ToArray());
                if (int.TryParse(digits, out var oc)) offerCount = oc + 1;
                else if (TextUtil.Fold(countText).Contains("tek")) offerCount = 1;
            }
            if (priceEl?.QuerySelector("span") is { } inner) inner.Remove();

            var brand = li.GetAttribute("data-mk");
            var image = li.QuerySelector("img")?.GetAttribute("src");
            // Linksiz ürünler: Akakçe'de tek satıcılı, satıcıya JavaScript ile yönlendiriliyor.
            var hasPage = !string.IsNullOrEmpty(href);

            list.Add(new ProductSummary
            {
                Id = li.GetAttribute("data-pr")!,
                Name = name,
                Brand = string.IsNullOrWhiteSpace(brand) || brand.Trim() == "-" ? null : brand.Trim(),
                LowestPrice = TextUtil.ParsePrice(priceEl?.TextContent),
                OfferCount = offerCount,
                Url = hasPage ? Absolute(href!) : null,
                ImageUrl = image,
                SellerSite = hasPage ? null : SiteFromImage(image),
            });
        }
        return list;
    }

    /// <summary>Akakçe görsel vekil adresinden (p.x?…) kaynak sitenin tahmini.</summary>
    internal static Site SiteFromImage(string? imageUrl)
    {
        if (string.IsNullOrEmpty(imageUrl)) return Site.Akakce;
        var u = Uri.UnescapeDataString(imageUrl).ToLowerInvariant();
        if (u.Contains("hepsiburada")) return Site.Hepsiburada;
        if (u.Contains("dsmcdn.com") || u.Contains("trendyol")) return Site.Trendyol;
        if (u.Contains("idefix")) return Site.Idefix;
        return Site.Akakce;
    }

    /// <summary>Akakçe ürün sayfasından özellikleri ve satıcı tekliflerini okur.</summary>
    public async Task<ProductDetail?> GetProductAsync(string url, CancellationToken ct)
    {
        url = Absolute(url);
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || !uri.Host.EndsWith("akakce.com"))
            throw new ArgumentException("Sadece akakce.com ürün linkleri desteklenir.", nameof(url));

        var html = await GetHtmlAsync(url, ct);
        if (html is null) return null;
        var doc = await _parser.ParseDocumentAsync(html, ct);

        JsonElement? product = null;
        foreach (var script in doc.QuerySelectorAll("script[type='application/ld+json']"))
        {
            try
            {
                using var json = JsonDocument.Parse(script.TextContent);
                product = FindProduct(json.RootElement)?.Clone();
                if (product is not null) break;
            }
            catch (JsonException) { }
        }

        var name = Str(product, "name") ?? doc.QuerySelector("h1")?.TextContent.Trim() ?? "";
        var specs = new Dictionary<string, string>();
        if (product?.TryGetProperty("additionalProperty", out var props) == true && props.ValueKind == JsonValueKind.Array)
        {
            foreach (var p in props.EnumerateArray())
            {
                var k = Str(p, "name"); var v = Str(p, "value");
                if (k is not null && v is not null) specs[k] = v;
            }
        }

        // Bazı kategorilerde (ör. cep telefonu) özellikler JSON-LD'de yok; sayfa durum verisindeki descriptiveText'ten oku.
        foreach (var (k, v) in ParseDescriptiveText(html))
            specs.TryAdd(k, v);

        decimal? low = null, high = null; int? count = null;
        var jsonOffers = new List<Offer>();
        if (product?.TryGetProperty("offers", out var offers) == true)
        {
            low = TextUtil.ParsePrice(Str(offers, "lowPrice"));
            high = TextUtil.ParsePrice(Str(offers, "highPrice"));
            if (int.TryParse(Str(offers, "offerCount"), out var c)) count = c;
            var arr = offers.ValueKind == JsonValueKind.Array ? offers
                : offers.TryGetProperty("offers", out var inner) ? inner : offers;
            foreach (var o in arr.ValueKind == JsonValueKind.Array ? arr.EnumerateArray() : Enumerable.Repeat(arr, 1))
            {
                var price = TextUtil.ParsePrice(Str(o, "price"));
                var offerUrl = Str(o, "url");
                if (price is null || offerUrl is null) continue;
                var sellerName = o.TryGetProperty("seller", out var s) ? Str(s, "name") : null;
                jsonOffers.Add(MakeOffer(sellerName, offerUrl, price.Value, null, url, direct: true));
            }
        }

        var htmlOffers = ParseHtmlOffers(doc, url);
        var merged = MergeOffers(jsonOffers, htmlOffers);

        var brand = product is { } pr && pr.TryGetProperty("brand", out var b)
            ? (b.ValueKind == JsonValueKind.Object ? Str(b, "name") : b.GetString())
            : null;
        string? image = null;
        if (product is { } pi && pi.TryGetProperty("image", out var img))
            image = ImageUrl(img);

        return new ProductDetail
        {
            Url = url,
            Name = WebUtility.HtmlDecode(name),
            Brand = brand,
            ImageUrl = image,
            LowPrice = low ?? merged.MinBy(o => o.Price)?.Price,
            HighPrice = high ?? merged.MaxBy(o => o.Price)?.Price,
            OfferCount = count ?? merged.Count,
            Specs = specs,
            Offers = merged.OrderBy(o => o.Price).ToList(),
        };
    }

    /// <summary>Sayfadaki satıcı listesi (#PL). Linkleri JS ile açıldığı için Akakçe ürün sayfasına bağlanır.</summary>
    private static List<Offer> ParseHtmlOffers(IDocument doc, string productUrl)
    {
        var list = new List<Offer>();
        foreach (var li in doc.QuerySelectorAll("#PL > li"))
        {
            var price = TextUtil.ParsePrice(li.QuerySelector(".pt_v8")?.TextContent);
            if (price is null) continue;
            var sellerEl = li.QuerySelector(".v_v8");
            var platform = sellerEl?.QuerySelector("img")?.GetAttribute("alt");
            var sellerText = sellerEl?.TextContent.Trim();
            var seller = platform is null ? sellerText : platform + (sellerText ?? "");
            var title = li.QuerySelector(".pn_v8")?.TextContent.Trim();
            list.Add(MakeOffer(seller, null, price.Value, title, productUrl, direct: false));
        }
        return list;
    }

    /// <summary>JSON-LD (doğrudan link) ve HTML (tam liste) tekliflerini birleştirir.</summary>
    private static List<Offer> MergeOffers(List<Offer> json, List<Offer> html)
    {
        var result = new List<Offer>(json);
        var used = new HashSet<int>();
        foreach (var h in html)
        {
            var idx = -1;
            for (var i = 0; i < json.Count; i++)
            {
                if (!used.Contains(i) && Math.Abs(json[i].Price - h.Price) < 0.02m &&
                    TextUtil.Fold(json[i].Platform) == TextUtil.Fold(h.Platform))
                {
                    idx = i;
                    break;
                }
            }
            if (idx >= 0)
            {
                used.Add(idx);
                if (h.OfferTitle is not null) result[idx] = result[idx] with { OfferTitle = h.OfferTitle };
            }
            else
            {
                result.Add(h);
            }
        }
        return result;
    }

    private static Offer MakeOffer(string? sellerName, string? offerUrl, decimal price, string? title, string productUrl, bool direct)
    {
        string platform = sellerName ?? "Bilinmiyor";
        string? merchant = null;
        var slash = platform.IndexOf('/');
        if (slash > 0)
        {
            merchant = platform[(slash + 1)..].Trim();
            platform = platform[..slash].Trim();
        }
        return new Offer
        {
            Site = DetectSite(platform, offerUrl),
            Platform = platform,
            Merchant = string.IsNullOrEmpty(merchant) ? null : merchant,
            Price = price,
            Url = offerUrl ?? productUrl,
            IsDirectLink = direct && offerUrl is not null,
            LinkKind = direct && offerUrl is not null ? LinkKind.Direct : LinkKind.Akakce,
            OfferTitle = title,
        };
    }

    public static Site DetectSite(string? platform, string? url)
    {
        var text = TextUtil.Fold(platform) + " " + (Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.Host : "");
        if (text.Contains("hepsiburada")) return Site.Hepsiburada;
        if (text.Contains("trendyol")) return Site.Trendyol;
        if (text.Contains("idefix")) return Site.Idefix;
        return Site.Akakce;
    }

    private static readonly System.Text.RegularExpressions.Regex DescriptiveTextRx = new(
        @"descriptiveText(?:&quot;|"")\s*:\s*\[0,\s*(?:&quot;|"")(?<t>.*?)(?:&quot;|"")\]",
        System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>"Seri: Samsung S, Dahili Hafıza: 256 GB, 5G, ..." -> sözlük (değersiz öğeler "Var").</summary>
    internal static Dictionary<string, string> ParseDescriptiveText(string html)
    {
        var result = new Dictionary<string, string>();
        var m = DescriptiveTextRx.Match(html);
        if (!m.Success) return result;
        var text = WebUtility.HtmlDecode(m.Groups["t"].Value).Replace("\\\"", "\"");
        foreach (var part in text.Split(", ", StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var colon = part.IndexOf(": ", StringComparison.Ordinal);
            if (colon > 0) result.TryAdd(part[..colon].Trim(), part[(colon + 2)..].Trim());
            else if (part.Length <= 40) result.TryAdd(part, "Var");
        }
        return result;
    }

    private static string? ImageUrl(JsonElement img) => img.ValueKind switch
    {
        JsonValueKind.String => img.GetString(),
        JsonValueKind.Array => img.EnumerateArray().Select(ImageUrl).FirstOrDefault(u => u is not null),
        JsonValueKind.Object => Str(img, "contentUrl") ?? Str(img, "url"),
        _ => null,
    };

    /// <summary>Akakçe ürün URL'indeki kategori bölümü, örn. "/laptop-notebook/en-ucuz-..." -> "laptop-notebook".</summary>
    public static string? CategoryFromUrl(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Segments.Length > 2 ? u.Segments[1].TrimEnd('/') : null;

    private static JsonElement? FindProduct(JsonElement el)
    {
        switch (el.ValueKind)
        {
            case JsonValueKind.Array:
                foreach (var x in el.EnumerateArray())
                    if (FindProduct(x) is { } p) return p;
                break;
            case JsonValueKind.Object:
                if (el.TryGetProperty("@type", out var t) && t.ValueKind == JsonValueKind.String && t.GetString() == "Product")
                    return el;
                if (el.TryGetProperty("@graph", out var g)) return FindProduct(g);
                break;
        }
        return null;
    }

    private static string? Str(JsonElement? el, string prop)
    {
        if (el is not { ValueKind: JsonValueKind.Object } e || !e.TryGetProperty(prop, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.String => v.GetString(),
            JsonValueKind.Number => v.GetRawText(),
            _ => null,
        };
    }

    private static string Absolute(string href) =>
        href.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? href : BaseUrl + (href.StartsWith('/') ? href : "/" + href);

    private async Task<string?> GetHtmlAsync(string url, CancellationToken ct)
    {
        if (Cache.TryGetValue(url, out var hit) && DateTimeOffset.UtcNow - hit.At < CacheTtl) return hit.Html;
        const int maxAttempts = 4;
        for (var attempt = 1; ; attempt++)
        {
            string? problem;
            var permanent = false;
            await Throttle.WaitAsync(ct);
            try
            {
                await KeepMinInterval(ct);
                using var resp = await http.GetAsync(url, ct);
                var status = (int)resp.StatusCode;
                if (status == 429)
                {
                    // Hız sınırı: tüm istekler için ortak bekleme (Retry-After'a uyulur)
                    var retryAfter = resp.Headers.RetryAfter?.Delta
                                     ?? (resp.Headers.RetryAfter?.Date is { } date ? date - DateTimeOffset.UtcNow : null);
                    StartCooldown(retryAfter);
                }
                else if (resp.IsSuccessStatusCode)
                {
                    ResetCooldown();
                }
                if (resp.IsSuccessStatusCode)
                {
                    var bytes = await resp.Content.ReadAsByteArrayAsync(ct);
                    var html = Encoding.UTF8.GetString(bytes); // Akakçe charset başlığı göndermiyor, içerik UTF-8
                    // 200 dönen ama Akakçe içeriği olmayan sayfa = geçici engel / doğrulama sayfası
                    if (html.Contains("akakce", StringComparison.OrdinalIgnoreCase) && html.Length > 5000)
                    {
                        Cache[url] = (DateTimeOffset.UtcNow, html);
                        return html;
                    }
                    problem = $"beklenmeyen içerik ({html.Length} bayt)";
                }
                else
                {
                    problem = $"HTTP {status}";
                    // 404/410 kalıcı; 403/429/5xx genelde hız sınırı ya da geçici hata
                    permanent = status is 404 or 410 or 400;
                }
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
            {
                problem = ex.Message;
            }
            finally
            {
                Throttle.Release();
            }

            if (permanent || attempt >= maxAttempts)
            {
                logger.LogWarning("Akakçe okunamadı: {Url} ({Problem}, {Attempt} deneme)", url, problem, attempt);
                return null;
            }
            logger.LogInformation("Akakçe yeniden denenecek: {Url} ({Problem})", url, problem);
            await Task.Delay(TimeSpan.FromMilliseconds(600 * attempt + Random.Shared.Next(0, 300)), ct);
        }
    }

    // Siteyi yormamak ve hız sınırına takılmamak için:
    // en fazla 2 eşzamanlı istek, istek başlangıçları arası en az 400 ms, 429 sonrası ortak bekleme.
    private static readonly SemaphoreSlim Throttle = new(2);
    private static readonly SemaphoreSlim IntervalLock = new(1);
    private static DateTimeOffset _lastRequest = DateTimeOffset.MinValue;
    private static DateTimeOffset _cooldownUntil = DateTimeOffset.MinValue;
    private static int _consecutive429;
    private static readonly TimeSpan MinInterval = TimeSpan.FromMilliseconds(400);

    /// <summary>Hız sınırı nedeniyle bekleniyorsa kalan süre.</summary>
    public static TimeSpan CooldownRemaining =>
        _cooldownUntil > DateTimeOffset.UtcNow ? _cooldownUntil - DateTimeOffset.UtcNow : TimeSpan.Zero;

    private static void StartCooldown(TimeSpan? retryAfter)
    {
        var n = Interlocked.Increment(ref _consecutive429);
        // Retry-After yoksa 3 sn, 6 sn, 12 sn... (en fazla 30 sn)
        var backoff = retryAfter is { } ra && ra > TimeSpan.Zero
            ? ra
            : TimeSpan.FromSeconds(Math.Min(30, 3 * Math.Pow(2, Math.Min(n - 1, 4))));
        var until = DateTimeOffset.UtcNow + backoff;
        lock (CooldownGate) { if (until > _cooldownUntil) _cooldownUntil = until; }
    }

    private static readonly object CooldownGate = new();

    private static void ResetCooldown() => Interlocked.Exchange(ref _consecutive429, 0);

    private static async Task KeepMinInterval(CancellationToken ct)
    {
        await IntervalLock.WaitAsync(ct);
        try
        {
            var now = DateTimeOffset.UtcNow;
            var next = _lastRequest + MinInterval;
            if (_cooldownUntil > next) next = _cooldownUntil;
            if (next > now) await Task.Delay(next - now, ct);
            _lastRequest = DateTimeOffset.UtcNow;
        }
        finally { IntervalLock.Release(); }
    }
}
