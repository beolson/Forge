import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBuilder,
  EndpointProperty,
  type ParameterResource,
  refExpr,
} from "./.aspire/modules/aspire.mjs";
import { type Configuration, loadConfiguration } from "./config.mjs";

const apphostDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(apphostDirectory, "../..");
const local = resolve(root, "04_Infrastructure/local");
const configuration = loadConfiguration(root);
const builder = await createBuilder({
  dashboardApplicationName: "Forge Local",
});

const secretNames = new Set([
  "POSTGRES_PASSWORD",
  "FORGE_DB_PASSWORD",
  "CLOUDBEAVER_ADMIN_PASSWORD",
  "SERVICEBUS_SQL_PASSWORD",
  "FORGE_ENTRA_CLIENT_SECRET",
  "FORGE_SESSION_SECRET",
  "AZURE_CLIENT_SECRET",
]);
const parameters = {} as Record<keyof Configuration, ParameterResource>;
for (const [name, value] of Object.entries(configuration)) {
  parameters[name as keyof Configuration] = await builder.addParameter(
    name.toLowerCase().replaceAll("_", "-"),
    { value, secret: secretNames.has(name) },
  );
}

const preflight = await builder.addExecutable("preflight", "bun", root, [
  "04_Infrastructure/aspire/setup.mts",
  "preflight",
]);
const network = await builder
  .addExecutable("runner-network", "bun", root, [
    "04_Infrastructure/aspire/setup.mts",
    "network",
  ])
  .waitForCompletion(preflight);
const runnerImage = await builder
  .addExecutable("runner-image", "docker", root, [
    "build",
    "--tag",
    "forge-provisioner:local",
    "--file",
    "02_Apps/forge.provisioner/Dockerfile",
    ".",
  ])
  .waitForCompletion(preflight);
const cloudbeaverSeed = await builder
  .addExecutable("cloudbeaver-seed", "python3", root, [
    "04_Infrastructure/local/write-cloudbeaver-seed.py",
  ])
  .withEnvironment("POSTGRES_PASSWORD", parameters.POSTGRES_PASSWORD)
  .waitForCompletion(preflight);

const postgres = await builder
  .addContainer("postgres", { image: "postgres", tag: "17-alpine" })
  .withContainerName("forge-aspire-postgres")
  .withContainerNetworkAlias("postgres")
  .withEnvironment("POSTGRES_USER", "postgres")
  .withEnvironment("POSTGRES_DB", "postgres")
  .withEnvironment("POSTGRES_PASSWORD", parameters.POSTGRES_PASSWORD)
  .withEnvironment("FORGE_DB_PASSWORD", parameters.FORGE_DB_PASSWORD)
  .withVolume("/var/lib/postgresql/data", { name: "forge-local_postgres_data" })
  .withBindMount(
    resolve(local, "init-databases.sh"),
    "/docker-entrypoint-initdb.d/10-init-databases.sh",
    { isReadOnly: true },
  )
  .withEndpoint({ name: "tcp", port: 5432, targetPort: 5432, isProxied: false })
  .waitForCompletion(preflight);
const postgresReady = await builder
  .addExecutable("postgres-ready", "bun", root, [
    "04_Infrastructure/aspire/setup.mts",
    "postgres",
  ])
  .waitForStart(postgres);

const sql = await builder
  .addContainer("servicebus-sql", {
    image: "mcr.microsoft.com/mssql/server",
    tag: "2022-latest",
  })
  .withContainerNetworkAlias("servicebus-sql")
  .withEnvironment("ACCEPT_EULA", parameters.SERVICEBUS_ACCEPT_EULA)
  .withEnvironment("MSSQL_SA_PASSWORD", parameters.SERVICEBUS_SQL_PASSWORD)
  .waitForCompletion(preflight);
const servicebus = await builder
  .addContainer("servicebus-emulator", {
    image: "mcr.microsoft.com/azure-messaging/servicebus-emulator",
    tag: "latest",
  })
  .withEnvironment("ACCEPT_EULA", parameters.SERVICEBUS_ACCEPT_EULA)
  .withEnvironment("SQL_SERVER", "servicebus-sql")
  .withEnvironment("MSSQL_SA_PASSWORD", parameters.SERVICEBUS_SQL_PASSWORD)
  .withEnvironment("EMULATOR_HTTP_PORT", "5300")
  .withBindMount(
    resolve(local, "servicebus-config.json"),
    "/ServiceBus_Emulator/ConfigFiles/Config.json",
    { isReadOnly: true },
  )
  .withEndpoint({
    name: "amqp",
    port: 5672,
    targetPort: 5672,
    isProxied: false,
  })
  .withHttpEndpoint({
    name: "health",
    port: 5300,
    targetPort: 5300,
    isProxied: false,
  })
  .withHttpHealthCheck({ path: "/health", endpointName: "health" })
  .waitForStart(sql);
const servicebusReady = await builder
  .addExecutable("servicebus-ready", "bun", root, [
    "04_Infrastructure/aspire/setup.mts",
    "servicebus",
  ])
  .waitForStart(servicebus);

const credentials = await builder
  .addContainer("runner-credentials", { image: "python", tag: "3.13-alpine" })
  .withVolume("/credentials", { name: "forge-local-runner-credentials" })
  .withBindMount(resolve(local, "seed-runner-credentials.py"), "/seed.py", {
    isReadOnly: true,
  })
  .withBindMount(
    configuration.GITHUB_APP_PRIVATE_KEY_PATH,
    "/input/github-app.pem",
    { isReadOnly: true },
  )
  .withArgs(["python", "/seed.py"])
  .waitForCompletion(preflight);
for (const name of [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_REGION",
  "GITHUB_ORG",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
] as const) {
  await credentials.withEnvironment(name, parameters[name]);
}

