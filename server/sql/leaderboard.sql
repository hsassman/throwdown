-- Leaderboard table for Supabase. Run once in the Supabase SQL editor.
-- The server also creates this table on first use, so this is optional, but
-- running it yourself lets you turn on row level security first.

create table if not exists public.leaderboard (
    id bigserial primary key,
    name text not null check (char_length(name) between 1 and 20),
    score integer not null check (score between 0 and 100000),
    created_at timestamptz not null default now()
);

create index if not exists leaderboard_score_idx
    on public.leaderboard (score desc, created_at);

-- Only the .NET server writes and reads this table, using the database
-- connection string. Row level security with no policies blocks the public
-- Supabase API keys (anon/publishable) from touching it, so nobody can
-- bypass the server's validation and rate limit by calling Supabase directly.
alter table public.leaderboard enable row level security;
