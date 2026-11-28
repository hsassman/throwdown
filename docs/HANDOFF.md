# Handover to Codex (28 November 2026)

Claude Code worked on gameplay, multiplayer and the server today; Codex worked
on the interface and the fighter's look. This page is where to pick up. The
other docs (`GAMEPLAY.md`, `TECHNOLOGY.md`, `DEVELOPMENT.md`) are current.

## Where things stand

- `main` is the only branch and the source of truth. Every push to `main`
  redeploys the live game at https://throwdown-orcin.vercel.app (Vercel).
- CI (`.github/workflows/ci.yml`) runs three jobs on every push: `check` (lint,
  unit tests, build), `server` (`dotnet test`) and `online-smoke` (the real
  .NET server plus headless browsers, `tools/smoke-online.mjs`).
- The .NET server runs on Render at https://throwdown-myc3.onrender.com (free
  tier, sleeps when idle, about 15 to 30 s to wake). `docs/DEPLOY.md` still
  describes Fly.io; the live server is Render.

Shipped today, newest last:

| Change | Commit |
| --- | --- |
| First person: the CPU stands off at about 0.96 m and steps in to throw | `1319cb8` |
| Online: a stale pairing goes back into the queue | `facc0ea` |
| "Choose your view" step before every fight | `5d4787d` |
| Codex: realistic eyes | `7b9811b` |
| Third person is the see-through over-the-shoulder view again | `393dfae` |
| Server: rooms joined with a four-character code (`HostRoom`, `JoinRoom`) | `99d9e0d` |
| Play a Friend: join with a code or a QR code, with a fallback | `9eefaf1` |
| Online smoke test: a browser per player | `7c7dc25` |
| Late connection candidates relayed through the server | `e6adf7f` |

## Needs the user: redeploy the server on Render

Render did not redeploy when the server changed: 90 minutes after `99d9e0d`
passed CI, the live hub still answered "Method does not exist" for `HostRoom`.

1. In the Render dashboard, open the server service and choose
   **Manual Deploy > Deploy latest commit** (and turn on auto-deploy from
   `main` if it is off).
2. Check `https://throwdown-myc3.onrender.com/health` returns
   `{"status":"ok","rooms":true}`.

Until then the live game is safe: Play a Friend asks `/health` for
`rooms: true` and, without it, falls back to the old pasted connection codes.
Once the server is redeployed, the code-and-QR flow switches on by itself.

## Then verify multiplayer on the live site

Run the online smoke test against production (the Vercel origin is allowed by
the server's CORS, so no flags are needed):

```
BASE_URL=https://throwdown-orcin.vercel.app SERVER_URL=https://throwdown-myc3.onrender.com PW_CHANNEL=chrome node tools/smoke-online.mjs
```

All 14 checks should pass: Online queue pairing, leaving and searching again,
a room code typed by a friend, the clock running on both ends, joining through
the QR link (`?join=CODE`), and a cancelled room's code being refused. Then
test with two real devices: host on a laptop, scan the QR code with a phone's
camera. Nobody has scanned the QR code with a real phone yet (the QR images
were decoded with OpenCV and carry the right link).

Same Wi-Fi always works. Across networks most connections work with STUN
alone, but some mobile networks need a TURN relay, which is not configured
(`/ice-servers` returns `[]`). The server reads TURN servers from
`Ice__Servers__N__Urls__0`, `__Username` and `__Credential` environment
variables (see the TURN section of `docs/DEPLOY.md`; set them on Render).

## Known issues

- **`online-smoke` in CI fails intermittently.** The CI annotations (readable
  without a login: the commit's check runs) showed the cause: on a two-core
  runner the software-rendered pages starve, the offer and answer cross, but
  connectivity checks never start before the 20 s connect timeout. `7c7dc25`
  (a browser per player, smaller windows) and `e6adf7f` (late candidates
  relayed) both target it; the CI result for `e6adf7f` had not been read when
  this was written. If it still flakes, look at the annotations first.
- **Your punches land while the CPU stands off.** Hits are judged from the
  player's pose, not distance, and from the eyes the glove covers the face.
  The user has not yet decided whether out-of-reach punches should miss.
- **Online and Play a Friend keep the real distance.** Only CPU fights stand
  off; in a two-player fight the gap comes from both players' tracked depth.

## Working in this repo

- Push to `main` only as a fast-forward, after: `npx tsc -b`, `npx oxlint`,
  `npx vitest run`, `npx vite build`, then with `npx vite preview` running,
  `node tools/smoke-shell.mjs` and `node tools/smoke-versus.mjs`. A push
  redeploys the live site.
- Run browser tests from a separate worktree (`git worktree add --detach`,
  junction `node_modules`) if anything else might rebuild `dist/` meanwhile.
- Local server for `tools/smoke-online.mjs`: install the .NET 11 SDK
  (`dotnet-install.ps1 -Channel 11.0`), then run
  `Cors__AllowedOrigins__0=http://localhost:4173 dotnet run --project server/Throwdown.Server --urls http://localhost:5160`
  and build the game with
  `VITE_MATCHMAKING_URL=http://localhost:5160/hubs/matchmaking`. In a sandbox
  that blocks `%APPDATA%\NuGet`, point `APPDATA`, `DOTNET_CLI_HOME` and
  `NUGET_PACKAGES` at a writable folder.
- House style: no em dashes anywhere, short comments that say why, plain
  sentences in the interface.

## Where the code is

| Area | Files |
| --- | --- |
| Fight cameras (first person at the eyes, see-through third person) | `src/render/fpsCamera.ts`, the "Fight cameras" block in `src/render/BoxerModel.tsx` |
| View choice before a fight | `src/ui/shell/MenuShell.tsx` (`VIEW_MODES`, `pickView`) |
| CPU stand-off and step-in | `src/sim/cpuOpponent.ts` (`LOCKED_STANDOFF`, `exchanging`) |
| Rooms on the server | `server/Throwdown.Server/MatchmakingQueue.cs`, `MatchmakingHub.cs`, `/health` in `Program.cs` |
| Client signalling (queue, rooms, relays) | `src/net/matchmakingClient.ts`, `src/net/useOnlineSession.ts`, `src/net/peerLink.ts` |
| Room codes, QR link, room support check | `src/net/roomCode.ts`, `src/net/roomSupport.ts`, `src/ui/RoomPanel.tsx` |
| Pasted-code fallback | `src/net/useSession.ts`, `src/ui/VersusPanel.tsx` |
| App wiring for both sessions and `?join=` | `src/App.tsx` (`roomSession`, `lanNet`, `joinCode`) |
