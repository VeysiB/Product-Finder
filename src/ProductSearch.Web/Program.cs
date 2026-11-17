using System.Text.Json.Serialization;
using ProductSearch.Core;
using ProductSearch.Web.Ozdisan;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProductSearch();
builder.Services.AddOzdisan(builder.Configuration);
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
    o.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
});

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

var api = app.MapGroup("/api");

// Ürün ara + filtrele
api.MapPost("/search", async (SearchRequest request, ProductSearchService service, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(request.Query))
        return Results.BadRequest(new { error = "Ürün adı boş olamaz." });
    return Results.Ok(await service.SearchAsync(request, ct));
});

// Bir sorgu için filtre seçenekleri (kategori, marka, işletim sistemi, özellikler)
api.MapGet("/filters", async (string q, ProductSearchService service, CancellationToken ct) =>
    string.IsNullOrWhiteSpace(q)
        ? Results.BadRequest(new { error = "q parametresi gerekli." })
        : Results.Ok(await service.GetFilterOptionsAsync(q, 12, ct)));

// Akakçe ürün sayfasındaki tüm teklifler
api.MapGet("/product", async (string url, ProductSearchService service, CancellationToken ct) =>
{
    try
    {
        var detail = await service.GetProductAsync(url, ct);
        return detail is null ? Results.NotFound() : Results.Ok(detail);
    }
    catch (ArgumentException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

// Desteklenen işletim sistemleri
api.MapGet("/os", () => OperatingSystemDetector.DisplayNames.Select(kv => new { value = kv.Key, label = kv.Value }));

// Özdisan Elektronik bölümü
app.MapOzdisan();

app.Run();
