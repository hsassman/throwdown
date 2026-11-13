using Npgsql;

namespace Throwdown.Server;

public sealed record LeaderboardEntry(string Name, int Score, DateTimeOffset At);

public interface ILeaderboardStore
{
    Task AddAsync(LeaderboardEntry entry, CancellationToken ct = default);
    Task<IReadOnlyList<LeaderboardEntry>> TopAsync(int count, CancellationToken ct = default);
}

/// <summary>Used when no database is configured (local dev, tests, a demo with no Supabase). Lost on restart.</summary>
public sealed class InMemoryLeaderboardStore : ILeaderboardStore
{
    private readonly object _lock = new();
    private readonly List<LeaderboardEntry> _entries = new();

    public Task AddAsync(LeaderboardEntry entry, CancellationToken ct = default)
    {
        lock (_lock)
        {
            _entries.Add(entry);
        }
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<LeaderboardEntry>> TopAsync(int count, CancellationToken ct = default)
    {
        lock (_lock)
        {
            IReadOnlyList<LeaderboardEntry> top = _entries
                .OrderByDescending(e => e.Score)
                .ThenBy(e => e.At)
                .Take(count)
                .ToList();
            return Task.FromResult(top);
        }
    }
}

/// <summary>Supabase (Postgres) store. The connection string comes from configuration, never from the repo.</summary>
public sealed class PostgresLeaderboardStore : ILeaderboardStore
{
    private readonly NpgsqlDataSource _db;
    private readonly SemaphoreSlim _init = new(1, 1);
    private bool _ready;

    public PostgresLeaderboardStore(NpgsqlDataSource db)
    {
        _db = db;
    }

    private async Task EnsureTableAsync(CancellationToken ct)
    {
        if (_ready) return;
        await _init.WaitAsync(ct);
        try
        {
            if (_ready) return;
            await using var cmd = _db.CreateCommand(
                """
                create table if not exists leaderboard (
                    id bigserial primary key,
                    name text not null,
                    score integer not null,
                    created_at timestamptz not null default now()
                );
                create index if not exists leaderboard_score_idx on leaderboard (score desc, created_at);
                """);
            await cmd.ExecuteNonQueryAsync(ct);
            _ready = true;
        }
        finally
        {
            _init.Release();
        }
    }

    public async Task AddAsync(LeaderboardEntry entry, CancellationToken ct = default)
    {
        await EnsureTableAsync(ct);
        await using var cmd = _db.CreateCommand("insert into leaderboard (name, score, created_at) values ($1, $2, $3)");
        cmd.Parameters.AddWithValue(entry.Name);
        cmd.Parameters.AddWithValue(entry.Score);
        cmd.Parameters.AddWithValue(entry.At);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task<IReadOnlyList<LeaderboardEntry>> TopAsync(int count, CancellationToken ct = default)
    {
        await EnsureTableAsync(ct);
        await using var cmd = _db.CreateCommand("select name, score, created_at from leaderboard order by score desc, created_at limit $1");
        cmd.Parameters.AddWithValue(count);
        var rows = new List<LeaderboardEntry>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            rows.Add(new LeaderboardEntry(reader.GetString(0), reader.GetInt32(1), reader.GetFieldValue<DateTimeOffset>(2)));
        }
        return rows;
    }
}

public sealed record ScoreSubmission(string? Name, int Score);

public static class LeaderboardRules
{
    public const int MaxNameLength = 20;
    public const int MaxScore = 100_000;
    public const int MaxTop = 50;

    /// <summary>Scores are self-reported by the browser, so this is sanity checking, not anti-cheat.</summary>
    public static bool TryValidate(ScoreSubmission? s, out LeaderboardEntry? entry, out string? error)
    {
        entry = null;
        var name = s?.Name?.Trim();
        if (string.IsNullOrEmpty(name)) { error = "Name is required."; return false; }
        if (name.Length > MaxNameLength) { error = $"Name must be at most {MaxNameLength} characters."; return false; }
        if (name.Any(char.IsControl)) { error = "Name contains invalid characters."; return false; }
        if (s!.Score < 0 || s.Score > MaxScore) { error = $"Score must be between 0 and {MaxScore}."; return false; }
        entry = new LeaderboardEntry(name, s.Score, DateTimeOffset.UtcNow);
        error = null;
        return true;
    }
}
