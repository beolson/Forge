FROM semaphoreui/semaphore:v2.19.12 AS azure-cli
USER root
ARG AZURE_CLI_VERSION=2.90.0
RUN apk add --no-cache build-base libffi-dev openssl-dev python3-dev cargo \
    && python3 -m venv /opt/azure-cli \
    && /opt/azure-cli/bin/pip install --no-cache-dir "azure-cli==${AZURE_CLI_VERSION}"

FROM semaphoreui/semaphore:v2.19.12
USER root
ARG BICEP_VERSION=0.47.16
RUN apk add --no-cache openssl jq curl libffi libstdc++ icu-libs \
    && test "$(uname -m)" = x86_64 \
    && curl --fail --location --retry 3 \
        "https://github.com/Azure/bicep/releases/download/v${BICEP_VERSION}/bicep-linux-musl-x64" \
        --output /usr/local/bin/bicep \
    && chmod 755 /usr/local/bin/bicep
COPY --from=azure-cli /opt/azure-cli /opt/azure-cli
RUN ln -s /opt/azure-cli/bin/az /usr/local/bin/az \
    && az version --output json \
    && bicep --version
USER 1001
