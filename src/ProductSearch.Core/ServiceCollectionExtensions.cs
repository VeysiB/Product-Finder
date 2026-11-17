using System.Net;
using Microsoft.Extensions.DependencyInjection;

namespace ProductSearch.Core;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddProductSearch(this IServiceCollection services)
    {
        services.AddHttpClient<AkakceClient>(c =>
            {
                c.Timeout = TimeSpan.FromSeconds(25);
                c.DefaultRequestHeaders.UserAgent.ParseAdd(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
                c.DefaultRequestHeaders.AcceptLanguage.ParseAdd("tr-TR,tr;q=0.9");
                c.DefaultRequestHeaders.Accept.ParseAdd("text/html,application/xhtml+xml");
            })
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
            {
                AutomaticDecompression = DecompressionMethods.All,
                PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            });
        services.AddTransient<ProductSearchService>();
        return services;
    }
}
