namespace Throwdown.Server;

/// <summary>Pairs two waiting connections. One player waits; the next to join is matched with them.</summary>
public sealed class MatchmakingQueue
{
    private readonly object _lock = new();
    private string? _waitingConnectionId;

    public MatchResult Join(string connectionId)
    {
        lock (_lock)
        {
            if (_waitingConnectionId is null || _waitingConnectionId == connectionId)
            {
                _waitingConnectionId = connectionId;
                return MatchResult.Waiting;
            }

            var opponentConnectionId = _waitingConnectionId;
            _waitingConnectionId = null;
            return MatchResult.Matched(Guid.NewGuid().ToString("N"), opponentConnectionId);
        }
    }

    public void Leave(string connectionId)
    {
        lock (_lock)
        {
            if (_waitingConnectionId == connectionId)
            {
                _waitingConnectionId = null;
            }
        }
    }
}

public readonly record struct MatchResult(bool IsMatched, string? MatchId, string? OpponentConnectionId)
{
    public static readonly MatchResult Waiting = new(false, null, null);

    public static MatchResult Matched(string matchId, string opponentConnectionId) =>
        new(true, matchId, opponentConnectionId);
}
