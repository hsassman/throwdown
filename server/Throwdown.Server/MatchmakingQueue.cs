using System.Security.Cryptography;

namespace Throwdown.Server;

/// <summary>
/// Pairs connections. The queue pairs whoever is waiting with the next to join; a room pairs its host
/// with whoever enters its code.
/// </summary>
public sealed class MatchmakingQueue
{
    /// <summary>Room codes leave out I, O, 0 and 1, which are easy to misread off a screen.</summary>
    public const string CodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    public const int CodeLength = 4;

    private readonly object _lock = new();
    private string? _waitingConnectionId;
    private readonly Dictionary<string, string> _opponents = new();
    private readonly Dictionary<string, string> _rooms = new();

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
            return Pair(connectionId, opponentConnectionId);
        }
    }

    /// <summary>Opens a room hosted by the connection and returns its code. Replaces any room it already hosts.</summary>
    public string OpenRoom(string connectionId)
    {
        lock (_lock)
        {
            CloseRooms(connectionId);
            string code;
            do
            {
                code = RandomNumberGenerator.GetString(CodeAlphabet, CodeLength);
            } while (_rooms.ContainsKey(code));
            _rooms[code] = connectionId;
            return code;
        }
    }

    /// <summary>Pairs the connection with the room's host. Not matched when there is no such room or it is the host's own.</summary>
    public MatchResult JoinRoom(string code, string connectionId)
    {
        var key = code.Trim().ToUpperInvariant();
        lock (_lock)
        {
            if (!_rooms.TryGetValue(key, out var host) || host == connectionId)
            {
                return MatchResult.Waiting;
            }

            _rooms.Remove(key);
            return Pair(connectionId, host);
        }
    }

    /// <summary>
    /// Removes the connection from the queue, closes its rooms and ends its pairing. Returns the opponent it was
    /// paired with, if any, so the hub can tell them; null if it was only waiting or not known at all.
    /// </summary>
    public string? Leave(string connectionId)
    {
        lock (_lock)
        {
            if (_waitingConnectionId == connectionId)
            {
                _waitingConnectionId = null;
            }

            CloseRooms(connectionId);

            if (_opponents.Remove(connectionId, out var opponent))
            {
                _opponents.Remove(opponent);
                return opponent;
            }

            return null;
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

    private MatchResult Pair(string connectionId, string opponentConnectionId)
    {
        _opponents[connectionId] = opponentConnectionId;
        _opponents[opponentConnectionId] = connectionId;
        return MatchResult.Matched(Guid.NewGuid().ToString("N"), opponentConnectionId);
    }

    private void CloseRooms(string connectionId)
    {
        foreach (var code in _rooms.Where(r => r.Value == connectionId).Select(r => r.Key).ToList())
        {
            _rooms.Remove(code);
        }
    }
}

public readonly record struct MatchResult(bool IsMatched, string? MatchId, string? OpponentConnectionId)
{
    public static readonly MatchResult Waiting = new(false, null, null);

    public static MatchResult Matched(string matchId, string opponentConnectionId) =>
        new(true, matchId, opponentConnectionId);
}
