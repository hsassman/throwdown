using System.Threading.RateLimiting;
using Microsoft.Extensions.Options;
using Npgsql;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Throwdown.Server;

var builder = WebApplication.CreateBuilder(args);

var allowedOrigins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>() ?? [];
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.WithOrigins(allowedOrigins).AllowAnyHeader().AllowAnyMethod());
});

builder.Services.AddSignalR();
builder.Services.AddSingleton<MatchmakingQueue>();

// Leaderboard: Supabase Postgres when ConnectionStrings:Leaderboard is set, otherwise in memory.
var leaderboardConnection = builder.Configuration.GetConnectionString("Leaderboard");
if (!string.IsNullOrWhiteSpace(leaderboardConnection))
{
    builder.Services.AddSingleton(NpgsqlDataSource.Create(leaderboardConnection));
    builder.Services.AddSingleton<ILeaderboardStore, PostgresLeaderboardStore>();
}
else
{
    builder.Services.AddSingleton<ILeaderboardStore, InMemoryLeaderboardStore>();
}

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy("score-submit", ctx =>
        RateLimitPartition.GetFixedWindowLimiter(
            ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            _ => new FixedWindowRateLimiterOptions { PermitLimit = 10, Window = TimeSpan.FromMinutes(1) }));
});

builder.Services.Configure<IceServerOptions>(builder.Configuration.GetSection("Ice"));

// Telemetry: traces for HTTP requests and SignalR hub calls. Console output by default so it can be shown live;
// set Telemetry:OtlpEndpoint to send to a collector instead.
var otlpEndpoint = builder.Configuration["Telemetry:OtlpEndpoint"];
builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("throwdown-server"))
    .WithTracing(t =>
    {
        t.AddAspNetCoreInstrumentation()
         .AddSource("Microsoft.AspNetCore.SignalR.Server");
        if (!string.IsNullOrWhiteSpace(otlpEndpoint))
        {
            t.AddOtlpExporter(o => o.Endpoint = new Uri(otlpEndpoint));
        }
        else if (builder.Configuration.GetValue("Telemetry:Console", false))
        {
            t.AddConsoleExporter();
        }
    });

var app = builder.Build();

app.UseCors();
app.UseRateLimiter();

app.MapGet("/", () => "Hello World!");
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.MapHub<MatchmakingHub>("/hubs/matchmaking");

app.MapGet("/ice-servers", (IOptions<IceServerOptions> options) =>
    Results.Ok(options.Value.Servers.Select(s => new { urls = s.Urls, username = s.Username, credential = s.Credential })));

app.MapGet("/leaderboard", async (ILeaderboardStore store, int? top, CancellationToken ct) =>
{
    var count = Math.Clamp(top ?? 10, 1, LeaderboardRules.MaxTop);
    return Results.Ok(await store.TopAsync(count, ct));
});

app.MapPost("/leaderboard", async (ScoreSubmission submission, ILeaderboardStore store, CancellationToken ct) =>
{
    if (!LeaderboardRules.TryValidate(submission, out var entry, out var error))
    {
        return Results.BadRequest(new { error });
    }
    await store.AddAsync(entry!, ct);
    return Results.Created("/leaderboard", entry);
}).RequireRateLimiting("score-submit");

app.Run();

public partial class Program { }
