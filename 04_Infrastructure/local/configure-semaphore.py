"""Register the bind-mounted Forge automation folder in local Semaphore."""

import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.request


BASE_URL = os.environ["SEMAPHORE_URL"].rstrip("/")
PROJECT_NAME = "Forge local"
REPOSITORY_NAME = "Forge automation"
REPOSITORY_PATH = "/opt/forge/semaphore"
KEY_NAME = "Local (no credentials)"
TEMPLATE_NAME = "Verify local scripts"
AUTOMATION_TEMPLATES = {
    "azureCreate": ("Create Azure resource group", "scripts/azure_create.py"),
    "azureRollback": ("Roll back Azure resource group", "scripts/azure_rollback.py"),
    "githubCreate": ("Create GitHub repository", "scripts/github_create.py"),
    "githubRollback": ("Roll back GitHub repository", "scripts/github_rollback.py"),
}

opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
)


def api(method: str, path: str, payload: dict | None = None):
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        BASE_URL + path,
        data=body,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    try:
        with opener.open(request, timeout=10) as response:
            content = response.read()
            if not content:
                return None
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                return content.decode(errors="replace")
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"Semaphore {method} {path} failed ({error.code}): {detail}") from error


def wait_for_semaphore():
    for attempt in range(90):
        try:
            api("GET", "/api/ping")
            return
        except (OSError, RuntimeError):
            if attempt == 89:
                raise RuntimeError("Semaphore did not become available within 90 seconds")
            time.sleep(1)


def main():
    wait_for_semaphore()
    api(
        "POST",
        "/api/auth/login",
        {
            "auth": os.environ["SEMAPHORE_ADMIN"],
            "password": os.environ["SEMAPHORE_ADMIN_PASSWORD"],
        },
    )

    projects = api("GET", "/api/projects")
    project = next((item for item in projects if item["name"] == PROJECT_NAME), None)
    if project is None:
        project = api("POST", "/api/projects", {"name": PROJECT_NAME, "demo": False})
    project_id = project["id"]

    keys_path = f"/api/project/{project_id}/keys"
    keys = api("GET", keys_path + "?sort=name&order=asc")
    key = next((item for item in keys if item["name"] == KEY_NAME), None)
    if key is None:
        key = api(
            "POST",
            keys_path,
            {"name": KEY_NAME, "type": "none", "project_id": project_id},
        )

    repositories_path = f"/api/project/{project_id}/repositories"
    repositories = api("GET", repositories_path + "?sort=name&order=asc")
    repository = next(
        (item for item in repositories if item["name"] == REPOSITORY_NAME), None
    )
    desired = {
        "name": REPOSITORY_NAME,
        "git_url": REPOSITORY_PATH,
        "git_branch": "main",
        "ssh_key_id": key["id"],
        "project_id": project_id,
    }
    if repository is None:
        repository = api("POST", repositories_path, desired)
    elif any(repository.get(field) != value for field, value in desired.items()):
        api("PUT", f"{repositories_path}/{repository['id']}", {**desired, "id": repository["id"]})

    templates_path = f"/api/project/{project_id}/templates"
    templates = api("GET", templates_path + "?sort=name&order=asc")
    if not any(item["name"] == TEMPLATE_NAME for item in templates):
        api(
            "POST",
            templates_path,
            {
                "project_id": project_id,
                "repository_id": repository["id"],
                "name": TEMPLATE_NAME,
                "app": "bash",
                "playbook": "scripts/verify-local.sh",
                "arguments": "[]",
                "description": "Confirm that Semaphore can run a script from the local Forge folder.",
            },
        )

    template_ids = {}
    for operation, (name, script) in AUTOMATION_TEMPLATES.items():
        template = next((item for item in templates if item["name"] == name), None)
        desired = {
            "project_id": project_id,
            "repository_id": repository["id"],
            "name": name,
            "app": "python",
            "playbook": script,
            "arguments": "[]",
            "description": "Forge project creation or rollback; invoked by DBOS.",
        }
        if template is None:
            template = api("POST", templates_path, desired)
        elif any(template.get(field) != value for field, value in desired.items()):
            api("PUT", f"{templates_path}/{template['id']}", {**desired, "id": template["id"]})
        template_ids[operation] = template["id"]

    connection_file = os.environ.get("SEMAPHORE_CONNECTION_FILE")
    if connection_file:
        os.makedirs(os.path.dirname(connection_file), exist_ok=True)
        token = None
        if os.path.exists(connection_file):
            with open(connection_file, encoding="utf-8") as saved:
                token = json.load(saved).get("token")
        if token:
            probe = urllib.request.Request(
                BASE_URL + f"/api/project/{project_id}/tasks",
                headers={"Authorization": f"Bearer {token}"},
            )
            try:
                with urllib.request.urlopen(probe, timeout=10):
                    pass
            except urllib.error.HTTPError as error:
                if error.code == 401 or error.code == 403:
                    token = None
                else:
                    raise
        if not token:
            token = api("POST", "/api/user/tokens")["id"]
        data = {"url": BASE_URL, "token": token, "projectId": project_id, "templates": template_ids}
        temporary = connection_file + ".tmp"
        with open(temporary, "w", encoding="utf-8") as output:
            json.dump(data, output)
        os.chmod(temporary, 0o600)
        os.replace(temporary, connection_file)

    print(f"Semaphore project '{PROJECT_NAME}' uses {REPOSITORY_PATH} and has a verification task")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
