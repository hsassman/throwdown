# Handoff to local Claude

Read this first, then `docs/PLAN.md`, `docs/ARCHITECTURE.md` and `README.md`.
This session started in the cloud. Continue it on the local machine from the
`plan-dotnet-matchmaking` branch.

## Goal

A live, playable demo at a 15-minute conference talk. The audience opens a link
on their phones (iPhone Safari, Android Chrome) and fights each other with their
webcams. It must work and look good on the day. It does not need to be a
finished product, and the game can be improved afterwards.

## State right now

- Repo: https://github.com/hsassman/throwdown (TypeScript, React 19, Vite 8,
  three.js, MediaPipe). 633 unit tests pass, lint and build are clean.
- PR #1: CI workflow (lint, test, build). Open, CI green.
- PR #2: README version fix, `docs/PLAN.md` and this file. Open, docs only.
- No server code exists yet. No .NET code exists yet.
- The README says punch-type detection is ~19% reliable from a front camera. Hit
  detection does not depend on it. Build the demo around reach, zone and dodges.

## Decisions already made

- Game stays in the browser, in TypeScript. Do not rewrite it in C#.
- Hosting: game on Vercel, database on Supabase Postgres, the .NET service on a
  separate container host with WebSocket support (Fly.io, Azure Container Apps
  or Railway). To our knowledge Vercel cannot run .NET or hold SignalR
  connections open. Verify this before relying on it. Host choice is still open.
- Backend: ASP.NET Core on .NET 11 (STS). Fall back to .NET 10 (LTS) if 11 is not
  final or stable by the talk. Check the release notes before using any
  .NET 11 feature.
- The server only does matchmaking, WebRTC signalling and the leaderboard. Video
  and pose data stay peer-to-peer and never reach the server.
- This narrows the "no server" rule in `docs/ARCHITECTURE.md`. Amend that file in
  the PR that adds the service.
- Targets: iPhone Safari and Android Chrome, as well as desktop.

## Order of work

0. **Baseline.** Measure frame rate, load time and memory on a real iPhone and
   a real Android phone. Use `npm run measure:sweep` and `npm run smoke`. Fix
   nothing before measuring.
1. **Performance and bugs.** One small PR per fix, each with a test.
2. **Backend.** `server/`: SignalR matchmaking hub, then leaderboard (Npgsql to
   Supabase), then OpenTelemetry. Its own tests and CI job.
3. **Client.** Replace "paste a code" with "Find a match", behind one small
   module in `src/net/`. Add a TURN relay. Fix the mobile layout.
4. **Graphics and animation.** Hayden has ideas and prompts. Wait for them.
5. **Load test, rehearsal, recorded backup demo.**

## How to work

- Use the user's vault and second-brain notes for context and for anything they
  have already decided. The cloud session had no access to them.
- Use the right agents and sub-agents for the job. Keep each task small, give
  each sub-agent one clear goal, and have it report results.
- Model: Fable 5.2 (`claude-fable-5-2`), run in a loop on one target at a time,
  for example "mobile pose FPS". Each loop turn: measure, change one thing,
  measure again, keep it only if it helps.
- Reach the goal, but not at any cost to safety. Never skip, disable or delete a
  test to get green. Never push to `main` directly. Open a pull request for every
  change, and keep each one small. Do not commit secrets: keep Supabase keys and
  TURN credentials in environment variables.
- Keep these rules, which tests enforce: perception never reads the character
  mesh, MediaPipe `z` is never read for classification, no threshold that decides
  a hit may be auto-tuned, and video never crosses the network.
- Run `npm run lint`, `npm test` and `npm run build` before every push.

## Mobile testing on the Huawei 5G CPE (do this after the work above)

The user has a Huawei 5G CPE router and can host the app on it for testing on
phones. Things to plan for:

- Phones only allow the camera on HTTPS pages. A page served from a LAN IP over
  plain HTTP will not get the camera. `localhost` is exempt, but a phone is not
  localhost. Use local HTTPS (for example mkcert, with its root certificate
  installed on each phone) or an HTTPS tunnel.
- The router may isolate clients, so phones cannot reach each other or the host.
  Check the router's settings for client or AP isolation.
- A 5G CPE is often behind carrier NAT. Peer-to-peer between two phones on the
  same Wi-Fi should work, but test it, and test over mobile data with TURN.
- Test both phones at once, in both orientations, in poor light.
- Record frame rate and latency on each phone, and put the numbers in the PR.
