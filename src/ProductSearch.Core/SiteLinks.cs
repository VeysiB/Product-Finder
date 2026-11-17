using System.Globalization;

namespace ProductSearch.Core;

/// <summary>Her site için kullanıcının açabileceği arama linklerini üretir.</summary>
public static class SiteLinks
{
    public static string SearchUrl(Site site, SearchRequest req)
    {
        var q = Uri.EscapeDataString(ProductSearchService.BuildSearchText(req));
        var min = req.MinPrice?.ToString("0", CultureInfo.InvariantCulture);
        var max = req.MaxPrice?.ToString("0", CultureInfo.InvariantCulture);
        var hasRange = min is not null || max is not null;
        return site switch
        {
            Site.Hepsiburada => $"https://www.hepsiburada.com/ara?q={q}" +
                                (hasRange ? $"&filtreler=fiyat:{min ?? "0"}-{max ?? "9999999"}" : ""),
            Site.Trendyol => $"https://www.trendyol.com/sr?q={q}" +
                             (hasRange ? $"&prc={min ?? "0"}-{max ?? "*"}" : ""),
            Site.Idefix => $"https://www.idefix.com/arama?q={q}",
            Site.Akakce => AkakceClient.SearchUrl(ProductSearchService.BuildSearchText(req)),
            _ => throw new ArgumentOutOfRangeException(nameof(site)),
        };
    }

    /// <summary>Belirli bir ürünün tam adıyla sitede arama linki (Akakçe'nin satıcı linki vermediği ürünler için).</summary>
    public static string ProductSearchUrl(Site site, string productName)
    {
        var q = Uri.EscapeDataString(productName.Trim());
        return site switch
        {
            Site.Hepsiburada => $"https://www.hepsiburada.com/ara?q={q}",
            Site.Trendyol => $"https://www.trendyol.com/sr?q={q}",
            Site.Idefix => $"https://www.idefix.com/arama?q={q}",
            _ => AkakceClient.SearchUrl(productName.Trim()),
        };
    }

    public static List<SiteStatus> Statuses(SearchRequest req) =>
    [
        new(Site.Hepsiburada, "Teklifler Akakçe üzerinden alınır (site otomatik erişimi engelliyor)", SearchUrl(Site.Hepsiburada, req)),
        new(Site.Trendyol, "Teklifler Akakçe üzerinden alınır (site otomatik erişimi engelliyor)", SearchUrl(Site.Trendyol, req)),
        new(Site.Idefix, "Teklifler Akakçe üzerinden alınır (site otomatik erişimi engelliyor)", SearchUrl(Site.Idefix, req)),
        new(Site.Akakce, "Doğrudan", SearchUrl(Site.Akakce, req)),
    ];
}
