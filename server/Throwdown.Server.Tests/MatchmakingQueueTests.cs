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
}
