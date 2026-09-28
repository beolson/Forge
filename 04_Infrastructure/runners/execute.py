"""Trusted image entrypoint: execute one pinned task and emit redacted JSON logs."""
import base64
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading


def redactor(environment, key_file=None):
    secrets = [value for name, value in environment.items()
               if value and any(word in name for word in ("SECRET", "PASSWORD", "TOKEN", "CONNECTION_STRING"))]
    if key_file and Path(key_file).is_file():
        secrets.extend(line.strip() for line in Path(key_file).read_text().splitlines() if line.strip())
    secrets.sort(key=len, reverse=True)

    def redact(text):
        for value in secrets:
            text = text.replace(value, "[REDACTED]")
        text = re.sub(r"\b(?:gh[opsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b", "[REDACTED]", text)
        text = re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b", "[REDACTED]", text)
        return text
    return redact


def main():
    project = json.loads(Path("request.json").read_text())
    task = json.loads(Path("task.json").read_text())
    environment = dict(os.environ)
    credentials = json.loads(Path("/run/secrets/forge/providers.json").read_text())
    if task["runner"] != "privileged":
        raise RuntimeError("Project-scoped tasks are not enabled yet")
    prefix = "AZURE_" if task["resource"] == "azure" else "GITHUB_"
    environment.update({key: value for key, value in credentials.items() if key.startswith(prefix)})
    settings = json.loads(Path("settings.json").read_text())
    if task["resource"] == "azure":
        environment["AZURE_SUBSCRIPTION_ID"] = settings["azureSubscriptionId"]
        environment["AZURE_REGION"] = settings["azureRegion"]
    else:
        environment["GITHUB_ORG"] = settings["githubOrganization"]
    if task["resource"] == "github":
        environment["GITHUB_APP_PRIVATE_KEY_FILE"] = "/run/secrets/forge/github-app.pem"
    environment["PYTHONUNBUFFERED"] = "1"
    redact = redactor(environment, environment.get("GITHUB_APP_PRIVATE_KEY_FILE"))
    lock = threading.Lock()

    def log(stream, text):
        with lock:
            print(json.dumps({"timestamp": datetime.now(timezone.utc).isoformat(),
                              "stream": stream, "text": redact(text)}), flush=True)

    payload = base64.b64encode(json.dumps(project).encode()).decode()
    command = ["bash" if task["runtime"] == "bash" else "python3", task["entrypoint"], payload]
    log("system", f"Starting {task['name']}")
    child = subprocess.Popen(command, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, bufsize=1, start_new_session=True)

    def stop(signum, _frame):
        try:
            os.killpg(child.pid, signum)
        except ProcessLookupError:
            pass
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def forward(pipe, stream):
        while text := pipe.readline(8192):
            if len(text) == 8192 and not text.endswith("\n"):
                # Avoid exposing fragments of a credential across a record boundary.
                while text and not text.endswith("\n"):
                    text = pipe.readline(8192)
                log("system", "Oversized log line omitted.")
                continue
            log(stream, text.rstrip("\r\n"))
        pipe.close()

    threads = [threading.Thread(target=forward, args=(child.stdout, "stdout")),
               threading.Thread(target=forward, args=(child.stderr, "stderr"))]
    for thread in threads:
        thread.start()
    result = child.wait()
    for thread in threads:
        thread.join()
    log("system", f"Task exited with code {result}")
    return result if result >= 0 else 128 - result


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print(json.dumps({"timestamp": datetime.now(timezone.utc).isoformat(), "stream": "system",
                          "text": "Runner initialization failed; verify the task and credential configuration."}), flush=True)
        sys.exit(1)
