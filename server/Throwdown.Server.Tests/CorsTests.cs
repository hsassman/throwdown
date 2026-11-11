using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace Throwdown.Server.Tests;

public class CorsTests
{
    private static WebApplicationFactory<Program> MakeFactory() =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Cors:AllowedOrigins:0"] = "http://localhost:5174",
                })));

    [Fact]
    public async Task AllowsTheConfiguredBrowserOrigin()
    {
        using var factory = MakeFactory();
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/");
        request.Headers.Add("Origin", "http://localhost:5174");

        var response = await client.SendAsync(request);

        Assert.True(response.Headers.TryGetValues("Access-Control-Allow-Origin", out var values));
        Assert.Equal("http://localhost:5174", values!.First());
    }

    [Fact]
    public async Task RejectsAnUnlistedOrigin()
    {
        using var factory = MakeFactory();
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/");
        request.Headers.Add("Origin", "http://evil.example");

        var response = await client.SendAsync(request);

        Assert.False(response.Headers.Contains("Access-Control-Allow-Origin"));
    }
}
