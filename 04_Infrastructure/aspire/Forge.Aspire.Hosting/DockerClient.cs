using System.Buffers.Binary;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace Forge.Aspire.Hosting;

// Deliberately GET-only: the observer cannot launch, stop, restart, or remove tasks.
internal sealed class DockerClient : IDisposable
{
    private readonly HttpClient client;

    public DockerClient(string socket)
    {
        client = new HttpClient(new SocketsHttpHandler
        {
            ConnectCallback = async (_, token) =>
            {
                var connection = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                try
                {
                    await connection.ConnectAsync(new UnixDomainSocketEndPoint(socket), token);
                    return new NetworkStream(connection, ownsSocket: true);
                }
                catch { connection.Dispose(); throw; }
            }
        }) { BaseAddress = new Uri("http://docker/v1.45/"), Timeout = TimeSpan.FromSeconds(10) };
    }

    internal DockerClient(HttpClient client) => this.client = client;

    public async Task<JsonElement> ReadJson(string path, CancellationToken token)
    {
        using var response = await client.GetAsync(path, token);
        response.EnsureSuccessStatusCode();
        using var json = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(token), cancellationToken: token);
        return json.RootElement.Clone();
    }

    public Task<JsonElement> List(CancellationToken token) => ReadJson(
        "containers/json?all=1&filters=" + Uri.EscapeDataString("{\"label\":[\"forge.runId\"]}"), token);

    public async Task ReadLogs(string id, LogCursor cursor, Action<RunnerLog> emit, CancellationToken token)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        token = timeout.Token;
        var query = cursor.Timestamp is null ? "tail=200" : "since=" + cursor.Since;
        using var response = await client.GetAsync($"containers/{id}/logs?stdout=1&stderr=1&timestamps=1&{query}",
            HttpCompletionOption.ResponseHeadersRead, token);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(token);
        await ReadFrames(stream, cursor, emit, token);
    }

    internal static async Task ReadFrames(Stream stream, LogCursor cursor, Action<RunnerLog> emit, CancellationToken token)
    {
        var header = new byte[8];
        var lines = new Dictionary<byte, StringBuilder>();
        // Docker timestamps are RFC3339Nano. Preserve the string rather than rounding to milliseconds.
        var previous = cursor.Timestamp;
        var previousCount = cursor.Count;
        var seenAtPrevious = 0;
        while (await stream.ReadAsync(header.AsMemory(0, 1), token) != 0)
        {
            await stream.ReadExactlyAsync(header.AsMemory(1), token);
            var length = BinaryPrimitives.ReadUInt32BigEndian(header.AsSpan(4));
            if (length > 1_048_576 || header[0] is not (1 or 2)) throw new InvalidDataException("Invalid Docker log frame");
            var payload = new byte[(int)length];
            await stream.ReadExactlyAsync(payload, token);
            if (!lines.TryGetValue(header[0], out var pending)) lines[header[0]] = pending = new StringBuilder();
            pending.Append(Encoding.UTF8.GetString(payload));
            if (pending.Length > 1_048_576) throw new InvalidDataException("Docker log line is too large");
            var text = pending.ToString();
            var start = 0;
            for (var end = text.IndexOf('\n'); end >= 0; end = text.IndexOf('\n', start))
            {
                var line = text[start..end];
                start = end + 1;
                var boundary = line.IndexOf(' ');
                if (boundary < 0) continue;
                var timestamp = line[..boundary];
                if (!DateTimeOffset.TryParse(timestamp, out _)) continue;
                timestamp = NormalizeTimestamp(timestamp);
                var comparison = previous is null ? 1 : string.CompareOrdinal(timestamp, previous);
                if (comparison < 0 || comparison == 0 && ++seenAtPrevious <= previousCount) continue;
                emit(ParseLog(line[(boundary + 1)..]));
                cursor.Accept(timestamp);
            }
            pending.Clear().Append(text[start..]);
        }
    }

    private static string NormalizeTimestamp(string timestamp)
    {
        // Docker uses UTC RFC3339Nano with optional trailing fractional zeroes.
        var fraction = timestamp.IndexOf('.');
        return fraction < 0 ? timestamp.TrimEnd('Z') + ".000000000Z"
            : timestamp[..(fraction + 1)] + timestamp[(fraction + 1)..].TrimEnd('Z').PadRight(9, '0') + "Z";
    }

    private static RunnerLog ParseLog(string text)
    {
        try
        {
            using var json = JsonDocument.Parse(text);
            if (json.RootElement.ValueKind == JsonValueKind.Object &&
                json.RootElement.TryGetProperty("text", out var message) && message.ValueKind == JsonValueKind.String &&
                json.RootElement.TryGetProperty("stream", out var stream) && stream.ValueKind == JsonValueKind.String)
            {
                var content = message.GetString()!;
                return new RunnerLog(content[..Math.Min(content.Length, 8192)], stream.GetString() == "stderr");
            }
        }
        catch (JsonException) { }
        // Only forward the executor's redacted records, never arbitrary provider output.
        return new RunnerLog("Unstructured runner output omitted; consult the Forge admin run log.", false);
    }

    public void Dispose() => client.Dispose();
}

internal sealed class LogCursor
{
    public string? Timestamp { get; private set; }
    public int Count { get; private set; }
    public long Since => DateTimeOffset.Parse(Timestamp!).ToUnixTimeSeconds();
    public void Accept(string timestamp)
    {
        if (Timestamp == timestamp) Count++;
        else { Timestamp = timestamp; Count = 1; }
    }
}

internal sealed record RunnerLog(string Text, bool IsError);
