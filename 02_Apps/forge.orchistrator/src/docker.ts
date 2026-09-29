import { request } from "node:http";

export class DockerError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function docker<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const raw = await dockerBytes(method, path, body);
  return (raw.length ? JSON.parse(raw.toString("utf8")) : undefined) as T;
}

export function dockerBytes(
  method: string,
  path: string,
  body?: unknown,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
        path: `/v1.45${path}`,
        method,
        headers: { "Content-Type": "application/json" },
        timeout: 30_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const bytes = Buffer.concat(chunks);
          const status = response.statusCode || 500;
          if (status >= 400)
            reject(
              new DockerError(
                status,
                `Docker API ${method} ${path.split("?")[0]} returned HTTP ${status}`,
              ),
            );
          else resolve(bytes);
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () =>
      req.destroy(new Error("Docker API request timed out")),
    );
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

export function decodeDockerLogs(bytes: Buffer): string {
  const output: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; ) {
    if (offset + 8 > bytes.length)
      throw new Error("Incomplete Docker log header");
    const length = bytes.readUInt32BE(offset + 4);
    if (offset + 8 + length > bytes.length)
      throw new Error("Incomplete Docker log frame");
    output.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  return Buffer.concat(output).toString("utf8");
}
