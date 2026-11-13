namespace Throwdown.Server;

/// <summary>Pairs two waiting connections. One player waits; the next to join is matched with them.</summary>
public sealed class MatchmakingQueue
{
    private readonly object _lock = new();
    private string? _waitingConnectionId;
    private readonly Dictionary<string, string> _opponents = new();

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
            _opponents[connectionId] = opponentConnectionId;
            _opponents[opponentConnectionId] = connectionId;
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

            if (_opponents.Remove(connectionId, out var opponent))
            {
                _opponents.Remove(opponent);
            }
        }
    }

    /// <summary>True only if the two connections were paired with each other and neither has left.</summary>
    public bool AreMatched(string connectionId, string otherConnectionId)
    {
        lock (_lock)
        {
            return _opponents.TryGetValue(connectionId, out var opponent) && opponent == otherConnectionId;
        }
    }
}

public readonly record struct MatchResult(bool IsMatched, string? MatchId, string? OpponentConnectionId)
{
    public static readonly MatchResult Waiting = new(false, null, null);

    public static MatchResult Matched(string matchId, string opponentConnectionId) =>
        new(true, matchId, opponentConnectionId);
}
