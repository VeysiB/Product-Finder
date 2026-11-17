using Microsoft.Extensions.Logging;

namespace ProductSearch.Core;

/// <summary>
/// Ürün arar, filtreler ve Hepsiburada / Trendyol / Idefix / Akakçe tekliflerini linkleriyle döndürür.
/// </summary>
public sealed class ProductSearchService(AkakceClient akakce, ILogger<ProductSearchService> logger)
{
    private const int MaxSearches = 6;
    private const int InspectHardCap = 40;
    /// <summary>Bir aramanın ürün sayfası okumaya harcayabileceği en uzun süre (kullanıcıyı uzun bekletmemek için).</summary>
    private static readonly TimeSpan InspectBudget = TimeSpan.FromSeconds(50);

    public async Task<SearchResponse> SearchAsync(SearchRequest request, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.Query))
            throw new ArgumentException("Ürün adı (query) boş olamaz.");

        var req = Normalize(request);
        var sites = req.Sites.Count == 0 ? Enum.GetValues<Site>().ToHashSet() : req.Sites.ToHashSet();
        var warnings = new List<string>();

        // 1) Akakçe aramaları: marka başına + seçilen işletim sistemi anahtar kelimesiyle
        var started = DateTimeOffset.UtcNow;
        var plan = BuildSearchTexts(req);
        var searchTexts = plan.Select(p => p.Text).ToList();
        var searches = await Task.WhenAll(plan.Select(p => akakce.SearchAsync(p.Text, p.Pages, ct)));
        var candidates = Interleave(searches.Select(s => s.Items).ToList()).DistinctBy(c => c.Id).ToList();

        // "metin + windows" gibi ek aramalar adında "Windows" geçen aksesuarları (klavye, dongle, yazılım) da getirir.
        // Ek aramadan gelen ürünler yalnızca ana aramanın kategorilerindeyse ya da aramayla yeterince örtüşüyorsa kalır.
        if (plan.Any(p => p.IsExtra))
        {
            var baseItems = plan.Select((p, i) => (p, i)).Where(x => !x.p.IsExtra)
                .SelectMany(x => searches[x.i].Items).ToList();
            var baseIds = baseItems.Select(c => c.Id).ToHashSet();
            var baseCategories = baseItems.Where(c => c.Category is not null)
                .GroupBy(c => c.Category!).Where(g => g.Count() >= 2 || baseItems.Count < 10)
                .Select(g => g.Key).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var text = BuildSearchText(req);
            candidates = candidates.Where(c =>
                baseIds.Contains(c.Id) ||
                (c.Category is not null ? baseCategories.Contains(c.Category) : TextUtil.RelevanceScore(c.Name, text) >= 0.5)
            ).ToList();
        }
        var failedSearches = searches.Count(s => s.Failed);
        logger.LogInformation("{Searches} için {Count} aday ürün bulundu", string.Join(" | ", searchTexts), candidates.Count);

        if (failedSearches == searches.Length)
            warnings.Add("Akakçe şu anda yanıt vermiyor ya da isteği geçici olarak reddetti. Birkaç saniye sonra tekrar deneyin.");
        else if (failedSearches > 0)
            warnings.Add($"{searches.Length} aramadan {failedSearches} tanesi okunamadı; sonuçlar eksik olabilir.");
        else if (candidates.Count == 0)
            warnings.Add($"Akakçe'de '{BuildSearchText(req)}' için ürün bulunamadı.");

        // 2) Liste bilgisiyle ön filtre + alaka sırası
        var prefiltered = candidates
            .Where(c => PreFilter(c, req))
            .Select((c, i) => (c, i, score: TextUtil.RelevanceScore(c.Name, BuildSearchText(req))))
            .OrderByDescending(x => x.score).ThenBy(x => x.i)
            .Select(x => x.c)
            .ToList();
        if (req.ExcludeAccessories)
        {
            var nonAccessory = prefiltered.Where(c => !TextUtil.LooksLikeAccessory(c.Name, req.Query + " " + req.Model)).ToList();
            if (nonAccessory.Count > 0) prefiltered = nonAccessory;
        }

        // 3) Kademeli inceleme: hedef sonuç sayısına ulaşana ya da sınıra kadar ürün sayfalarını oku
        var cap = Math.Min(prefiltered.Count, Math.Min(InspectHardCap, Math.Max(req.MaxProducts * 2, 20)));
        var results = new List<ProductResult>();
        var inspectedDetails = new List<ProductDetail>();
        var inspectedOs = new List<string?>();
        var inspected = 0;
        var failed = 0;
        var outOfTime = false;

        while (inspected < cap && results.Count < req.MaxProducts)
        {
            if (DateTimeOffset.UtcNow - started > InspectBudget) { outOfTime = true; break; }
            // İlk tur hedef kadar; sonraki turlar yalnızca eksik sonuç sayısı kadar (istek sayısını düşük tutar)
            var size = inspected == 0 ? req.MaxProducts : Math.Max(4, (req.MaxProducts - results.Count) * 2);
            var batch = prefiltered.Skip(inspected).Take(Math.Min(size, cap - inspected)).ToList();
            inspected += batch.Count;

            var fetched = await Task.WhenAll(batch.Select(async c =>
            {
                if (!c.HasDetailPage) return (Summary: c, Detail: (ProductDetail?)null, Failed: false);
                try
                {
                    var d = await akakce.GetProductAsync(c.Url!, ct);
                    return (Summary: c, Detail: d, Failed: d is null);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogWarning(ex, "Ürün detayı alınamadı: {Url}", c.Url);
                    return (Summary: c, Detail: (ProductDetail?)null, Failed: true);
                }
            }));

            foreach (var (summary, detail, isFailed) in fetched)
            {
                if (isFailed) { failed++; continue; }
                var result = detail is null ? FromSingleSeller(summary) : FromDetail(summary, detail);
                if (detail is not null) inspectedDetails.Add(detail);
                inspectedOs.Add(result.OperatingSystem);

                var filtered = ApplyFilters(result, req, sites);
                if (filtered is not null) results.Add(filtered);
            }
        }

        if (failed > 0)
            warnings.Add($"{failed} ürünün sayfası okunamadı (Akakçe hız sınırı / geçici hata). Biraz sonra tekrar aramak eksikleri tamamlar.");
        if (outOfTime)
            warnings.Add("Süre sınırı nedeniyle inceleme erken bitirildi; filtreleri daraltmak daha hızlı ve isabetli sonuç verir.");
        if (results.Count < req.MaxProducts && inspected < prefiltered.Count)
            warnings.Add($"{prefiltered.Count} uygun adayın {inspected} tanesi incelendi. Daha fazla sonuç için filtreleri daraltın.");
        if (req.OperatingSystems.Count > 0 && results.Count == 0 && inspected > 0)
            warnings.Add("Seçilen işletim sistemine sahip ürün bulunamadı. İncelenen ürünlerin işletim sistemleri: " +
                         string.Join(", ", inspectedOs.Select(o => o ?? "bilinmiyor").GroupBy(o => o)
                             .Select(g => $"{g.Key} ({g.Count()})")));

        results = req.Sort switch
        {
            SortOrder.PriceAsc => results.OrderBy(r => r.BestPrice).ToList(),
            SortOrder.PriceDesc => results.OrderByDescending(r => r.BestPrice).ToList(),
            _ => results
                .Select((r, i) => (r, i, s: Math.Round(TextUtil.RelevanceScore(r.Name, BuildSearchText(req)), 2)))
                .OrderByDescending(x => x.s).ThenBy(x => x.r.BestPrice).ThenBy(x => x.i)
                .Select(x => x.r).ToList(),
        };

        return new SearchResponse
        {
            Request = req,
            CandidateCount = candidates.Count,
            MatchingCandidateCount = prefiltered.Count,
            InspectedCount = inspected,
            FailedCount = failed,
            Results = results,
            Facets = BuildFacets(candidates, inspectedDetails, inspectedOs),
            Sites = SiteLinks.Statuses(req),
            Warnings = warnings,
        };
    }

    /// <summary>Bir sorgu için kullanılabilecek filtre seçeneklerini (marka, işletim sistemi, özellikler) döndürür.</summary>
    public async Task<Facets> GetFilterOptionsAsync(string query, int inspect = 12, CancellationToken ct = default)
    {
        var res = await SearchAsync(new SearchRequest { Query = query, MaxProducts = inspect, SearchPages = 2 }, ct);
        return res.Facets;
    }

    public Task<ProductDetail?> GetProductAsync(string akakceUrl, CancellationToken ct = default) =>
        akakce.GetProductAsync(akakceUrl, ct);

    private static SearchRequest Normalize(SearchRequest r) => r with
    {
        Query = r.Query.Trim(),
        MaxProducts = Math.Clamp(r.MaxProducts, 1, 40),
        SearchPages = Math.Clamp(r.SearchPages, 1, 5),
        OperatingSystems = r.OperatingSystems
            .Select(o => OperatingSystemDetector.Normalize(o) ?? TextUtil.Fold(o))
            .Where(o => o.Length > 0).Distinct().ToList(),
        Brands = r.Brands.Where(b => !string.IsNullOrWhiteSpace(b)).Select(b => b.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase).ToList(),
        Specs = r.Specs.Where(kv => !string.IsNullOrWhiteSpace(kv.Key) && !string.IsNullOrWhiteSpace(kv.Value))
            .ToDictionary(kv => kv.Key.Trim(), kv => kv.Value.Trim()),
    };

    internal static string BuildSearchText(SearchRequest req)
    {
        var parts = new List<string> { req.Query.Trim() };
        if (req.Brands.Count == 1 && !TextUtil.ContainsAllTokens(req.Query, req.Brands[0])) parts.Insert(0, req.Brands[0]);
        if (!string.IsNullOrWhiteSpace(req.Model) && !TextUtil.ContainsAllTokens(req.Query, req.Model)) parts.Add(req.Model.Trim());
        return string.Join(' ', parts);
    }

    /// <summary>
    /// Arama metinleri: her marka için ayrı arama; işletim sistemi seçildiyse adında o sistemi geçen ürünleri
    /// yakalamak için ek olarak "metin + windows" gibi aramalar. Önce ek aramalar gelir (daha isabetli).
    /// </summary>
    private static List<(string Text, int Pages, bool IsExtra)> BuildSearchTexts(SearchRequest req)
    {
        var bases = req.Brands.Count > 1
            ? req.Brands.Select(b => BuildSearchText(req with { Brands = [b] })).ToList()
            : [BuildSearchText(req)];

        var plan = new List<(string Text, int Pages, bool IsExtra)>();
        foreach (var os in req.OperatingSystems)
        {
            var kw = OperatingSystemDetector.SearchKeyword(os);
            if (kw is null) continue;
            plan.AddRange(bases.Where(b => !TextUtil.ContainsAllTokens(b, kw)).Select(b => ($"{b} {kw}", 1, true)));
        }
        // Çok aramada sayfa sayısını azalt (istek sayısını makul tut)
        var basePages = bases.Count > 2 ? 1 : req.SearchPages;
        plan.AddRange(bases.Select(b => (b, basePages, false)));
        // Ana aramalar her zaman yapılır; ek aramalar kalan kotaya sığdığı kadar
        var baseCount = plan.Count(p => !p.IsExtra);
        var extras = plan.Where(p => p.IsExtra).Take(Math.Max(0, MaxSearches - baseCount));
        return extras.Concat(plan.Where(p => !p.IsExtra))
            .DistinctBy(p => p.Text, StringComparer.OrdinalIgnoreCase).ToList();
    }

    private static IEnumerable<T> Interleave<T>(IReadOnlyList<List<T>> lists)
    {
        var max = lists.Count == 0 ? 0 : lists.Max(l => l.Count);
        for (var i = 0; i < max; i++)
            foreach (var l in lists)
                if (i < l.Count) yield return l[i];
    }

    private static bool PreFilter(ProductSummary c, SearchRequest req)
    {
        if (!string.IsNullOrWhiteSpace(req.Category) && c.HasDetailPage &&
            !string.Equals(c.Category, req.Category.Trim(), StringComparison.OrdinalIgnoreCase))
            return false;
        if (req.Brands.Count > 0 && !req.Brands.Any(b =>
                TextUtil.Fold(c.Brand) == TextUtil.Fold(b) || TextUtil.ContainsAllTokens(c.Name, b)))
            return false;
        if (!TextUtil.ContainsAllTokens(c.Name, req.Model)) return false;
        // En düşük fiyat bile üst sınırın üzerindeyse hiçbir teklif uymaz
        if (req.MaxPrice is not null && c.LowestPrice is not null && c.LowestPrice > req.MaxPrice) return false;
        // Tek satıcılı üründe fiyat kesin; çok satıcılıda en düşük fiyat alt sınırın çok altındaysa (genelde aksesuar) ele
        if (req.MinPrice is > 0 && c.LowestPrice is not null &&
            c.LowestPrice < (c.OfferCount == 1 ? req.MinPrice : req.MinPrice / 2))
            return false;
        if (req.OperatingSystems.Count > 0)
        {
            // Adında açıkça başka bir işletim sistemi yazıyorsa (ör. "FreeDOS") sayfasını okumaya gerek yok
            var os = OperatingSystemDetector.FromName(c.Name);
            if (os is not null && !req.OperatingSystems.Contains(os)) return false;
        }
        return true;
    }

    private static ProductResult FromDetail(ProductSummary summary, ProductDetail detail)
    {
        var name = detail.Name.Length > 0 ? detail.Name : summary.Name;
        return new ProductResult
        {
            Name = name,
            Brand = detail.Brand ?? summary.Brand,
            OperatingSystem = OperatingSystemDetector.Detect(detail.Specs, name, detail.Offers.Select(o => o.OfferTitle)),
            Category = summary.Category,
            ImageUrl = detail.ImageUrl ?? summary.ImageUrl,
            AkakceUrl = detail.Url,
            BestPrice = detail.Offers.Count > 0 ? detail.Offers.Min(o => o.Price) : summary.LowestPrice,
            Specs = detail.Specs,
            Offers = detail.Offers,
        };
    }

    /// <summary>Akakçe'de sayfası olmayan tek satıcılı ürün: satıcı görselden, link sitede ürün adıyla arama.</summary>
    private static ProductResult FromSingleSeller(ProductSummary s)
    {
        var site = s.SellerSite ?? Site.Akakce;
        var offers = s.LowestPrice is null
            ? new List<Offer>()
            : [new Offer
            {
                Site = site,
                Platform = site == Site.Akakce ? "Akakçe" : site.ToString(),
                Price = s.LowestPrice.Value,
                Url = SiteLinks.ProductSearchUrl(site, s.Name),
                IsDirectLink = false,
                LinkKind = site == Site.Akakce ? LinkKind.Akakce : LinkKind.SiteSearch,
                OfferTitle = s.Name,
            }];
        return new ProductResult
        {
            Name = s.Name,
            Brand = s.Brand,
            OperatingSystem = OperatingSystemDetector.FromName(s.Name),
            ImageUrl = s.ImageUrl,
            AkakceUrl = AkakceClient.SearchUrl(s.Name),
            BestPrice = s.LowestPrice,
            Offers = offers,
        };
    }

    /// <summary>İşletim sistemi, özellik, site ve fiyat filtrelerini uygular. Uymuyorsa null.</summary>
    private static ProductResult? ApplyFilters(ProductResult r, SearchRequest req, HashSet<Site> sites)
    {
        if (req.OperatingSystems.Count > 0 && (r.OperatingSystem is null || !req.OperatingSystems.Contains(r.OperatingSystem)))
            return null;
        if (!SpecsMatch(r, req.Specs)) return null;

        var offers = r.Offers
            .Where(o => sites.Contains(o.Site))
            .Where(o => req.MinPrice is null || o.Price >= req.MinPrice)
            .Where(o => req.MaxPrice is null || o.Price <= req.MaxPrice)
            .OrderBy(o => o.Price)
            .ToList();
        if (offers.Count == 0) return null;
        return r with { Offers = offers, BestPrice = offers[0].Price };
    }

    /// <summary>Özellik filtresi: önce ürün özelliklerinde, yoksa ürün adı ve satıcı başlıklarında aranır.</summary>
    private static bool SpecsMatch(ProductResult r, Dictionary<string, string> wanted)
    {
        if (wanted.Count == 0) return true;
        string? freeText = null;
        foreach (var (key, value) in wanted)
        {
            var want = Compact(value);
            var fk = TextUtil.Fold(key);
            var match = r.Specs.FirstOrDefault(s => TextUtil.Fold(s.Key) == fk);
            if (match.Key is null) match = r.Specs.FirstOrDefault(s => TextUtil.Fold(s.Key).Contains(fk));
            if (match.Key is not null)
            {
                if (!Compact(match.Value).Contains(want)) return false;
                continue;
            }
            freeText ??= Compact(r.Name + " " + string.Join(" ", r.Offers.Select(o => o.OfferTitle)));
            if (!freeText.Contains(want)) return false;
        }
        return true;

        static string Compact(string? s) => TextUtil.Fold(s).Replace(" ", "");
    }

    private static readonly string[] PreferredSpecKeys =
    [
        "RAM", "RAM Kapasitesi", "SSD", "Dahili Hafıza", "Ekran Boyutu", "Çıkış Yılı", "İşlemci Serisi", "İşlemci Modeli",
        "Ekran Kartı Modeli", "Ekran Kartı Tipi", "Ekran Çözünürlüğü", "Panel Tipi", "Ekran Yenileme Hızı",
        "Kamera Çözünürlüğü", "Batarya Kapasitesi", "Renk", "Seri", "Kapasite", "Bağlantı", "Tipi"
    ];

    private static Facets BuildFacets(List<ProductSummary> candidates, List<ProductDetail> details, List<string?> osValues)
    {
        static List<FacetValue> Count(IEnumerable<string?> values) => values
            .Where(v => !string.IsNullOrWhiteSpace(v))
            .GroupBy(v => v!.Trim(), StringComparer.OrdinalIgnoreCase)
            .Select(g => new FacetValue(g.Key, g.Count()))
            .OrderByDescending(f => f.Count).ThenBy(f => f.Value)
            .ToList();

        var specFacets = new Dictionary<string, List<FacetValue>>();
        if (details.Count > 0)
        {
            var keyCounts = details.SelectMany(d => d.Specs.Keys).GroupBy(k => k).ToDictionary(g => g.Key, g => g.Count());
            var keys = PreferredSpecKeys.Where(keyCounts.ContainsKey)
                .Concat(keyCounts.Where(k => k.Value >= Math.Max(2, details.Count / 3)).Select(k => k.Key))
                .Where(k => !k.Contains("İşletim", StringComparison.OrdinalIgnoreCase))
                .Distinct().ToList();
            foreach (var key in keys)
            {
                var values = Count(details.Select(d => d.Specs.GetValueOrDefault(key)));
                if (values.Count is >= 2 and <= 20) specFacets[key] = values;
                if (specFacets.Count >= 8) break;
            }
        }

        var prices = details.SelectMany(d => d.Offers.Select(o => o.Price))
            .Concat(candidates.Where(c => !c.HasDetailPage && c.LowestPrice is not null).Select(c => c.LowestPrice!.Value))
            .ToList();
        return new Facets
        {
            Categories = Count(candidates.Select(c => c.Category)),
            Brands = Count(candidates.Select(c => c.Brand)),
            OperatingSystems = Count(osValues),
            Specs = specFacets,
            MinPrice = prices.Count > 0 ? prices.Min() : null,
            MaxPrice = prices.Count > 0 ? prices.Max() : null,
        };
    }
}
