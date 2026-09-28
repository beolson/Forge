"""GitHub operations run only inside a provisioning container."""

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
    if len(sys.argv) != 2:
        raise RuntimeError("Forge task requires one payload argument")
    encoded = sys.argv[1]
    try:
        value = json.loads(base64.b64decode(encoded, validate=True))
    except (ValueError, json.JSONDecodeError) as error:
        raise RuntimeError("Invalid Forge task payload") from error
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
            allow_missing: bool = False):
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers = {**(headers or {}), "Content-Type": "application/json"}
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


def run(operation: str):
    try:
        project = payload()
        github(operation, project)
    except Exception as error:
        print(f"Forge github {operation} failed: {error}", file=sys.stderr)
        sys.exit(1)
