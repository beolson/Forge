"""Exercise the Azure task boundary without credentials or cloud mutations."""

import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
PROJECT_ID = "dff58b13-bc6b-4f63-a655-663e0a51da00"


class AzureTasksTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.log = self.directory / "calls.jsonl"
        mock = self.directory / "az"
        mock.write_text(
            """#!/usr/bin/env python3
import json
import os
import sys
args = sys.argv[1:]
with open(os.environ['MOCK_LOG'], 'a') as log:
    log.write(json.dumps({'args': args, 'config': os.environ['AZURE_CONFIG_DIR']}) + '\\n')
if ' '.join(args[:3]) == os.environ.get('MOCK_FAIL'):
    print('Simulated Azure failure', file=sys.stderr)
    sys.exit(1)
if args[:2] == ['group', 'exists']:
    print(os.environ['MOCK_EXISTS'])
elif args[:2] == ['group', 'show']:
    print(os.environ['MOCK_MARKER'])
elif args[:3] == ['deployment', 'sub', 'list']:
    print(os.environ.get('MOCK_DEPLOYMENT_LOCATION', ''))
""",
            encoding="utf-8",
        )
        mock.chmod(0o755)
        self.environment = {
            **os.environ,
            "PATH": f"{self.directory}{os.pathsep}{os.environ['PATH']}",
            "MOCK_LOG": str(self.log),
            "MOCK_EXISTS": "false",
            "MOCK_MARKER": PROJECT_ID,
            "AZURE_TENANT_ID": "test-tenant",
            "AZURE_CLIENT_ID": "test-client",
            "AZURE_CLIENT_SECRET": "test-secret",
            "AZURE_SUBSCRIPTION_ID": "test-subscription",
            "AZURE_REGION": "eastus",
        }

    def run_task(self, operation, project=None, encoded=None):
        if encoded is None:
            encoded = base64.b64encode(json.dumps(
                project if project is not None else {"projectId": PROJECT_ID, "code": "ABCDE"}
            ).encode()).decode()
        return subprocess.run(
            ["bash", str(SCRIPTS / f"azure_{operation}.sh"), encoded],
            env=self.environment,
            capture_output=True,
            text=True,
            check=False,
        )

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def writes(self):
        return [call["args"] for call in self.calls() if call["args"][:2] == ["group", "delete"]
                or call["args"][:3] == ["deployment", "sub", "create"]]

    def test_new_group_deploys_bicep_with_system_settings_and_project_identity(self):
        result = self.run_task("create")
        self.assertEqual(result.returncode, 0, result.stderr)
        [deployment] = self.writes()
        self.assertEqual(deployment[:3], ["deployment", "sub", "create"])
        self.assertIn("appCode=ABCDE", deployment)
        self.assertIn(f"projectId={PROJECT_ID}", deployment)
        self.assertIn("location=eastus", deployment)
        self.assertEqual(deployment[deployment.index("--subscription") + 1], "test-subscription")
        self.assertEqual(deployment[deployment.index("--name") + 1], "az-abcde-rgdep")
        self.assertEqual(deployment[deployment.index("--location") + 1], "eastus")
        self.assertTrue(deployment[deployment.index("--template-file") + 1].endswith("project-resource-group.bicep"))
        self.assertEqual(len({call["config"] for call in self.calls()}), 1)
        self.assertFalse(Path(self.calls()[0]["config"]).exists())

    def test_changed_region_retains_deployment_location_for_retry(self):
        self.environment["MOCK_DEPLOYMENT_LOCATION"] = "westus"
        result = self.run_task("create")
        self.assertEqual(result.returncode, 0, result.stderr)
        [deployment] = self.writes()
        self.assertEqual(deployment[deployment.index("--location") + 1], "westus")
        self.assertIn("location=eastus", deployment)

    def test_retry_adopts_only_the_owned_group_without_redeploying(self):
        self.environment["MOCK_EXISTS"] = "true"
        result = self.run_task("create")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("already belongs to this project", result.stdout)
        self.assertEqual(self.writes(), [])

    def test_foreign_or_unmarked_group_blocks_creation_and_rollback(self):
        self.environment["MOCK_EXISTS"] = "true"
        for marker in ("", "another-project"):
            self.environment["MOCK_MARKER"] = marker
            for operation in ("create", "rollback"):
                with self.subTest(marker=marker, operation=operation):
                    result = self.run_task(operation)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(f"Forge azure {operation} failed:", result.stderr)
                    self.assertEqual(self.writes(), [])

    def test_rollback_of_owned_group_waits_for_deletion(self):
        self.environment["MOCK_EXISTS"] = "true"
        result = self.run_task("rollback")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.writes()[0][:2], ["group", "delete"])
        calls = [call["args"] for call in self.calls()]
        self.assertEqual(calls[-1][:2], ["group", "wait"])
        self.assertIn("--deleted", calls[-1])
        self.assertEqual(calls[-1][calls[-1].index("--timeout") + 1], "1500")

    def test_rollback_of_missing_group_is_successful(self):
        result = self.run_task("rollback")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("is absent", result.stdout)
        self.assertEqual(self.writes(), [])

    def test_invalid_payload_cannot_reach_azure(self):
        for encoded in ("!", base64.b64encode(b'{}').decode(),
                        base64.b64encode(b'{"projectId":null,"code":"ABCDE"}').decode()):
            with self.subTest(encoded=encoded):
                result = self.run_task("create", encoded=encoded)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Forge azure create failed:", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_provider_failures_report_failure_and_remove_token_cache(self):
        for command in ("login --service-principal --username", "deployment sub create"):
            with self.subTest(command=command):
                self.environment["MOCK_FAIL"] = command
                result = self.run_task("create")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Forge azure create failed:", result.stderr)
                self.assertFalse(Path(self.calls()[-1]["config"]).exists())


if __name__ == "__main__":
    unittest.main()
