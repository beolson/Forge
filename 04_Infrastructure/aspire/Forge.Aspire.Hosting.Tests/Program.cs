using System.Buffers.Binary;
using System.Net;
using System.Text;
using System.Text.Json;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Forge.Aspire.Hosting;
using Microsoft.Extensions.DependencyInjection;

static void Check(bool condition, string message)
{
    if (!condition) throw new Exception(message);
}

static byte[] Frame(string line, byte stream = 1)
{
    var bytes = Encoding.UTF8.GetBytes(line);
    var frame = new byte[8 + bytes.Length];
    frame[0] = stream;
    BinaryPrimitives.WriteUInt32BigEndian(frame.AsSpan(4), (uint)bytes.Length);
    bytes.CopyTo(frame, 8);
    return frame;
}

var timestamp = "2026-09-28T10:00:00.123456789Z";
var stdout = Frame(timestamp + " {\"stream\":\"stdout\",\"text\":\"redacted output\"}\n");
var stderr = Frame(timestamp + " {\"stream\":\"stderr\",\"text\":\"diagnostic\"}\n", 2);
var lines = new List<RunnerLog>();
var cursor = new LogCursor();
await DockerClient.ReadFrames(new MemoryStream([.. stdout, .. stderr]), cursor, lines.Add, default);
await DockerClient.ReadFrames(new MemoryStream([.. stdout, .. stderr]), cursor, lines.Add, default);
Check(lines.Count == 2 && lines[1].IsError, "stdout/stderr or overlap deduplication failed");
await DockerClient.ReadFrames(new MemoryStream([.. stdout, .. stderr, .. stderr]), cursor, lines.Add, default);
Check(lines.Count == 3, "identical logs at the same nanosecond must not be dropped");
await DockerClient.ReadFrames(new MemoryStream(Frame("2026-09-28T10:00:01.000000000Z provider-secret\n")), cursor, lines.Add, default);
Check(!lines[^1].Text.Contains("provider-secret"), "unstructured provider output leaked");
await DockerClient.ReadFrames(new MemoryStream(Frame("2026-09-28T10:00:02.12Z {\"stream\":\"stdout\",\"text\":\"first\"}\n")), cursor, lines.Add, default);
await DockerClient.ReadFrames(new MemoryStream(Frame("2026-09-28T10:00:02.123Z {\"stream\":\"stdout\",\"text\":\"later\"}\n")), cursor, lines.Add, default);
Check(lines[^1].Text == "later", "variable timestamp precision lost new output");
await DockerClient.ReadFrames(new MemoryStream([
    .. Frame("2026-09-28T10:00:03Z []\n"),
    .. Frame("2026-09-28T10:00:04Z null\n"),
    .. Frame("2026-09-28T10:00:05Z 123\n"),
    .. Frame("2026-09-28T10:00:06Z {\"stream\":\"stdout\",\"text\":\"continued\"}\n")
]), cursor, lines.Add, default);
Check(lines[^1].Text == "continued" && lines[^2].Text.Contains("omitted"), "unstructured JSON blocked subsequent logs");
Console.WriteLine("PASS multiplexed redacted logs, nanosecond overlap, and repeated identical lines");

var builder = DistributedApplication.CreateBuilder(new DistributedApplicationOptions { Args = [], DisableDashboard = true });
var parent = builder.AddForgeProvisioner("forge-provisioner").Resource;
await using var app = builder.Build();
var notifications = app.Services.GetRequiredService<ResourceNotificationService>();
var loggers = app.Services.GetRequiredService<ResourceLoggerService>();
var handler = new FakeDocker(stdout);
using var observer = new ProvisionerObserver(parent, new DockerClient(new HttpClient(handler)
{
    BaseAddress = new Uri("http://docker/v1.45/")
}), notifications, loggers);