const cloudbeaverInit = await builder
  .addContainer("cloudbeaver-init", { image: "busybox", tag: "1.37.0" })
  .withContainerRuntimeArgs(["--user", "0:0"])
  .withVolume("/workspace", { name: "forge-local_cloudbeaver_data" })
  .withBindMount(
    resolve(root, ".cloudbeaver-seed.json"),
    "/seed/data-sources.json",
    { isReadOnly: true },
  )
  .withArgs([
    "sh",
    "-ec",
    [
      "mkdir -p /workspace/GlobalConfiguration/.dbeaver",
      "if [ ! -f /workspace/GlobalConfiguration/.dbeaver/data-sources.json ]; then cp /seed/data-sources.json /workspace/GlobalConfiguration/.dbeaver/data-sources.json; fi",
      "chown -R 8978:8978 /workspace",
    ].join("\n"),
  ])
  .waitForCompletion(cloudbeaverSeed);
await builder
  .addContainer("cloudbeaver", { image: "dbeaver/cloudbeaver", tag: "26.2.1" })
  .withEnvironment("CB_SERVER_NAME", "Forge Local")
  .withEnvironment("CB_SERVER_URL", "http://localhost:8081/")
  .withEnvironment("CB_ADMIN_NAME", "forgeadmin")
  .withEnvironment("CB_ADMIN_PASSWORD", parameters.CLOUDBEAVER_ADMIN_PASSWORD)
  .withEnvironment("CLOUDBEAVER_APP_ANONYMOUS_ACCESS_ENABLED", "true")
  .withEnvironment(
    "CLOUDBEAVER_APP_GRANT_CONNECTIONS_ACCESS_TO_ANONYMOUS_TEAM",
    "true",
  )
  .withHttpEndpoint({ port: 8081, targetPort: 8978, isProxied: false })
  .withVolume("/opt/cloudbeaver/workspace", {
    name: "forge-local_cloudbeaver_data",
  })
  .waitForCompletion(cloudbeaverInit)
  .waitForCompletion(postgresReady);

const pgEndpoint = await postgres.getEndpoint("tcp");
const pgHost = await pgEndpoint.property(EndpointProperty.Host);
const pgPort = await pgEndpoint.property(EndpointProperty.Port);
const amqpEndpoint = await servicebus.getEndpoint("amqp");
const amqpHost = await amqpEndpoint.property(EndpointProperty.Host);
const databasePassword = await builder.addParameter("database-url-password", {
  value: encodeURIComponent(configuration.FORGE_DB_PASSWORD),
  secret: true,
});
const database = refExpr`postgresql://forge:${databasePassword}@${pgHost}:${pgPort}/forge`;
const bus = refExpr`Endpoint=sb://${amqpHost};SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;`;

const orchestrator = await builder
  .addDockerfile("orchestrator", root, {
    dockerfilePath: "02_Apps/forge.orchistrator/Dockerfile",
  })
  .withContainerName("forge-aspire-orchestrator")
  .withEnvironment("DBOS_SYSTEM_DATABASE_URL", database)
  .withEnvironment("SERVICEBUS_CONNECTION_STRING", bus)
  .withEnvironment("RUNNER_IMAGE", "forge-provisioner:local")
  .withEnvironment("RUNNER_DATA_VOLUME", "forge-local-runner-data")
  .withEnvironment("RUNNER_CREDENTIAL_VOLUME", "forge-local-runner-credentials")
  .withEnvironment("RUNNER_NETWORK", "forge-local_default")
  .withVolume("/var/lib/forge/runners", { name: "forge-local-runner-data" })
  .withBindMount("/var/run/docker.sock", "/var/run/docker.sock")
  .waitForCompletion(network)
  .waitForCompletion(runnerImage)
  .waitForCompletion(credentials)
  .waitForCompletion(postgresReady)
  .waitForCompletion(servicebusReady);
for (const name of [
  "RUNNER_TASK_TIMEOUT_MS",
  "RUNNER_LOG_RETENTION_DAYS",
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_REGION",
  "GITHUB_ORG",
] as const) {
  await orchestrator.withEnvironment(name, parameters[name]);
}

const forge = await builder
  .addViteApp("forge", resolve(root, "02_Apps/forge"))
  .withBun({ install: false })
  .withEndpointCallback("http", async (endpoint) => {
    await endpoint.port.set(5321);
    await endpoint.targetPort.set(5321);
    await endpoint.isProxied.set(false);
  })
  .withEnvironment("DATABASE_URL", database)
  .withEnvironment("SERVICEBUS_CONNECTION_STRING", bus)
  .waitForCompletion(postgresReady)
  .waitForCompletion(servicebusReady);
for (const name of [
  "FORGE_ENTRA_TENANT_ID",
  "FORGE_ENTRA_CLIENT_ID",
  "FORGE_ENTRA_CLIENT_SECRET",
  "FORGE_AUTH_REDIRECT_URI",
  "FORGE_SESSION_SECRET",
  "FORGE_ADMIN_GROUP_ID",
  "AZURE_SUBSCRIPTION_ID",
  "GITHUB_ORG",
  "RUNNER_LOG_RETENTION_DAYS",
] as const) {
  await forge.withEnvironment(name, parameters[name]);
}
// Host processes inherit the CLI's environment. Provider credentials belong only
// in the seeding job and privileged task containers, even when Bun loads .env.
for (const name of [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "POSTGRES_PASSWORD",
  "FORGE_DB_PASSWORD",
  "CLOUDBEAVER_ADMIN_PASSWORD",
  "SERVICEBUS_SQL_PASSWORD",
]) {
  await forge.withEnvironment(name, "");
}

await builder.build().run();
