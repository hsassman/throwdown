# Plan: online matchmaking with .NET

Status: **proposal, nothing built yet.** Goal: a live, playable demo at a
15-minute conference talk, where the audience opens a link and fights each other.

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
2. **Leaderboard** (minimal API): store and list results.
3. **Telemetry** (OpenTelemetry): live traces for the talk.

Target .NET 11 (STS, GA expected November 2026). Fall back to .NET 10 (LTS,
supported to November 2028) if 11 is not final or stable by the talk. SignalR
auth refresh (finalized in .NET 11 RC1, with a TypeScript client) and OpenAPI 3.2
output by default are the features worth showing. Verify each against the final
release notes before the talk.

## Rule change

`docs/ARCHITECTURE.md` says "client-side only, no server, not even a signalling
one". This plan reopens that rule narrowly: a server may exist for
matchmaking and scores only. Video and pose landmarks stay peer-to-peer. The
rule is amended in the PR that adds the service.

## Steps

1. Docs: README fix and this plan (this PR).
2. `server/`: SignalR matchmaking hub, tests, own CI job.
3. Browser client: replace the paste-a-code step with "Find a match", behind one
   small module in `src/net/`.
4. TURN relay so WebRTC works on conference Wi-Fi.
5. Leaderboard and OpenTelemetry.
6. Load test, rehearsal, recorded backup demo.

## Risks

- **Venue network:** conference Wi-Fi often blocks WebRTC. Needs TURN and a
  recorded backup.
- **Punch type detection** is ~19% from a single front camera (see README
  Status). Hit resolution doesn't depend on it, but the demo should be built
  around what works (reach, zone, dodges).
- **Webcam and lighting** in a room full of people.
- **Load:** many players at once. Load test before the day.
- **Hosting:** needs a public HTTPS host that stays up.

## Open questions

- Where is the service hosted?
- Is a database acceptable, or is an in-memory leaderboard enough for the demo?
- .NET 11 or .NET 10 on the day?
