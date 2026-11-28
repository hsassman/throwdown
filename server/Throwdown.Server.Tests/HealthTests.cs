using Microsoft.AspNetCore.Mvc.Testing;

namespace Throwdown.Server.Tests;

public class HealthTests
{
    [Fact]
    public async Task HealthEndpointReportsOk()
    {
        using var factory = new WebApplicationFactory<Program>();
        using var client = factory.CreateClient();

        var response = await client.GetAsync("/health");

        Assert.True(response.IsSuccessStatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("ok", body);
        Assert.Contains("\"rooms\":true", body);
    }
}
