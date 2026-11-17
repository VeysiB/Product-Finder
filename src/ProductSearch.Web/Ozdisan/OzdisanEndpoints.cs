using System.Text.Json;

namespace ProductSearch.Web.Ozdisan;

public static class OzdisanEndpoints
{
    public static IServiceCollection AddOzdisan(this IServiceCollection services, IConfiguration config)
    {
        services.AddOptions<OzdisanOptions>()
            .Bind(config.GetSection("Ozdisan"))
            .PostConfigure<IHostEnvironment>((o, env) =>
                o.ServerScript = OzdisanOptions.ResolveScript(o.ServerScript, env.ContentRootPath, AppContext.BaseDirectory));
        services.AddSingleton<OzdisanService>();
        return services;
    }

    public static void MapOzdisan(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api/ozdisan");

        // Bağlantı durumu
        api.MapGet("/status", async (OzdisanService svc, CancellationToken ct) =>
        {
            try
            {
                var version = await svc.EnsureStartedAsync(ct);
                return Results.Ok(new
                {
                    available = true,
                    version,
                    currency = svc.Options.Currency,
                    language = svc.Options.Language,
                    downloadDir = svc.Options.ResolvedDownloadDir,
                });
            }
            catch (OzdisanUnavailableException ex)
            {
                return Results.Ok(new { available = false, error = ex.Message });
            }
        });

        // Bir Özdisan işlemini çalıştırır: gövde = işlemin parametreleri (JSON nesnesi)
        api.MapPost("/{operation}", async (string operation, JsonElement body, OzdisanService svc, CancellationToken ct) =>
        {
            if (!OzdisanService.Operations.Contains(operation))
                return Results.NotFound(new { isError = true, data = new { error = $"Bilinmeyen işlem: {operation}" } });
            if (body.ValueKind is not (JsonValueKind.Object or JsonValueKind.Undefined or JsonValueKind.Null))
                return Results.BadRequest(new { isError = true, data = new { error = "Gövde bir JSON nesnesi olmalı." } });

            var args = new Dictionary<string, object?>();
            if (body.ValueKind == JsonValueKind.Object)
            {
                foreach (var p in body.EnumerateObject())
                {
                    if (p.Value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) continue;
                    if (p.Value.ValueKind == JsonValueKind.String && p.Value.GetString()!.Trim().Length == 0) continue;
                    // Tarayıcıdan gelen istekler diske yalnızca yapılandırılmış indirme klasörüne yazabilir.
                    if (operation == "download_datasheet" && p.Name == "directory") continue;
                    args[p.Name] = p.Value;
                }
            }

            try
            {
                var result = await svc.CallAsync(operation, args, ct);
                return Results.Ok(new { isError = result.IsError, data = result.Data });
            }
            catch (OzdisanUnavailableException ex)
            {
                return Results.Json(new { isError = true, data = new { error = ex.Message } }, statusCode: 503);
            }
        });

        // Datasheet'i indirir (İndirilenler\ozdisan-datasheets) ve tarayıcıya PDF olarak gönderir.
        api.MapGet("/datasheet", async (string product, bool? overwrite, bool? inline, OzdisanService svc, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(product)) return Results.BadRequest(new { error = "product gerekli." });
            OzdisanToolResult result;
            try
            {
                var args = new Dictionary<string, object?> { ["product"] = product.Trim() };
                if (overwrite == true) args["overwrite"] = true;
                result = await svc.CallAsync("download_datasheet", args, ct);
            }
            catch (OzdisanUnavailableException ex)
            {
                return Results.Json(new { error = ex.Message }, statusCode: 503);
            }
            if (result.IsError) return Results.Json(result.Data, statusCode: 404);

            var path = result.Data.TryGetProperty("file_path", out var fp) ? fp.GetString() : null;
            if (path is null || !File.Exists(path)) return Results.Json(new { error = "İndirilen dosya bulunamadı." }, statusCode: 500);

            // Yalnızca yapılandırılmış indirme klasöründeki dosyalar gönderilir.
            var root = Path.GetFullPath(svc.Options.ResolvedDownloadDir).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            var full = Path.GetFullPath(path);
            if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                return Results.Json(new { error = "Dosya indirme klasörünün dışında." }, statusCode: 403);

            var fileName = Path.GetFileName(full);
            var contentType = fileName.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase) ? "application/pdf" : "application/octet-stream";
            return inline == true
                ? Results.File(full, contentType, enableRangeProcessing: true)
                : Results.File(full, contentType, fileName, enableRangeProcessing: true);
        });
    }
}