var name = "forge-provisioner-example-azure-create-" + FakeDocker.RunId;
await observer.Observe(default);
Check(notifications.TryGetCurrentState(name, out var current) && current.Snapshot.State?.Text == "Running", "task missing or not running");
Check(current!.Snapshot.Relationships.Any(r => r.Type == "Parent" && r.ResourceName == parent.Name), "task parent is missing");
Check(current.Snapshot.Properties.Any(p => p.Name == "resource.parentName" && Equals(p.Value, parent.Name)), "dashboard task nesting is missing");
Check(!current.Snapshot.EnvironmentVariables.Any() && !current.Snapshot.Properties.Any(p => p.Name == "secret"), "container environment leaked");
var contents = new List<string>();
using var logTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
await using (var stream = loggers.WatchAsync(name).GetAsyncEnumerator(logTimeout.Token))
{
    Check(await stream.MoveNextAsync(), "task console log stream is missing");
    contents.AddRange(stream.Current.Select(line => line.Content));
}
Check(contents.Count == 1 && contents[0].Contains("redacted output"), "task console logs missing");
handler.ExitCode = 0;
await observer.Observe(default);
Check(notifications.TryGetCurrentState(name, out current) && current.Snapshot.State?.Text == "Succeeded" && current.Snapshot.ExitCode == 0, "success state missing");

// A fresh observer reconstructs retained runs after an AppHost restart.
var restartBuilder = DistributedApplication.CreateBuilder(new DistributedApplicationOptions { Args = [], DisableDashboard = true });
var restartParent = restartBuilder.AddForgeProvisioner("forge-provisioner").Resource;
await using var restartedApp = restartBuilder.Build();
var restartedNotifications = restartedApp.Services.GetRequiredService<ResourceNotificationService>();
using var restarted = new ProvisionerObserver(restartParent, new DockerClient(new HttpClient(handler)
{
    BaseAddress = new Uri("http://docker/v1.45/")
}), restartedNotifications, restartedApp.Services.GetRequiredService<ResourceLoggerService>());
handler.ExitCode = 1;
await restarted.Observe(default);
Check(restartedNotifications.TryGetCurrentState(name, out current) && current.Snapshot.State?.Text == "Failed" && current.Snapshot.ExitCode == 1, "retained failure not recovered");
handler.Present = false;
await restarted.Observe(default);
Check(restartedNotifications.TryGetCurrentState(name, out current) && current.Snapshot.IsHidden, "pruned container entry remains visible");
Check(handler.Methods.All(m => m == HttpMethod.Get), "observer attempted a Docker mutation");
Console.WriteLine("PASS dynamic task discovery, parent, console logs, success/failure, restart recovery, pruning, and GET-only Docker access");

sealed class FakeDocker(byte[] logs) : HttpMessageHandler
{
    public const string RunId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    public int? ExitCode { get; set; }
    public bool Present { get; set; } = true;
    public List<HttpMethod> Methods { get; } = [];

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Methods.Add(request.Method);
        var path = request.RequestUri!.AbsolutePath;
        object body = path.EndsWith("/json") && !path.Contains("/containers/json")
            ? new
            {
                Config = new { Image = "sha256:pinned", Env = new[] { "secret=never-copy" } },
                Created = "2026-09-28T10:00:00Z",
                State = new { Status = ExitCode.HasValue ? "exited" : "running", ExitCode = ExitCode ?? 0, StartedAt = "2026-09-28T10:00:00Z", FinishedAt = "0001-01-01T00:00:00Z" }
            }
            : Present ? new object[] { new
            {
                Id = "container-id", Names = new[] { "/forge-run-" + RunId },
                Labels = new Dictionary<string, string> { ["forge.runId"] = RunId, ["forge.projectId"] = "project-id", ["forge.projectCode"] = "EXAMPLE", ["forge.taskId"] = "azure-create" }
            } } : [];
        var response = new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = path.EndsWith("/logs") ? new ByteArrayContent(logs) : new StringContent(JsonSerializer.Serialize(body))
        };
        return Task.FromResult(response);
    }
}
