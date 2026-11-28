using Throwdown.Server;
using Xunit;

namespace Throwdown.Server.Tests;

public class MatchmakingQueueTests
{
    [Fact]
    public void FirstJoinWaits()
    {
        var queue = new MatchmakingQueue();

        var result = queue.Join("conn-1");

        Assert.False(result.IsMatched);
    }

    [Fact]
    public void SecondJoinMatchesTheFirst()
    {
        var queue = new MatchmakingQueue();
        queue.Join("conn-1");

        var result = queue.Join("conn-2");

        Assert.True(result.IsMatched);
        Assert.Equal("conn-1", result.OpponentConnectionId);
        Assert.False(string.IsNullOrEmpty(result.MatchId));
    }

    [Fact]
    public void SameConnectionJoiningTwiceStaysWaiting()
    {
        var queue = new MatchmakingQueue();
        queue.Join("conn-1");

        var result = queue.Join("conn-1");

        Assert.False(result.IsMatched);
    }

    [Fact]
    public void ThirdJoinWaitsAfterFirstTwoAreMatched()
    {
        var queue = new MatchmakingQueue();
        queue.Join("conn-1");
        queue.Join("conn-2");

        var result = queue.Join("conn-3");

        Assert.False(result.IsMatched);
    }

    [Fact]
    public void LeavingClearsTheWaitingSlot()
    {
        var queue = new MatchmakingQueue();
        queue.Join("conn-1");
        queue.Leave("conn-1");

        var result = queue.Join("conn-2");

        Assert.False(result.IsMatched);
    }

    [Fact]
    public void LeavingWhileSomeoneElseIsWaitingDoesNotEvictThem()
    {
        var queue = new MatchmakingQueue();
        queue.Join("conn-1");
        queue.Leave("conn-2"); // not the waiting connection

        var result = queue.Join("conn-2");

        Assert.True(result.IsMatched);
        Assert.Equal("conn-1", result.OpponentConnectionId);
    }

    [Fact]
    public void MatchedConnectionsAreRecognisedBothWays()
    {
        var queue = new MatchmakingQueue();
        queue.Join("conn-1");
        queue.Join("conn-2");

        Assert.True(queue.AreMatched("conn-1", "conn-2"));
        Assert.True(queue.AreMatched("conn-2", "conn-1"));
    }

    [Fact]
    public void StrangersAreNotMatched()
    {
        var queue = new MatchmakingQueue();
        queue.Join("conn-1");
        queue.Join("conn-2");
        queue.Join("conn-3");

        Assert.False(queue.AreMatched("conn-1", "conn-3"));
        Assert.False(queue.AreMatched("conn-3", "conn-2"));
        Assert.False(queue.AreMatched("conn-1", "nobody"));
    }

    [Fact]
    public void LeavingEndsThePairing()
    {
        var queue = new MatchmakingQueue();
        queue.Join("conn-1");
        queue.Join("conn-2");

        queue.Leave("conn-1");

        Assert.False(queue.AreMatched("conn-1", "conn-2"));
        Assert.False(queue.AreMatched("conn-2", "conn-1"));
    }

    [Fact]
    public void LeavingReturnsTheOpponentToNotify()
    {
        var queue = new MatchmakingQueue();
        queue.Join("conn-1");
        queue.Join("conn-2");

        Assert.Equal("conn-2", queue.Leave("conn-1"));
        Assert.Null(queue.Leave("conn-2"));
    }

    [Fact]
    public void LeavingWhileOnlyWaitingHasNoOneToNotify()
    {
        var queue = new MatchmakingQueue();
        queue.Join("conn-1");

        Assert.Null(queue.Leave("conn-1"));
        Assert.False(queue.Join("conn-2").IsMatched);
    }

    [Fact]
    public void ARoomCodeIsFourReadableCharacters()
    {
        var code = new MatchmakingQueue().OpenRoom("host");

        Assert.Equal(MatchmakingQueue.CodeLength, code.Length);
        Assert.All(code, c => Assert.Contains(c, MatchmakingQueue.CodeAlphabet));
    }

    [Fact]
    public void EnteringTheCodePairsTheGuestWithTheHost()
    {
        var queue = new MatchmakingQueue();
        var code = queue.OpenRoom("host");

        var result = queue.JoinRoom($" {code.ToLowerInvariant()} ", "guest");

        Assert.True(result.IsMatched);
        Assert.Equal("host", result.OpponentConnectionId);
        Assert.True(queue.AreMatched("guest", "host"));
    }

    [Fact]
    public void AWrongCodeOrTheHostsOwnDoesNotPair()
    {
        var queue = new MatchmakingQueue();
        var code = queue.OpenRoom("host");

        Assert.False(queue.JoinRoom(code == "AAAA" ? "BBBB" : "AAAA", "guest").IsMatched);
        Assert.False(queue.JoinRoom(code, "host").IsMatched);
        Assert.True(queue.JoinRoom(code, "guest").IsMatched);
    }

    [Fact]
    public void ARoomTakesOneGuest()
    {
        var queue = new MatchmakingQueue();
        var code = queue.OpenRoom("host");
        queue.JoinRoom(code, "guest");

        Assert.False(queue.JoinRoom(code, "late").IsMatched);
    }

    [Fact]
    public void AHostWhoLeavesClosesTheRoom()
    {
        var queue = new MatchmakingQueue();
        var code = queue.OpenRoom("host");

        Assert.Null(queue.Leave("host"));
        Assert.False(queue.JoinRoom(code, "guest").IsMatched);
    }

    [Fact]
    public void HostingAgainReplacesTheOldRoom()
    {
        var queue = new MatchmakingQueue();
        var first = queue.OpenRoom("host");
        var second = queue.OpenRoom("host");

        if (first != second) Assert.False(queue.JoinRoom(first, "guest").IsMatched);
        Assert.True(queue.JoinRoom(second, "guest").IsMatched);
    }

    [Fact]
    public void RoomsAndTheQueueStaySeparate()
    {
        var queue = new MatchmakingQueue();
        queue.OpenRoom("host");

        Assert.False(queue.Join("stranger").IsMatched);
    }
}
