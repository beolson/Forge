"""Seed provider credentials without printing them or putting them in task arguments."""
import json
import os
from pathlib import Path
import shutil

root = Path("/credentials")
root.mkdir(parents=True, exist_ok=True)
names = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_SUBSCRIPTION_ID",
         "AZURE_REGION", "GITHUB_ORG", "GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID"]
values = {name: os.environ[name] for name in names}
temporary = root / "providers.tmp"
temporary.write_text(json.dumps(values))
temporary.chmod(0o400)
os.chown(temporary, 10001, 10001)
temporary.replace(root / "providers.json")
shutil.copyfile("/input/github-app.pem", root / "github-app.pem")
(root / "github-app.pem").chmod(0o400)
os.chown(root / "github-app.pem", 10001, 10001)
print("Runner provider credentials configured.")
