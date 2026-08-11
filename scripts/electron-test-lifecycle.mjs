import { execFileSync } from "node:child_process";

export function listWindowsProcessTreeNames(rootPid) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error("process tree root PID is invalid");
  const script = `
$rootPid = [uint32]${rootPid}
$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
$ids = [System.Collections.Generic.HashSet[uint32]]::new()
[void]$ids.Add($rootPid)
do {
  $added = $false
  foreach ($process in $processes) {
    if ($ids.Contains([uint32]$process.ParentProcessId) -and $ids.Add([uint32]$process.ProcessId)) { $added = $true }
  }
} while ($added)
@($processes | Where-Object { $ids.Contains([uint32]$_.ProcessId) } | ForEach-Object Name) | ConvertTo-Json -Compress
`;
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  }).trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function timeoutAfter(milliseconds, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds));
}

export async function closeElectronApp(app) {
  if (!app) return;
  const child = app.process();
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));

  try {
    const page = app.windows().find((candidate) => !candidate.isClosed());
    if (page) {
      await page.getByTitle("关闭").click({ timeout: 3_000 }).catch(() => undefined);
    }
    await Promise.race([exited, timeoutAfter(8_000, "graceful close timeout")]);
    return;
  } catch {
    if (child.exitCode !== null) return;
  }

  try {
    await Promise.race([app.close(), timeoutAfter(4_000, "app close timeout")]);
  } catch {
    try {
      execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {
      child.kill();
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
