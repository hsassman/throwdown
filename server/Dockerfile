# Build context: the server/ folder.
#   docker build -t throwdown-server server
# The .NET version is an argument so we can fall back to 10.0 (LTS) if 11.0 images are not available:
#   docker build --build-arg DOTNET=10.0 ...  (and set TargetFramework to net10.0)
ARG DOTNET=11.0

FROM mcr.microsoft.com/dotnet/sdk:${DOTNET} AS build
WORKDIR /src
COPY Throwdown.Server/Throwdown.Server.csproj Throwdown.Server/
RUN dotnet restore Throwdown.Server/Throwdown.Server.csproj
COPY Throwdown.Server/ Throwdown.Server/
RUN dotnet publish Throwdown.Server/Throwdown.Server.csproj -c Release -o /out --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:${DOTNET}
WORKDIR /app
COPY --from=build /out .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "Throwdown.Server.dll"]
