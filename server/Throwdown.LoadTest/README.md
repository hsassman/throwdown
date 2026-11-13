# Load test

Simulates a room of players hitting the matchmaking hub at once. Each one
connects, joins the queue, is matched, and swaps a fake WebRTC offer and answer
with its opponent, the same calls the browser makes. It measures the server
only: no video, no WebRTC.

```bash
# against a local server
dotnet run --project server/Throwdown.LoadTest -- --players 300

# against the deployed one, everyone arriving at once
dotnet run --project server/Throwdown.LoadTest -- --url https://throwdown-server.fly.dev --players 500 --ramp 0
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--url` | `http://localhost:5160` | Server root |
| `--players` | `200` | Simulated players |
| `--ramp` | `10` | Seconds over which they arrive (`0` = all at once) |
| `--timeout` | `30` | Seconds each player waits for a match and handshake |

It prints how many handshakes completed and p50/p95/max times for connecting,
waiting for a match and relaying the offer and answer. It exits non-zero if
more players failed than an odd player count explains (one is always left
waiting).

Run it against the real deployment before the talk, from a machine that is
not the server.
