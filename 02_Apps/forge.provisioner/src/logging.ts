import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import type { RunLog } from "@hero4hire/automation";

export function redactor(
  environment: NodeJS.ProcessEnv,
  keyFile?: string,
): (text: string) => string {
  const secrets = Object.entries(environment).flatMap(([name, value]) =>
    value && /SECRET|PASSWORD|TOKEN|CONNECTION_STRING/.test(name)
      ? [value]
      : [],
  );
  if (keyFile)
    secrets.push(
      ...readFileSync(keyFile, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
  secrets.sort((a, b) => b.length - a.length);
  return (text) => {
    let value = text;
    for (const secret of secrets)
      value = value.replaceAll(secret, "[REDACTED]");
    return value
      .replace(
        /\b(?:gh[opsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g,
        "[REDACTED]",
      )
      .replace(
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        "[REDACTED]",
      );
  };
}

function write(fd: number, bytes: Buffer): void {
  for (let offset = 0; offset < bytes.length; ) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!count) throw new Error("Log write made no progress");
    offset += count;
  }
}

export function logger(
  path: string,
  redact: (text: string) => string,
  stdout = 1,
) {
  let archive: number | undefined;
  let outputAvailable = true;
  try {
    archive = openSync(path, "a", 0o600);
  } catch {
    /* Logging failure preserves the task result. */
  }
  return {
    log(stream: RunLog["stream"], text: string) {
      // Redact complete diagnostics before splitting so boundary-spanning secrets remain hidden.
      const bytes = Buffer.from(redact(text));
      let offset = 0;
      do {
        let end = Math.min(bytes.length, offset + 8192);
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
        const record = Buffer.from(
          `${JSON.stringify({ timestamp: new Date().toISOString(), stream, text: bytes.subarray(offset, end).toString("utf8") })}\n`,
        );
        if (archive !== undefined) {
          let position: number | undefined;
          try {
            position = fstatSync(archive).size;
            write(archive, record);
            fsyncSync(archive);
          } catch {
            if (position !== undefined) {
              try {
                ftruncateSync(archive, position);
              } catch {}
            }
          }
        }
        if (outputAvailable) {
          try {
            write(stdout, record);
          } catch {
            outputAvailable = false;
          }
        }
        offset = end;
      } while (offset < bytes.length);
    },
    close() {
      if (archive !== undefined) {
        try {
          closeSync(archive);
        } catch {}
      }
    },
  };
}
