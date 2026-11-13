using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;

namespace Throwdown.Server.Tests;

// Real SignalR clients against the in-process test server, so these cover the hub's wiring
// (method names, who gets told what) rather than just the queue's bookkeeping.
public class HubTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;

    public HubTests(WebApplicationFactory<Program> factory)
    {
        _factory = factory;
    }

    private async Task<HubConnection> ConnectAsync()
    {
        var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(_factory.Server.BaseAddress, "/hubs/matchmaking"),
                o => o.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler())
            .Build();
        await connection.StartAsync();
        return connection;
    }

    // Matched carries (matchId, opponentConnectionId, isOfferer).
    private static TaskCompletionSource<(string MatchId, bool IsOfferer)> ExpectMatched(HubConnection c)
    {
        var tcs = new TaskCompletionSource<(string, bool)>(TaskCreationOptions.RunContinuationsAsynchronously);
        c.On<string, string, bool>("Matched", (matchId, _, isOfferer) => tcs.TrySetResult((matchId, isOfferer)));
        return tcs;
    }

    private static TaskCompletionSource<bool> ExpectSignal(HubConnection c, string method)
    {
        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        c.On(method, () => tcs.TrySetResult(true));
        return tcs;
    }

    [Fact]
    public async Task TwoPlayersAreMatchedAndTheRemainingOneIsToldWhenTheOtherLeaves()
    {
        await using var a = await ConnectAsync();
        await using var b = await ConnectAsync();
        var aMatched = ExpectMatched(a);
        var bMatched = ExpectMatched(b);
        var aLeft = ExpectSignal(a, "OpponentLeft");

        await a.InvokeAsync("JoinQueue");
        await b.InvokeAsync("JoinQueue");
        var timeout = TimeSpan.FromSeconds(10);
        var (aId, aOffers) = await aMatched.Task.WaitAsync(timeout);
        var (bId, bOffers) = await bMatched.Task.WaitAsync(timeout);
        Assert.Equal(aId, bId);
        Assert.NotEqual(aOffers, bOffers); // exactly one side makes the offer

        await b.StopAsync();

        Assert.True(await aLeft.Task.WaitAsync(timeout));
    }

    [Fact]
    public async Task RelayToAStrangerIsRefused()
    {
        await using var a = await ConnectAsync();
        await using var stranger = await ConnectAsync();
        await a.InvokeAsync("JoinQueue");

        await Assert.ThrowsAsync<HubException>(() =>
            a.InvokeAsync("RelayOffer", stranger.ConnectionId!, "sdp"));
    }
}
