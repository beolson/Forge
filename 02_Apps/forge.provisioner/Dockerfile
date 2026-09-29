FROM oven/bun:1.3.14 AS build
WORKDIR /workspace
COPY package.json bun.lock ./
COPY 02_Apps/forge.app/package.json 02_Apps/forge.app/package.json
COPY 02_Apps/forge.orchistrator/package.json 02_Apps/forge.orchistrator/package.json
COPY 02_Apps/forge.provisioner/package.json 02_Apps/forge.provisioner/package.json
COPY 03_Libraries/project/package.json 03_Libraries/project/package.json
COPY 03_Libraries/automation/package.json 03_Libraries/automation/package.json
RUN bun install --frozen-lockfile
COPY 03_Libraries/project 03_Libraries/project
COPY 03_Libraries/automation 03_Libraries/automation
COPY 02_Apps/forge.provisioner 02_Apps/forge.provisioner
RUN cd 02_Apps/forge.provisioner && bun run build

FROM mcr.microsoft.com/azure-cli:2.90.0
USER root
ARG BICEP_VERSION=0.47.16
RUN tdnf install -y shadow-utils icu libstdc++ \
    && tdnf clean all \
    && test "$(uname -m)" = x86_64 \
    && curl --silent --show-error --fail --location --retry 3 \
        "https://github.com/Azure/bicep/releases/download/v${BICEP_VERSION}/bicep-linux-x64" \
        --output /usr/local/bin/bicep \
    && chmod 755 /usr/local/bin/bicep \
    && useradd --uid 10001 --create-home runner
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build /workspace/02_Apps/forge.provisioner/dist /opt/forge
COPY 02_Apps/forge.provisioner/tasks.json /opt/forge/tasks.json
COPY 02_Apps/forge.provisioner/resources /opt/forge/resources
RUN az version --output json && bicep --version && bun --version
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["bun", "/opt/forge/src/execute.js"]
