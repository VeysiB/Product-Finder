using System.Text.Json.Serialization;

namespace ProductSearch.Core;

/// <summary>Desteklenen siteler.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<Site>))]
public enum Site
{
    Hepsiburada,
    Trendyol,
    Idefix,
    /// <summary>Akakçe üzerindeki diğer satıcılar (n11, Amazon, mağazalar...).</summary>
    Akakce
}

[JsonConverter(typeof(JsonStringEnumConverter<SortOrder>))]
public enum SortOrder
{
    PriceAsc,
    PriceDesc,
    Relevance
}

/// <summary>Arama isteği ve filtreler.</summary>
public sealed record SearchRequest
{
    /// <summary>Ürün adı / arama metni (örn. "laptop", "iphone 15").</summary>
    public string Query { get; init; } = "";

    /// <summary>Akakçe kategori filtresi, örn. "laptop-notebook" (aksesuarları elemek için). Boşsa hepsi.</summary>
    public string? Category { get; init; }

    /// <summary>Marka filtresi (birden fazla olabilir, örn. ["Lenovo","Asus"]).</summary>
    public List<string> Brands { get; init; } = [];

    /// <summary>Model filtresi; tüm kelimeler ürün adında geçmeli (örn. "ideapad slim 3").</summary>
    public string? Model { get; init; }

    /// <summary>İşletim sistemi filtresi: windows, macos, freedos, linux, chromeos, android, ios, harmonyos.</summary>
    public List<string> OperatingSystems { get; init; } = [];

    public decimal? MinPrice { get; init; }
    public decimal? MaxPrice { get; init; }

    /// <summary>Hangi sitelerin teklifleri gösterilsin. Boşsa hepsi.</summary>
    public List<Site> Sites { get; init; } = [];

    /// <summary>Özellik filtreleri, örn. {"RAM":"16 GB","SSD":"512 GB"}. Değer içerme ile eşleşir.</summary>
    public Dictionary<string, string> Specs { get; init; } = [];

    /// <summary>Relevance: önce aramaya en çok uyanlar (aynı alakada ucuz olan önce).</summary>
    public SortOrder Sort { get; init; } = SortOrder.Relevance;

    /// <summary>Kılıf, ekran koruyucu, "… ile uyumlu" gibi aksesuarları ele (aramada aksesuar kelimesi yoksa).</summary>
    public bool ExcludeAccessories { get; init; } = true;

    /// <summary>Hedef sonuç sayısı (1-40). Filtreler sonuçları azaltırsa daha fazla aday kademeli olarak incelenir.</summary>
    public int MaxProducts { get; init; } = 15;

    /// <summary>Taranacak arama sonuç sayfası sayısı. 1-5.</summary>
    public int SearchPages { get; init; } = 2;
}

/// <summary>Teklif linkinin türü.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<LinkKind>))]
public enum LinkKind
{
    /// <summary>Doğrudan satıcı sitesindeki ürün sayfası.</summary>
    Direct,
    /// <summary>Akakçe ürün sayfası (satıcı linki Akakçe'de JavaScript ile açılıyor).</summary>
    Akakce,
    /// <summary>Satıcı sitesinde ürünün tam adıyla arama.</summary>
    SiteSearch,
}

/// <summary>Bir satıcının bir ürün için teklifi.</summary>
public sealed record Offer
{
    public LinkKind LinkKind { get; init; } = LinkKind.Direct;
    public required Site Site { get; init; }
    /// <summary>Platform adı (Hepsiburada, Trendyol, idefix, n11, Amazon Türkiye ...).</summary>
    public required string Platform { get; init; }
    /// <summary>Platform içindeki mağaza adı (varsa).</summary>
    public string? Merchant { get; init; }
    public required decimal Price { get; init; }
    public string Currency { get; init; } = "TRY";
    /// <summary>Ürün linki. Doğrudan satıcı linki bilinmiyorsa Akakçe ürün sayfası.</summary>
    public required string Url { get; init; }
    /// <summary>true ise Url doğrudan satıcı sitesindeki ürün sayfasıdır.</summary>
    public bool IsDirectLink { get; init; }
    public string? OfferTitle { get; init; }
}

/// <summary>Akakçe arama listesinden gelen ürün özeti.</summary>
public sealed record ProductSummary
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public string? Brand { get; init; }
    public decimal? LowestPrice { get; init; }
    public int? OfferCount { get; init; }
    /// <summary>Akakçe ürün sayfası. Tek satıcılı ürünlerde Akakçe sayfa vermez, null olur.</summary>
    public string? Url { get; init; }
    public string? ImageUrl { get; init; }
    /// <summary>Tek satıcılı ürünlerde satıcı sitesi (görsel adresinden çıkarılır).</summary>
    public Site? SellerSite { get; init; }
    public bool HasDetailPage => Url is not null;
    /// <summary>Akakçe kategori kodu, örn. "laptop-notebook", "cep-telefonu".</summary>
    public string? Category => Url is null ? null : AkakceClient.CategoryFromUrl(Url);
}

/// <summary>Ürün detayı: özellikler + satıcı teklifleri.</summary>
public sealed record ProductDetail
{
    public required string Url { get; init; }
    public required string Name { get; init; }
    public string? Brand { get; init; }
    public string? ImageUrl { get; init; }
    public decimal? LowPrice { get; init; }
    public decimal? HighPrice { get; init; }
    public int? OfferCount { get; init; }
    public Dictionary<string, string> Specs { get; init; } = [];
    public List<Offer> Offers { get; init; } = [];
}

/// <summary>Filtrelenmiş sonuç: bir ürün ve filtreye uyan teklifleri.</summary>
public sealed record ProductResult
{
    public required string Name { get; init; }
    public string? Brand { get; init; }
    public string? OperatingSystem { get; init; }
    public string? Category { get; init; }
    public string? ImageUrl { get; init; }
    /// <summary>Akakçe ürün sayfası; tek satıcılı ürünlerde Akakçe arama sayfası.</summary>
    public required string AkakceUrl { get; init; }
    public decimal? BestPrice { get; init; }
    public Dictionary<string, string> Specs { get; init; } = [];
    public List<Offer> Offers { get; init; } = [];
}

public sealed record SiteStatus(Site Site, string Status, string SearchUrl);

public sealed record Facets
{
    public List<FacetValue> Categories { get; init; } = [];
    public List<FacetValue> Brands { get; init; } = [];
    public List<FacetValue> OperatingSystems { get; init; } = [];
    public Dictionary<string, List<FacetValue>> Specs { get; init; } = [];
    public decimal? MinPrice { get; init; }
    public decimal? MaxPrice { get; init; }
}

public sealed record FacetValue(string Value, int Count);

public sealed record SearchResponse
{
    public required SearchRequest Request { get; init; }
    public int CandidateCount { get; init; }
    /// <summary>Ön filtreden geçen aday sayısı.</summary>
    public int MatchingCandidateCount { get; init; }
    public int InspectedCount { get; init; }
    /// <summary>Sayfası okunamayan ürün sayısı (site geçici olarak yanıt vermediyse).</summary>
    public int FailedCount { get; init; }
    public List<ProductResult> Results { get; init; } = [];
    public Facets Facets { get; init; } = new();
    public List<SiteStatus> Sites { get; init; } = [];
    public List<string> Warnings { get; init; } = [];
}
