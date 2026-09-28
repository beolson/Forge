"""Verify credentials are removed from the runner's public logging boundary."""
import importlib.util
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("runner", Path(__file__).resolve().parents[1] / "execute.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerLogTest(unittest.TestCase):
    def test_long_diagnostic_is_preserved_with_secrets_redacted_before_splitting(self):
        secret = "secret-crossing-record-boundary"
        original = "x" * 8185 + secret + "y" * 18000
        output = io.StringIO()
        with redirect_stdout(output):
            runner.write_log("stderr", original, runner.redactor({"AZURE_CLIENT_SECRET": secret}), threading.Lock())
        records = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual("".join(record["text"] for record in records), original.replace(secret, "[REDACTED]"))
        self.assertTrue(all(len(record["text"]) <= 8192 for record in records))
        self.assertTrue(all(record["stream"] == "stderr" for record in records))

    def test_unicode_diagnostic_is_preserved_in_bounded_utf8_records(self):
        original = "😀界" * 9000
        output = io.StringIO()
        with redirect_stdout(output):
            runner.write_log("stderr", original, lambda text: text, threading.Lock())
        records = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual("".join(record["text"] for record in records), original)
        self.assertTrue(all(len(record["text"].encode("utf8")) <= 8192 for record in records))

    def test_provider_secret_and_generated_tokens_are_redacted(self):
        redact = runner.redactor({"AZURE_CLIENT_SECRET": "example-secret", "GITHUB_ORG": "organization"})
        self.assertEqual(redact("login example-secret for organization"), "login [REDACTED] for organization")
        self.assertEqual(redact("token ghs_exampletoken JWT eyJheader.payload.signature"), "token [REDACTED] JWT [REDACTED]")

    def test_redacted_archive_survives_a_stdout_failure(self):
        class BrokenOutput:
            def write(self, _text):
                raise BrokenPipeError()

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "logs.jsonl"
            with path.open("a") as archive, redirect_stdout(BrokenOutput()):
                runner.write_log("stderr", "diagnostic example-secret", runner.redactor({"AZURE_CLIENT_SECRET": "example-secret"}), threading.Lock(), archive)
                runner.write_log("stderr", "later diagnostic", lambda text: text, threading.Lock(), archive)
            records = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertEqual([record["text"] for record in records], ["diagnostic [REDACTED]", "later diagnostic"])

    def test_archive_failure_preserves_successful_provider_exit_status(self):
        class BrokenArchive:
            def tell(self):
                return 0

            def write(self, _text):
                raise OSError("archive unavailable")

            def seek(self, _position):
                raise OSError("archive unavailable")

        files = {
            "request.json": {},
            "task.json": {"runner": "privileged", "resource": "azure", "runtime": "bash", "entrypoint": "/dev/stdin", "name": "No-op provider"},
            "/run/secrets/forge/providers.json": {},
            "settings.json": {"azureSubscriptionId": "test", "azureRegion": "eastus"},
        }
        # The child is real Bash, reading an empty input file and exiting successfully.
        files["task.json"]["entrypoint"] = "/dev/null"
        output = io.StringIO()
        with patch.object(runner.Path, "read_text", lambda path: json.dumps(files[str(path)])), redirect_stdout(output):
            self.assertEqual(runner.main(BrokenArchive()), 0)
        self.assertIn("Task exited with code 0", output.getvalue())

    def test_private_key_lines_are_redacted(self):
        with tempfile.TemporaryDirectory() as directory:
            key = Path(directory) / "key.pem"
            key.write_text("-----BEGIN PRIVATE KEY-----\nexample-private-key-line\n-----END PRIVATE KEY-----\n")
            redact = runner.redactor({}, str(key))
            self.assertEqual(redact("example-private-key-line"), "[REDACTED]")
