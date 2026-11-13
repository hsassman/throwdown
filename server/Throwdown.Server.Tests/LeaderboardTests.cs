using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace Throwdown.Server.Tests;

public class LeaderboardTests
{
    [Fact]
    public async Task InMemoryStoreReturnsHighestScoresFirst()
    {
        var store = new InMemoryLeaderboardStore();
        await store.AddAsync(new LeaderboardEntry("a", 10, DateTimeOffset.UtcNow));
        await store.AddAsync(new LeaderboardEntry("b", 30, DateTimeOffset.UtcNow));
        await store.AddAsync(new LeaderboardEntry("c", 20, DateTimeOffset.UtcNow));

        var top = await store.TopAsync(2);

        Assert.Equal(new[] { "b", "c" }, top.Select(e => e.Name).ToArray());
    }

    [Theory]
    [InlineData(null, 5)]
    [InlineData("", 5)]
    [InlineData("   ", 5)]
    [InlineData("this name is far too long", 5)]
    [InlineData("ok", -1)]
    [InlineData("ok", 100_001)]
    public void RejectsBadSubmissions(string? name, int score)
    {
        Assert.False(LeaderboardRules.TryValidate(new ScoreSubmission(name, score), out _, out var error));
        Assert.False(string.IsNullOrEmpty(error));
    }

    [Fact]
    public void AcceptsAndTrimsAGoodSubmission()
    {
        Assert.True(LeaderboardRules.TryValidate(new ScoreSubmission("  Kai ", 42), out var entry, out _));
        Assert.Equal("Kai", entry!.Name);
        Assert.Equal(42, entry.Score);
    }

    [Fact]
    public async Task PostThenGetRoundTrips()
    {
        using var factory = new WebApplicationFactory<Program>();
        using var client = factory.CreateClient();

        var post = await client.PostAsJsonAsync("/leaderboard", new { name = "Hayden", score = 77 });
        Assert.Equal(HttpStatusCode.Created, post.StatusCode);

        var rows = await client.GetFromJsonAsync<List<LeaderboardEntry>>("/leaderboard?top=5");
        Assert.Contains(rows!, r => r.Name == "Hayden" && r.Score == 77);
    }

    [Fact]
    public async Task PostRejectsInvalidScore()
    {
        using var factory = new WebApplicationFactory<Program>();
        using var client = factory.CreateClient();

        var post = await client.PostAsJsonAsync("/leaderboard", new { name = "x", score = -5 });

        Assert.Equal(HttpStatusCode.BadRequest, post.StatusCode);
    }

    [Fact]
    public async Task IceServersComeFromConfiguration()
    {
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
            b.ConfigureAppConfiguration((_, c) => c.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Ice:Servers:0:Urls:0"] = "stun:stun.example.com:3478",
                ["Ice:Servers:1:Urls:0"] = "turn:turn.example.com:3478",
                ["Ice:Servers:1:Username"] = "u",
                ["Ice:Servers:1:Credential"] = "p",
            })));
        using var client = factory.CreateClient();

        var body = await client.GetStringAsync("/ice-servers");

        Assert.Contains("stun:stun.example.com:3478", body);
        Assert.Contains("turn:turn.example.com:3478", body);
    }
}
