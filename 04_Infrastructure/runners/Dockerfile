FROM mcr.microsoft.com/azure-cli:2.90.0
USER root
ARG BICEP_VERSION=0.47.16
RUN tdnf install -y jq openssl shadow-utils icu \
    && tdnf clean all \
    && test "$(uname -m)" = x86_64 \
    && curl --silent --show-error --fail --location --retry 3 \
        "https://github.com/Azure/bicep/releases/download/v${BICEP_VERSION}/bicep-linux-x64" \
        --output /usr/local/bin/bicep \
    && chmod 755 /usr/local/bin/bicep \
    && useradd --uid 10001 --create-home runner \
    && az version --output json && bicep --version && python3 --version
COPY execute.py /opt/forge/execute.py
USER 10001:10001
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /workspace
ENTRYPOINT ["python3", "/opt/forge/execute.py"]
