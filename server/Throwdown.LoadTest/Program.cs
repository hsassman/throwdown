// Simulates a room full of players hitting the matchmaking hub at once:
// each one connects, joins the queue, gets matched, and swaps a (fake) WebRTC
// offer and answer with its opponent, exactly as the browser does. No video,
// no WebRTC - this measures the server, which is the only shared part.
//
//   dotnet run --project server/Throwdown.LoadTest -- --url http://localhost:5160 --players 300
//
// Options:
//   --url        server root (default http://localhost:5160)
//   --players    how many simulated players (default 200)
//   --ramp       seconds over which they arrive (default 10; 0 = all at once)
//   --timeout    seconds each player waits for a match/handshake (default 30)

using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.AspNetCore.SignalR.Client;

var url = Arg("--url", "http://localhost:5160").TrimEnd('/');
var players = int.Parse(Arg("--players", "200"));
var rampSeconds = double.Parse(Arg("--ramp", "10"));
var timeout = TimeSpan.FromSeconds(double.Parse(Arg("--timeout", "30")));

Console.WriteLine($"Load test: {players} players against {url}/hubs/matchmaking, arriving over {rampSeconds}s");

var results = new ConcurrentBag<PlayerResult>();
var total = Stopwatch.StartNew();
var tasks = new List<Task>();
for (var i = 0; i < players; i++)
{
    var delay = players <= 1 ? TimeSpan.Zero : TimeSpan.FromSeconds(rampSeconds * i / (players - 1));
    tasks.Add(Task.Run(async () =>
    {
        await Task.Delay(delay);
        results.Add(await RunPlayer(url, timeout));
    }));
}
await Task.WhenAll(tasks);
total.Stop();

var all = results.ToList();
var ok = all.Where(r => r.Error is null).ToList();
var failed = all.Where(r => r.Error is not null).ToList();
// With an odd number of players one is always left waiting; that is correct.
var unmatchedExpected = players % 2;

Console.WriteLine();
Console.WriteLine($"Finished in {total.Elapsed.TotalSeconds:F1}s");
Console.WriteLine($"  completed handshakes : {ok.Count}/{players}");
Console.WriteLine($"  failed               : {failed.Count} (expected unmatched: {unmatchedExpected})");
Report("connect", ok.Select(r => r.ConnectMs));
Report("wait for match", ok.Select(r => r.MatchMs));
Report("offer/answer relay", ok.Select(r => r.HandshakeMs));
foreach (var group in failed.GroupBy(f => f.Error).OrderByDescending(g => g.Count()))
{
    Console.WriteLine($"  {group.Count(),4} x {group.Key}");
}

// Exit code: non-zero if more players failed than an odd count explains.
return failed.Count > unmatchedExpected ? 1 : 0;

static async Task<PlayerResult> RunPlayer(string url, TimeSpan timeout)
{
    var sw = Stopwatch.StartNew();
    double connectMs = 0, matchMs = 0;
    var matched = new TaskCompletionSource<(string Opponent, bool IsOfferer)>(TaskCreationOptions.RunContinuationsAsynchronously);
    var offer = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
    var answer = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

    await using var conn = new HubConnectionBuilder().WithUrl($"{url}/hubs/matchmaking").Build();
    conn.On<string, string, bool>("Matched", (_, opp, isOfferer) => matched.TrySetResult((opp, isOfferer)));
    conn.On<string, string>("ReceiveOffer", (from, _) => offer.TrySetResult(from));
    conn.On<string, string>("ReceiveAnswer", (_, _) => answer.TrySetResult(true));
    conn.On("OpponentLeft", () => matched.TrySetException(new Exception("opponent left")));

    try
    {
        using var cts = new CancellationTokenSource(timeout);
        await conn.StartAsync(cts.Token);
        connectMs = sw.Elapsed.TotalMilliseconds;

        await conn.InvokeAsync("JoinQueue", cts.Token);
        var (opponent, isOfferer) = await matched.Task.WaitAsync(cts.Token);
        matchMs = sw.Elapsed.TotalMilliseconds - connectMs;

        var fakeSdp = new string('x', 2000); // about the size of a real offer
        if (isOfferer)
        {
            await conn.InvokeAsync("RelayOffer", opponent, fakeSdp, cts.Token);
            await answer.Task.WaitAsync(cts.Token);
        }
        else
        {
            var from = await offer.Task.WaitAsync(cts.Token);
            await conn.InvokeAsync("RelayAnswer", from, fakeSdp, cts.Token);
        }
        var handshakeMs = sw.Elapsed.TotalMilliseconds - connectMs - matchMs;

        // Stay connected briefly so the opponent's handshake can finish before
        // our disconnect sends it OpponentLeft.
        await Task.Delay(2000);
        return new PlayerResult(connectMs, matchMs, handshakeMs, null);
    }
    catch (OperationCanceledException)
    {
        return new PlayerResult(connectMs, matchMs, 0, connectMs == 0 ? "timed out connecting" : matchMs == 0 ? "timed out waiting for a match" : "timed out in offer/answer");
    }
    catch (Exception ex)
    {
        return new PlayerResult(connectMs, matchMs, 0, ex.GetBaseException().Message);
    }
}

static void Report(string name, IEnumerable<double> values)
{
    var v = values.OrderBy(x => x).ToArray();
    if (v.Length == 0) return;
    double P(double p) => v[Math.Min(v.Length - 1, (int)Math.Ceiling(p * v.Length) - 1)];
    Console.WriteLine($"  {name,-20} : p50 {P(0.5),7:F0} ms   p95 {P(0.95),7:F0} ms   max {v[^1],7:F0} ms");
}

string Arg(string name, string fallback)
{
    var i = Array.IndexOf(args, name);
    return i >= 0 && i + 1 < args.Length ? args[i + 1] : fallback;
}

record PlayerResult(double ConnectMs, double MatchMs, double HandshakeMs, string? Error);
