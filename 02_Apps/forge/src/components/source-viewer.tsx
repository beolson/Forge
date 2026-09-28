import type { SourceSnapshot } from "@hero4hire/automation";
import { useState } from "react";

export function SourceViewer({
  source,
  initialPath,
}: {
  source: SourceSnapshot;
  initialPath?: string;
}) {
  const [path, setPath] = useState(initialPath || "tasks.json");
  const github =
    source.origin === "github"
      ? `https://github.com/${source.repository}`
      : null;
  return (
    <section className="space-y-3">
      <p className="break-all text-sm text-muted-foreground">
        {source.origin === "development"
          ? "Local development snapshot"
          : source.repository}
        : <code>{source.revision}</code>
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <label className="grid gap-1 text-sm">
          File
          <select
            value={path}
            onChange={(event) => setPath(event.target.value)}
            className="rounded border bg-background px-3 py-2"
          >
            {Object.keys(source.files)
              .sort()
              .map((file) => (
                <option key={file} value={file}>
                  {file}
                </option>
              ))}
          </select>
        </label>
        {github && (
          <>
            <a
              href={`${github}/blob/${source.revision}/${source.root}/${path}`}
              target="_blank"
              rel="noreferrer"
              className="text-sm underline"
            >
              View exact version on GitHub
            </a>
            <a
              href={`${github}/edit/main/${source.root}/${path}`}
              target="_blank"
              rel="noreferrer"
              className="text-sm underline"
            >
              Edit on GitHub
            </a>
          </>
        )}
      </div>
      <pre className="max-h-[36rem] overflow-auto rounded-lg border bg-muted p-4 text-xs">
        <code>{source.files[path]}</code>
      </pre>
    </section>
  );
}
