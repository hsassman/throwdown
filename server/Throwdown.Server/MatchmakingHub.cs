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

    public Task RelayOffer(string targetConnectionId, string sdp) =>
        Clients.Client(targetConnectionId).SendAsync("ReceiveOffer", Context.ConnectionId, sdp);

    public Task RelayAnswer(string targetConnectionId, string sdp) =>
        Clients.Client(targetConnectionId).SendAsync("ReceiveAnswer", Context.ConnectionId, sdp);

    public Task RelayIceCandidate(string targetConnectionId, string candidate) =>
        Clients.Client(targetConnectionId).SendAsync("ReceiveIceCandidate", Context.ConnectionId, candidate);

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        _queue.Leave(Context.ConnectionId);
        return base.OnDisconnectedAsync(exception);
    }
}
