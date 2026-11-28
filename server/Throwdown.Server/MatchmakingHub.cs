using Microsoft.AspNetCore.SignalR;

namespace Throwdown.Server;

/// <summary>Pairs players and relays the WebRTC offer/answer/ICE exchange. The fight itself stays peer-to-peer.</summary>
public sealed class MatchmakingHub : Hub
{
    private readonly MatchmakingQueue _queue;

    public MatchmakingHub(MatchmakingQueue queue)
    {
        _queue = queue;
    }

    public async Task JoinQueue()
    {
        // Joining again ends any previous pairing first, so the old opponent isn't left waiting on us.
        await NotifyOpponentLeft(_queue.Leave(Context.ConnectionId));

        var result = _queue.Join(Context.ConnectionId);
        if (!result.IsMatched)
        {
            await Clients.Caller.SendAsync("Waiting");
            return;
        }

        // The joiner that completed the pair makes the offer; the one who was already waiting answers it.
        await Clients.Caller.SendAsync("Matched", result.MatchId, result.OpponentConnectionId, true);
        await Clients.Client(result.OpponentConnectionId!).SendAsync("Matched", result.MatchId, Context.ConnectionId, false);
    }

    /// <summary>Opens a room for a friend to join by code. The host answers the joiner's offer.</summary>
    public async Task<string> HostRoom()
    {
        await NotifyOpponentLeft(_queue.Leave(Context.ConnectionId));
        return _queue.OpenRoom(Context.ConnectionId);
    }

    /// <summary>Joins a friend's room. False when no room has that code.</summary>
    public async Task<bool> JoinRoom(string code)
    {
        // Codes are short; a connection that keeps guessing is cut off.
        var misses = Context.Items.TryGetValue(MissesKey, out var m) ? (int)m! : 0;
        if (misses >= MaxMisses)
        {
            throw new HubException("Too many wrong codes. Reload and try again.");
        }

        await NotifyOpponentLeft(_queue.Leave(Context.ConnectionId));
        var result = _queue.JoinRoom(code ?? "", Context.ConnectionId);
        if (!result.IsMatched)
        {
            Context.Items[MissesKey] = misses + 1;
            return false;
        }

        // The offerer hosts the fight, so the room's creator offers and the joiner answers.
        await Clients.Caller.SendAsync("Matched", result.MatchId, result.OpponentConnectionId, false);
        await Clients.Client(result.OpponentConnectionId!).SendAsync("Matched", result.MatchId, Context.ConnectionId, true);
        return true;
    }

    private const string MissesKey = "roomMisses";
    private const int MaxMisses = 10;

    public Task RelayOffer(string targetConnectionId, string sdp)
    {
        EnsureMatched(targetConnectionId);
        return Clients.Client(targetConnectionId).SendAsync("ReceiveOffer", Context.ConnectionId, sdp);
    }

    public Task RelayAnswer(string targetConnectionId, string sdp)
    {
        EnsureMatched(targetConnectionId);
        return Clients.Client(targetConnectionId).SendAsync("ReceiveAnswer", Context.ConnectionId, sdp);
    }

    public Task RelayIceCandidate(string targetConnectionId, string candidate)
    {
        EnsureMatched(targetConnectionId);
        return Clients.Client(targetConnectionId).SendAsync("ReceiveIceCandidate", Context.ConnectionId, candidate);
    }

    // A client may only message the opponent it was paired with, never an arbitrary connection id.
    private void EnsureMatched(string targetConnectionId)
    {
        if (!_queue.AreMatched(Context.ConnectionId, targetConnectionId))
        {
            throw new HubException("Not matched with that connection.");
        }
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        // A player closing the tab mid-handshake would otherwise leave their opponent stuck on
        // "connecting" forever. Tell them, so they can look for someone else.
        await NotifyOpponentLeft(_queue.Leave(Context.ConnectionId));
        await base.OnDisconnectedAsync(exception);
    }

    private Task NotifyOpponentLeft(string? opponentConnectionId) =>
        opponentConnectionId is null
            ? Task.CompletedTask
            : Clients.Client(opponentConnectionId).SendAsync("OpponentLeft");
}
