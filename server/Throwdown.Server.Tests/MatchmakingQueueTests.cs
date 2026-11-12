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
}
