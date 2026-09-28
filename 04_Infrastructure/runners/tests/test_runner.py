"""Verify credentials are removed from the runner's public logging boundary."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("runner", Path(__file__).resolve().parents[1] / "execute.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerLogTest(unittest.TestCase):
    def test_provider_secret_and_generated_tokens_are_redacted(self):
        redact = runner.redactor({"AZURE_CLIENT_SECRET": "example-secret", "GITHUB_ORG": "organization"})
        self.assertEqual(redact("login example-secret for organization"), "login [REDACTED] for organization")
        self.assertEqual(redact("token ghs_exampletoken JWT eyJheader.payload.signature"), "token [REDACTED] JWT [REDACTED]")

    def test_private_key_lines_are_redacted(self):
        with tempfile.TemporaryDirectory() as directory:
            key = Path(directory) / "key.pem"
            key.write_text("-----BEGIN PRIVATE KEY-----\nexample-private-key-line\n-----END PRIVATE KEY-----\n")
            redact = runner.redactor({}, str(key))
            self.assertEqual(redact("example-private-key-line"), "[REDACTED]")
