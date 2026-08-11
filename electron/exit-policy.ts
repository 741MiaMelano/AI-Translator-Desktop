export type ExitBehavior = "exit" | "background" | "stop" | "cancel";

export function resolveAutomatedExitResponse({
  fakeProvider,
  choice,
}: {
  fakeProvider: boolean;
  choice?: string;
}): number | null {
  if (!fakeProvider) return null;
  if (choice === "background") return 0;
  if (choice === "stop") return 1;
  if (choice === "cancel") return 2;
  return null;
}

export async function decideExitBehavior({
  hasActiveTasks,
  prompt,
}: {
  hasActiveTasks: boolean;
  prompt: () => Promise<number>;
}): Promise<ExitBehavior> {
  if (!hasActiveTasks) return "exit";
  const response = await prompt();
  if (response === 0) return "background";
  if (response === 1) return "stop";
  return "cancel";
}
