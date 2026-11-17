using System.Text.Json;
using Microsoft.Extensions.Options;
using ModelContextProtocol;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;

namespace ProductSearch.Web.Ozdisan;

/// <summary>Bir Özdisan işleminin sonucu: bileşenin döndürdüğü JSON aynen aktarılır.</summary>
public sealed record OzdisanToolResult(bool IsError, JsonElement Data);

/// <summary>
/// tools/ozdisan bileşenini (Node.js) alt süreç olarak başlatır ve stdio üzerinden bağlanır.
/// Web arayüzündeki tüm Özdisan işlemleri (arama, filtreleme, karşılaştırma, BOM, datasheet) bu bileşenin
/// işlemleri çağrılarak yapılır. Süreç ilk kullanımda başlatılır, çökerse bir sonraki çağrıda yeniden başlatılır.
/// </summary>
public sealed class OzdisanService(IOptions<OzdisanOptions> options, ILoggerFactory loggerFactory) : IAsyncDisposable
{
    /// <summary>Web arayüzünün çağırabileceği işlemler.</summary>
    public static readonly IReadOnlySet<string> Operations = new HashSet<string>(StringComparer.Ordinal)
    {
        "search_products", "filter_products", "get_product", "get_alternatives", "compare_products", "check_bom",
        "search_categories", "browse_categories", "get_category_filters", "download_datasheet", "read_datasheet",
    };

    private readonly OzdisanOptions _options = options.Value;
    private readonly ILogger _logger = loggerFactory.CreateLogger<OzdisanService>();
    private readonly SemaphoreSlim _connectLock = new(1, 1);
    private McpClient? _client;

    public OzdisanOptions Options => _options;

    /// <summary>Bileşenin çalıştığını doğrular (gerekirse başlatır) ve sürümünü döndürür.</summary>
    public async Task<string?> EnsureStartedAsync(CancellationToken ct) => (await GetClientAsync(ct)).ServerInfo?.Version;

    private async Task<McpClient> GetClientAsync(CancellationToken ct)
    {
        if (_client is { } existing) return existing;
        await _connectLock.WaitAsync(ct);
        try
        {
            if (_client is { } again) return again;
            if (!File.Exists(_options.ServerScript))
                throw new OzdisanUnavailableException(
                    "Özdisan bileşeni hazır değil. Node.js 22+ kurulu olduğundan emin olup projeyi yeniden derleyin (dotnet build); " +
                    $"derleme tools/ozdisan klasörünü otomatik hazırlar. Aranan dosya: {_options.ServerScript}");

            var transport = new StdioClientTransport(new StdioClientTransportOptions
            {
                Name = "ozdisan",
                Command = _options.NodePath,
                Arguments = [_options.ServerScript],
                WorkingDirectory = Path.GetDirectoryName(_options.ServerScript),
                EnvironmentVariables = new Dictionary<string, string?>
                {
                    ["OZDISAN_CURRENCY"] = _options.Currency,
                    ["OZDISAN_LANG"] = _options.Language,
                    ["OZDISAN_DOWNLOAD_DIR"] = _options.ResolvedDownloadDir,
                },
                StandardErrorLines = line => _logger.LogDebug("ozdisan: {Line}", line),
            }, loggerFactory);

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            try
            {
                _client = await McpClient.CreateAsync(transport, new McpClientOptions
                {
                    ClientInfo = new Implementation { Name = "productsearch-web", Version = "1.0.0" },
                }, loggerFactory, timeout.Token);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                throw new OzdisanUnavailableException(
                    $"Özdisan bileşeni başlatılamadı ({ex.Message}). Node.js 22+ kurulu mu ve '{_options.NodePath}' çalıştırılabiliyor mu?", ex);
            }
            _logger.LogInformation("Özdisan bileşeni başlatıldı (sürüm {Version})", _client.ServerInfo?.Version);
            return _client;
        }
        finally
        {
            _connectLock.Release();
        }
    }

    /// <summary>Bir Özdisan işlemini çağırır. Bağlantı kopmuşsa bileşeni yeniden başlatıp bir kez daha dener.</summary>
    public async Task<OzdisanToolResult> CallAsync(string operation, IReadOnlyDictionary<string, object?> args, CancellationToken ct)
    {
        if (!Operations.Contains(operation)) throw new ArgumentException($"Bilinmeyen Özdisan işlemi: {operation}");

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(Math.Max(10, _options.ToolTimeoutSeconds)));

        for (var attempt = 1; ; attempt++)
        {
            var client = await GetClientAsync(timeout.Token);
            try
            {
                var result = await client.CallToolAsync(operation, args, cancellationToken: timeout.Token);
                return ToResult(result);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return Error($"İşlem {_options.ToolTimeoutSeconds} saniyede tamamlanamadı. Daha küçük bir istekle tekrar deneyin.");
            }
            catch (McpProtocolException ex)
            {
                // Bileşen isteği reddetti (ör. geçersiz parametre): bağlantı sağlam, yeniden başlatma gerekmez.
                return Error(ex.Message);
            }
            catch (Exception ex) when (ex is not OperationCanceledException && attempt == 1)
            {
                _logger.LogWarning(ex, "Özdisan bileşeniyle bağlantı koptu, yeniden başlatılıyor");
                await ResetAsync(client);
            }
        }
    }

    private static OzdisanToolResult ToResult(CallToolResult result)
    {
        var text = string.Concat(result.Content.OfType<TextContentBlock>().Select(t => t.Text));
        JsonElement data;
        try
        {
            using var doc = JsonDocument.Parse(text.Length == 0 ? "{}" : text);
            data = doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            data = JsonSerializer.SerializeToElement(new { text });
        }
        return new OzdisanToolResult(result.IsError == true, data);
    }

    private static OzdisanToolResult Error(string message) =>
        new(true, JsonSerializer.SerializeToElement(new { error = message }));

    private async Task ResetAsync(McpClient broken)
    {
        await _connectLock.WaitAsync();
        try
        {
            if (!ReferenceEquals(_client, broken)) return;
            _client = null;
        }
        finally
        {
            _connectLock.Release();
        }
        try { await broken.DisposeAsync(); } catch { /* süreç zaten kapanmış olabilir */ }
    }

    public async ValueTask DisposeAsync()
    {
        if (_client is { } c)
        {
            _client = null;
            try { await c.DisposeAsync(); } catch { /* yok say */ }
        }
        _connectLock.Dispose();
    }
}

public sealed class OzdisanUnavailableException(string message, Exception? inner = null) : Exception(message, inner);
