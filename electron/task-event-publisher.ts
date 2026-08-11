import type { WorkerEvent } from "../src/contracts/worker-task";

function sanitizeMessage(value: unknown) {
  return String(value ?? "")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[path]")
    .replace(/\\\\[^\s"']+/g, "[path]")
    .replace(/\b(api.?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 500);
}

export function createTaskEventPublisher({
  send,
  throttleMs = 100,
  now = () => Date.now(),
}: {
  send: (event: WorkerEvent) => void;
  throttleMs?: number;
  now?: () => number;
}) {
  const lastAcceptedSequence = new Map<string, number>();
  const lastSentAt = new Map<string, number>();
  const pending = new Map<string, { event: WorkerEvent; timer: ReturnType<typeof setTimeout> }>();
  const recentLogs = new Map<string, number>();
  let closed = false;

  function sanitized(event: WorkerEvent): WorkerEvent {
    if (event.type === "log") return { ...event, message: sanitizeMessage(event.message) };
    if (event.type === "progress" && event.message !== undefined) {
      return { ...event, message: sanitizeMessage(event.message) };
    }
    if (event.type === "status" && event.reason !== undefined) {
      return { ...event, reason: sanitizeMessage(event.reason) };
    }
    return event;
  }

  function deliver(event: WorkerEvent) {
    if (closed) return;
    lastSentAt.set(event.taskId, now());
    send(event);
  }

  function clearPending(taskId: string) {
    const queued = pending.get(taskId);
    if (!queued) return;
    clearTimeout(queued.timer);
    pending.delete(taskId);
  }

  function publish(rawEvent: WorkerEvent) {
    if (
      closed || !rawEvent || typeof rawEvent !== "object" ||
      typeof rawEvent.taskId !== "string" ||
      !Number.isSafeInteger(rawEvent.sequence) || rawEvent.sequence < 0
    ) return false;
    const previous = lastAcceptedSequence.get(rawEvent.taskId);
    if (previous !== undefined && rawEvent.sequence <= previous) return false;
    lastAcceptedSequence.set(rawEvent.taskId, rawEvent.sequence);
    const event = sanitized(rawEvent);

    if (event.type === "log") {
      const signature = `${event.taskId}:${event.level}:${event.message}`;
      const loggedAt = recentLogs.get(signature);
      if (loggedAt !== undefined && now() - loggedAt < 1_000) return false;
      recentLogs.set(signature, now());
      if (recentLogs.size > 500) recentLogs.delete(recentLogs.keys().next().value!);
    }

    if (event.type === "status") {
      clearPending(event.taskId);
      deliver(event);
      return true;
    }

    const elapsed = now() - (lastSentAt.get(event.taskId) ?? Number.NEGATIVE_INFINITY);
    if (elapsed >= throttleMs) {
      deliver(event);
      return true;
    }
    const queued = pending.get(event.taskId);
    if (queued) {
      queued.event = event;
      return true;
    }
    const timer = setTimeout(() => {
      const latest = pending.get(event.taskId);
      pending.delete(event.taskId);
      if (latest) deliver(latest.event);
    }, Math.max(0, throttleMs - elapsed));
    timer.unref?.();
    pending.set(event.taskId, { event, timer });
    return true;
  }

  return {
    publish,
    close() {
      closed = true;
      for (const queued of pending.values()) clearTimeout(queued.timer);
      pending.clear();
      recentLogs.clear();
    },
  };
}
