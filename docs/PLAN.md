# Plan: online matchmaking with .NET

Status (13 Nov 2026): **server built and tested, not deployed.** Matchmaking,
signalling, leaderboard, ICE config and telemetry are in `server/`. The browser
uses matchmaking, ICE config and the leaderboard. Deploy config is ready
(`docs/DEPLOY.md`). Still to do: deploy (needs Fly, Vercel and Supabase
access), choose a TURN provider, test on phones, then graphics.

## Where the project is

- ~26k lines of TypeScript, 633 passing tests, CI added in PR #1.
- Everything runs in the browser: camera, MediaPipe pose, punch detection,
  simulation, rendering.
- Multiplayer is peer-to-peer over WebRTC, but players exchange the connection
  code by pasting it. There is no way to find an opponent.
- Profiles and career live in `localStorage` (one browser only).

## What does NOT change

Pose inference, perception, simulation and rendering stay in the browser. They
are latency-critical, and sending video to a server would break the
"video never leaves your machine" rule. Rewriting TypeScript in C# gains
nothing.

## What .NET is for

A small ASP.NET Core service, in `server/`:

1. **Matchmaking and signalling** (SignalR hub): pair two players, relay the
   WebRTC offer/answer. Fights stay peer-to-peer.
2. **Leaderboard** (minimal API) stored in Supabase Postgres via Npgsql.
3. **Telemetry** (OpenTelemetry): live traces for the talk.

Target .NET 11 (STS, GA expected November 2026). Fall back to .NET 10 (LTS,
supported to November 2028) if 11 is not final or stable by the talk. SignalR
auth refresh (finalized in .NET 11 RC1, with a TypeScript client) and OpenAPI 3.2
output by default are the features worth showing. Verify each against the final
release notes before the talk.

## Hosting

| Part | Where | Why |
| --- | --- | --- |
| Game (static React build) | Vercel | Already the plan. Fast, free HTTPS, which the camera needs. |
| .NET service | A container host with WebSocket support (Fly.io, Azure Container Apps or Railway) | To our knowledge Vercel cannot run .NET and does not keep WebSocket connections open, so SignalR can't live there. Verify before committing. |
| Database | Supabase Postgres | Already chosen. .NET talks to it with Npgsql. |
| TURN relay | Hosted TURN service | Needed on mobile data and conference Wi-Fi. |

The browser calls the .NET service by URL, so CORS must allow the Vercel domain.

## Phases

0. **Baseline:** measure frame rate and load time on a real iPhone (Safari) and
   an Android phone (Chrome), using the existing `measure:sweep` and smoke
   tools. Fix nothing before measuring.
1. **Performance and bugs** (AI-assisted loop, each fix its own small PR with
   tests): mobile camera and pose speed, load time, memory, iOS Safari quirks.
2. **Backend:** `server/` matchmaking, then leaderboard, then telemetry.
3. **Client:** "Find a match", TURN, mobile layout.
4. **Graphics and animation** (Hayden's ideas), after the road map is settled.
5. **Load test, rehearsal, recorded backup demo.**

## Mobile (iOS Safari and Android Chrome)

Known risks to test on real devices:
- Camera needs HTTPS and a tap before it starts on iOS.
- MediaPipe GPU path may be slower or fall back to CPU on phones.
- Audio needs a tap to unlock on iOS.
- Phone framing and portrait layout are not calibrated yet (see README).
- Cellular networks need TURN for peer-to-peer.

## Risks

- **Venue network:** conference Wi-Fi often blocks WebRTC. Needs TURN and a
  recorded backup.
- **Punch type detection** is ~19% from a single front camera (see README
  Status). Hit resolution doesn't depend on it, but the demo should be built
  around what works (reach, zone, dodges).
- **Webcam and lighting** in a room full of people.
- **Load:** many players at once. Load test before the day.

## Open questions

- Which container host for the .NET service (Fly.io, Azure or Railway)?
- .NET 11 or .NET 10 on the day?
