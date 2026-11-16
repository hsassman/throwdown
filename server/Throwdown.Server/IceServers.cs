namespace Throwdown.Server;

public sealed class IceServerOptions
{
    public List<IceServer> Servers { get; set; } = new();
}

public sealed class IceServer
{
    public List<string> Urls { get; set; } = new();
    public string? Username { get; set; }
    public string? Credential { get; set; }
}
