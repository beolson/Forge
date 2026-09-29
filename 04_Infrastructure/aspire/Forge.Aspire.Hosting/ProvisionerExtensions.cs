using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Forge.Aspire.Hosting;

[AspireExport]
public sealed class ForgeProvisionerResource(string name) : Resource(name);

public static class ProvisionerExtensions
{
    /// <summary>Observes DBOS-owned Docker tasks without taking over their lifecycle.</summary>
    [AspireExport]
    public static IResourceBuilder<ForgeProvisionerResource> AddForgeProvisioner(
        this IDistributedApplicationBuilder builder, [ResourceName] string name,
        string dockerSocket = "/var/run/docker.sock")
    {
        var resource = new ForgeProvisionerResource(name);
        var result = builder.AddResource(resource)
            .WithInitialState(new CustomResourceSnapshot
            {
                ResourceType = "Provisioner",
                State = new("Starting", "info"),
                Properties = [new("ownership", "DBOS launches and recovers task containers")]
            })
            .ExcludeFromManifest();
        builder.Services.AddSingleton<IHostedService>(services => new ProvisionerObserver(
            resource, new DockerClient(dockerSocket),
            services.GetRequiredService<ResourceNotificationService>(),
            services.GetRequiredService<ResourceLoggerService>()));
        return result;
    }
}
