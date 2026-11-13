# Deploying

Three pieces: the game on **Vercel**, the .NET server on **Fly.io**, and the
leaderboard database on **Supabase**. Do them in this order, because each one
needs a URL from the one before.

Fly.io is the default because it keeps WebSocket (SignalR) connections open
and deploys straight from `server/Dockerfile`. Azure Container Apps or Railway
work too: they need the same Dockerfile, port 8080 and the same environment
variables.

## 1. Supabase (database)

1. In the Supabase project, open the SQL editor and run
   [`server/sql/leaderboard.sql`](../server/sql/leaderboard.sql).
2. Copy the Postgres connection string (Project settings, Database). Use the
   **session** pooler or the direct connection, not the transaction pooler:
   Npgsql's prepared statements need a session.
3. Keep it private. It goes into Fly as a secret in step 2, never into the repo
   or chat.

## 2. Fly.io (server)

```bash
cd server
fly auth login
fly apps create throwdown-server        # or another name; update fly.toml to match
fly secrets set ConnectionStrings__Leaderboard="<Supabase connection string>"
fly secrets set Cors__AllowedOrigins__0="https://<your-vercel-domain>"
fly deploy
```

Check it: `https://throwdown-server.fly.dev/health` should return
`{"status":"ok"}`.

To deploy from GitHub instead, add a `FLY_API_TOKEN` repository secret
(`fly tokens create deploy`) and run the **Deploy server** workflow from the
Actions tab. It only runs when started by hand.

Keep **one machine**. Matchmaking is in memory, so two machines would each
have their own queue. `fly.toml` already sets this.

### TURN (when a provider is chosen)

Add the provider's servers as secrets, for example:

```bash
fly secrets set Ice__Servers__0__Urls__0="stun:stun.l.google.com:19302"
fly secrets set Ice__Servers__1__Urls__0="turn:<host>:3478"
fly secrets set Ice__Servers__1__Username="<user>" Ice__Servers__1__Credential="<password>"
```

The browser reads these from `/ice-servers`. Nothing changes in the client.

## 3. Vercel (game)

1. Import the repo in Vercel. `vercel.json` sets the Vite build and output.
2. Add an environment variable:
   `VITE_MATCHMAKING_URL = https://throwdown-server.fly.dev/hubs/matchmaking`
3. Deploy. Then make sure the Vercel domain is in the server's
   `Cors__AllowedOrigins__0` (step 2), or "Find a match" and the leaderboard
   will be blocked by the browser.

Vite bakes `VITE_` variables in at build time, so redeploy Vercel after
changing it.

## Checks after deploying

- `/health` on the server returns ok.
- Open the Vercel URL on two devices, choose Online, "Find a match" on both.
- Finish a CPU fight and save a score; it appears in the leaderboard and in
  the Supabase table.
- Server traces show in `fly logs` (console telemetry is on in `fly.toml`).
