/** Test helper: controllable child for process-runner tests. */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.argv[2] || "echo-argv";

if (mode === "echo-argv") {
  process.stdout.write(JSON.stringify(process.argv.slice(2)));
  process.exit(0);
} else if (mode === "echo-env") {
  process.stdout.write(
    JSON.stringify({
      keys: Object.keys(process.env).sort(),
      cwd: process.cwd(),
      shellHint: process.env.ComSpec || null,
    }),
  );
  process.exit(0);
} else if (mode === "stdout-bytes") {
  const n = Number(process.argv[3] || "0");
  process.stdout.write(Buffer.alloc(n, 0x61));
  process.exit(0);
} else if (mode === "stderr-bytes") {
  const n = Number(process.argv[3] || "0");
  process.stderr.write(Buffer.alloc(n, 0x62));
  process.exit(0);
} else if (mode === "stderr-text") {
  process.stderr.write(process.argv[3] || "");
  process.exit(0);
} else if (mode === "stderr-noise-fail") {
  const n = Number(process.argv[3] || "0");
  process.stderr.write(Buffer.alloc(n, 0x61));
  process.stderr.write("FINAL_QWEN_ERROR");
  process.exit(2);
} else if (mode === "sleep") {
  const ms = Number(process.argv[3] || "5000");
  setTimeout(() => process.exit(0), ms);
} else if (mode === "fail") {
  process.stderr.write(`fail path=${process.argv[3] || ""} stack=secret-stack`);
  process.exit(2);
} else if (mode === "spawn-child") {
  const marker = process.argv[3];
  const child = spawn(process.execPath, [process.argv[1], "sleep", "30000"], {
    shell: false,
    stdio: "ignore",
    detached: false,
  });
  writeFileSync(marker, String(child.pid), "utf8");
  setTimeout(() => process.exit(0), 30000);
} else if (mode === "hang") {
  setInterval(() => {}, 1000);
} else {
  process.stderr.write(`unknown mode ${mode}`);
  process.exit(1);
}
