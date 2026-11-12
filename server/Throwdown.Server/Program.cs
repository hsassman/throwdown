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

var app = builder.Build();

app.UseCors();

app.MapGet("/", () => "Hello World!");
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.MapHub<MatchmakingHub>("/hubs/matchmaking");

app.Run();

public partial class Program { }
