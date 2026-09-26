"""Provider operations run only inside Semaphore. The task message is base64 JSON."""

import base64
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not configured")
    return value


def payload() -> dict:
    encoded = required("SEMAPHORE_TASK_DETAILS_MESSAGE")
    try:
        value = json.loads(base64.b64decode(encoded, validate=True))
    except (ValueError, json.JSONDecodeError) as error:
        raise RuntimeError("Invalid Forge task message") from error
    if not re.fullmatch(r"[0-9a-f-]{36}", value.get("projectId", "")):
        raise RuntimeError("Invalid project ID")
    if not re.fullmatch(r"[A-Z]{5}", value.get("code", "")):
        raise RuntimeError("Invalid project code")
    if not re.fullmatch(r"gh-[a-z]{5}-[a-z0-9]+(?:-[a-z0-9]+)*", value.get("repositoryName", "")):
        raise RuntimeError("Invalid repository name")
    expected_name = f"gh-{value['code'].lower()}-{re.sub(r'[ -]+', '-', value.get('name', '').lower().strip())}"
    if value["repositoryName"] != expected_name:
        raise RuntimeError("Repository name does not match the project")
    return value


def request(method: str, url: str, headers: dict | None = None, body: dict | None = None,
            form: dict | None = None, allow_missing: bool = False):
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers = {**(headers or {}), "Content-Type": "application/json"}
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        headers = {**(headers or {}), "Content-Type": "application/x-www-form-urlencoded"}
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        if allow_missing and error.code == 404:
            return 404, None
        # Provider response bodies can contain request data. Do not print them.
        raise RuntimeError(f"Provider API returned HTTP {error.code} for {method} {url.split('?')[0]}") from error


def azure_token() -> str:
    tenant = required("AZURE_TENANT_ID")
    _, result = request("POST", f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token", form={
        "client_id": required("AZURE_CLIENT_ID"),
        "client_secret": required("AZURE_CLIENT_SECRET"),
        "grant_type": "client_credentials",
        "scope": "https://management.azure.com/.default",
    })
    return result["access_token"]


def azure(operation: str, project: dict):
    name = f"az-{project['code'].lower()}-resgp"
    subscription = required("AZURE_SUBSCRIPTION_ID")
    url = f"https://management.azure.com/subscriptions/{subscription}/resourcegroups/{name}?api-version=2021-04-01"
    headers = {"Authorization": f"Bearer {azure_token()}"}
    status, existing = request("GET", url, headers, allow_missing=True)
    if operation == "create":
        if status == 404:
            request("PUT", url, headers, body={"location": required("AZURE_REGION"), "tags": {
                "forgeProjectId": project["projectId"], "forgeCode": project["code"]}})
            print(f"Created resource group {name}")
            return
        if existing.get("tags", {}).get("forgeProjectId") != project["projectId"]:
            raise RuntimeError(f"Resource group {name} already exists and is not owned by this Forge project")
        print(f"Resource group {name} already belongs to this project")
        return
    if status == 404:
        print(f"Resource group {name} is absent")
        return
    if existing.get("tags", {}).get("forgeProjectId") != project["projectId"]:
        raise RuntimeError(f"Refusing to delete resource group {name}: ownership marker differs")
    request("DELETE", url, headers, allow_missing=True)
    deadline = time.monotonic() + 25 * 60
    while time.monotonic() < deadline:
        time.sleep(10)
        status, _ = request("GET", url, headers, allow_missing=True)
        if status == 404:
            print(f"Rolled back resource group {name}")
            return
    raise RuntimeError(f"Resource group {name} deletion did not finish within 25 minutes")


def github_token() -> str:
    issued = int(time.time())
    header = base64.urlsafe_b64encode(b'{"alg":"RS256","typ":"JWT"}').rstrip(b"=")
    claims = {"iat": issued - 60, "exp": issued + 540, "iss": required("GITHUB_APP_ID")}
    body = base64.urlsafe_b64encode(json.dumps(claims, separators=(",", ":")).encode()).rstrip(b"=")
    signing_input = header + b"." + body
    signed = subprocess.run(["openssl", "dgst", "-sha256", "-sign", required("GITHUB_APP_PRIVATE_KEY_FILE")],
                            input=signing_input, capture_output=True, check=True).stdout
    jwt = signing_input.decode() + "." + base64.urlsafe_b64encode(signed).rstrip(b"=").decode()
    _, result = request("POST", f"https://api.github.com/app/installations/{required('GITHUB_APP_INSTALLATION_ID')}/access_tokens",
                        {"Authorization": f"Bearer {jwt}", "Accept": "application/vnd.github+json"}, body={})
    return result["token"]


def github(operation: str, project: dict):
    org = required("GITHUB_ORG")
    name = project["repositoryName"]
    root = f"https://api.github.com/repos/{urllib.parse.quote(org)}/{urllib.parse.quote(name)}"
    headers = {"Authorization": f"Bearer {github_token()}", "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28"}
    status, existing = request("GET", root, headers, allow_missing=True)
    if status != 404:
        if not existing.get("private"):
            raise RuntimeError(f"Repository {org}/{name} is not private")
        _, properties = request("GET", root + "/properties/values", headers)
        marker = next((item.get("value") for item in properties if item.get("property_name") == "forge_project_id"), None)
        if marker != project["projectId"]:
            raise RuntimeError(f"Repository {org}/{name} exists without matching Forge ownership")
    if operation == "create":
        if status == 404:
            request("POST", f"https://api.github.com/orgs/{urllib.parse.quote(org)}/repos", headers, body={
                "name": name, "description": project["description"], "private": True,
                "auto_init": False, "custom_properties": {"forge_project_id": project["projectId"]}})
            print(f"Created private repository {org}/{name}")
        else:
            print(f"Repository {org}/{name} already belongs to this project")
        return
    if status == 404:
        print(f"Repository {org}/{name} is absent")
        return
    request("DELETE", root, headers)
    print(f"Rolled back repository {org}/{name}")


def run(provider: str, operation: str):
    try:
        project = payload()
        if provider == "azure":
            azure(operation, project)
        elif provider == "github":
            github(operation, project)
        else:
            raise RuntimeError("Unknown provider")
    except Exception as error:
        print(f"Forge {provider} {operation} failed: {error}", file=sys.stderr)
        sys.exit(1)
