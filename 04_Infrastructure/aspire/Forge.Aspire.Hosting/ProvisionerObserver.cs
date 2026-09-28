using System.Text.Json;
using System.Text.RegularExpressions;
using Aspire.Hosting.ApplicationModel;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Forge.Aspire.Hosting;

internal sealed class ProvisionerObserver(
    ForgeProvisionerResource parent, DockerClient docker,
    ResourceNotificationService notifications, ResourceLoggerService loggers) : BackgroundService
{
    private sealed class TaskResource(string name) : Resource(name)
    {
        public LogCursor Cursor { get; } = new();
        public bool LogsComplete { get; set; }
        public bool LogsUnavailable { get; set; }
    }

    private readonly Dictionary<string, TaskResource> tasks = [];
    private bool unavailable;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Observe(stoppingToken);
                unavailable = false;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch
            {
                if (!unavailable) loggers.GetLogger(parent).LogWarning("Docker task observation unavailable; retrying. DBOS continues managing execution.");
                unavailable = true;
                await notifications.PublishUpdateAsync(parent, s => s with { State = new("Unavailable", "warn") });
                foreach (var task in tasks.Values.Where(t => !t.LogsComplete))
                    await notifications.PublishUpdateAsync(task, s => s with { State = new("Unknown", "warn") });
            }
            try { await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
        }
    }

    internal async Task Observe(CancellationToken token)
    {
        var containers = await docker.List(token);
        var present = new HashSet<string>();
        var running = 0;
        foreach (var summary in containers.EnumerateArray())
        {
            var labels = summary.GetProperty("Labels");
            var runId = Label(labels, "forge.runId");
            if (!Regex.IsMatch(runId, "^[a-f0-9]{32}$")) continue;
            var id = summary.GetProperty("Id").GetString()!;
            present.Add(id);
            if (!tasks.TryGetValue(id, out var resource))
            {
                var label = Label(labels, "forge.projectCode");
                var task = Label(labels, "forge.taskId");
                var prefix = Regex.Replace($"{label}-{task}".ToLowerInvariant(), "[^a-z0-9-]", "-").Trim('-');
                var name = $"{parent.Name}-{(prefix.Length > 0 ? prefix[..Math.Min(prefix.Length, 48)] + "-" : "")}{runId}";
                resource = new TaskResource(name);
                resource.Annotations.Add(new ResourceRelationshipAnnotation(parent, "Parent"));
                tasks.Add(id, resource);
            }
            try
            {
                var inspected = await docker.ReadJson($"containers/{id}/json", token);
                var state = inspected.GetProperty("State");
                var status = DescribeState(state);
                if (status.Text == "Running") running++;
                await notifications.PublishUpdateAsync(resource, _ => new CustomResourceSnapshot
                {
                    ResourceType = "ProvisionerTask",
                    State = status,
                    CreationTimeStamp = Timestamp(inspected, "Created"),
                    StartTimeStamp = Timestamp(state, "StartedAt"),
                    StopTimeStamp = Timestamp(state, "FinishedAt"),
                    ExitCode = state.GetProperty("Status").GetString() == "exited" ? state.GetProperty("ExitCode").GetInt32() : null,
                    Relationships = [new(parent.Name, "Parent")],
                    Properties = [
                        new("resource.parentName", parent.Name),
                        new("container", summary.GetProperty("Names")[0].GetString()!.TrimStart('/')),
                        new("runId", runId), new("projectId", Label(labels, "forge.projectId")),
                        new("projectCode", Label(labels, "forge.projectCode")),
                        new("projectAttempt", Label(labels, "forge.projectAttempt")),
                        new("task", Label(labels, "forge.taskId")), new("taskAttempt", Label(labels, "forge.taskAttempt")),
                        new("operation", Label(labels, "forge.operation")), new("resource", Label(labels, "forge.resource")),
                        new("image", inspected.GetProperty("Config").GetProperty("Image").GetString()!),
                        new("ownership", "Observed Docker task; lifecycle managed by DBOS")
                    ]
                });
                if (!resource.LogsComplete)
                {
                    var logger = loggers.GetLogger(resource);
                    try
                    {
                        await docker.ReadLogs(id, resource.Cursor, line => logger.Log(
                            line.IsError ? LogLevel.Error : LogLevel.Information, "{Output}", line.Text), token);
                        resource.LogsUnavailable = false;
                    }
                    catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
                    catch
                    {
                        if (!resource.LogsUnavailable) logger.LogWarning("Task console output temporarily unavailable; retrying.");
                        resource.LogsUnavailable = true;
                        continue; // Preserve the known task state while retrying logs.
                    }
                    if (state.GetProperty("Status").GetString() == "exited")
                    {
                        resource.LogsComplete = true;
                        loggers.Complete(resource);
                    }
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
            catch
            {
                await notifications.PublishUpdateAsync(resource, s => s with { State = new("Unknown", "warn") });
            }
        }
        foreach (var (id, task) in tasks.Where(t => !present.Contains(t.Key)).ToArray())
        {
            await notifications.PublishUpdateAsync(task, s => s with { IsHidden = true });
            loggers.Complete(task);
            tasks.Remove(id);
        }
        await notifications.PublishUpdateAsync(parent, s => s with
        {
            State = new("Running", null),
            Properties = [new("activeTasks", running), new("retainedTasks", tasks.Count),
                new("ownership", "DBOS launches and recovers task containers")]
        });
    }

    internal static ResourceStateSnapshot DescribeState(JsonElement state) => state.GetProperty("Status").GetString() switch
    {
        "running" => new("Running", null),
        "created" => new("Queued", "info"),
        "exited" => state.GetProperty("ExitCode").GetInt32() == 0 ? new("Succeeded", "success") : new("Failed", "error"),
        "paused" => new("Paused", "warn"),
        _ => new("Unknown", "warn")
    };

    private static string Label(JsonElement labels, string key) => labels.TryGetProperty(key, out var value) ? value.GetString() ?? "" : "";
    private static DateTime? Timestamp(JsonElement value, string key) =>
        value.TryGetProperty(key, out var date) && DateTimeOffset.TryParse(date.GetString(), out var parsed) && parsed.Year > 1
            ? parsed.UtcDateTime : null;

    public override void Dispose() { docker.Dispose(); base.Dispose(); }
}
