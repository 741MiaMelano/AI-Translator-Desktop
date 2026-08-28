import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const { version } = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const kind = process.argv[2] ?? "installer";
if (!["installer", "portable"].includes(kind)) throw new Error(`Unsupported artifact kind: ${kind}`);
const releaseRoot = join(process.cwd(), "release");
const requestedName = kind === "portable"
  ? "AI-Translator-Desktop.exe"
  : `AI-Translator-Desktop-${version}-x64.exe`;
const artifactNames = [
  `AI-Translator-Desktop-${version}-x64.exe`,
  "AI-Translator-Desktop.exe",
].filter((name) => existsSync(join(releaseRoot, name)));
if (!artifactNames.includes(requestedName)) throw new Error(`Missing release artifact: ${requestedName}`);

const outputs = [];
for (const artifactName of artifactNames) {
  const artifact = join(releaseRoot, artifactName);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  const output = `${hash.digest("hex")}  ${basename(artifact)}\n`;
  writeFileSync(`${artifact}.sha256`, output, "utf8");
  outputs.push(output);
}
writeFileSync(join(releaseRoot, "SHA256SUMS.txt"), outputs.join(""), "utf8");
console.log(outputs.join("").trim());
