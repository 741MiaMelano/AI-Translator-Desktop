import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildImportedSubtitleProject } from "./project-factory.mjs";
import { toUint8Array } from "./encoding.mjs";

export function importSubtitleToProject({
  fileName,
  bytes,
  encoding,
  defaults,
  createProject,
  containerPathFor,
}) {
  const binary = toUint8Array(bytes);
  const built = buildImportedSubtitleProject({
    fileName,
    bytes: binary,
    encoding,
    defaults,
  });
  if (!built.ok) {
    return built;
  }

  const containerPath = containerPathFor(built.project.id);
  const rawPath = join(containerPath, ...built.rawRelativePath.split("/"));

  try {
    mkdirSync(dirname(rawPath), { recursive: true });
    writeFileSync(rawPath, binary);
    createProject(built.project);
  } catch {
    try {
      rmSync(containerPath, { recursive: true, force: true });
    } catch {
      // best-effort cleanup of incomplete project container
    }
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: "Failed to create subtitle project",
      },
    };
  }

  return {
    ok: true,
    project: built.project,
    warnings: built.warnings,
  };
}
