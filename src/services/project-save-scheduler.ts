import type { Project } from "../domain/workspace";
import type { DesktopIpcResult, SaveProjectResponse } from "../contracts/desktop-api";
import { desktopSaveProject } from "./desktop-client.ts";

const AUTOSAVE_DELAY_MS = 400;

type SaveFn = (project: Project) => Promise<DesktopIpcResult<SaveProjectResponse>>;
type SaveListener = (projectId: string, errorMessage: string | null) => void;

export class ProjectSaveScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private chains = new Map<string, Promise<void>>();
  private latest = new Map<string, Project>();
  private revisions = new Map<string, number>();
  private savedRevisions = new Map<string, number>();
  private externalPending = new Set<string>();
  private saveConflicts = new Set<string>();
  private listeners = new Set<SaveListener>();
  private saveProject: SaveFn;

  constructor(saveProject: SaveFn = desktopSaveProject) {
    this.saveProject = saveProject;
  }

  onSettle(listener: SaveListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(projectId: string, errorMessage: string | null) {
    this.listeners.forEach((listener) => listener(projectId, errorMessage));
  }

  markDirty(project: Project) {
    const nextRevision = (this.revisions.get(project.id) ?? 0) + 1;
    this.revisions.set(project.id, nextRevision);
    this.latest.set(project.id, project);
    const existingTimer = this.timers.get(project.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    if (this.externalPending.has(project.id) || this.saveConflicts.has(project.id)) {
      // ponytail: block stale whole-project saves; add a domain merge only with an explicit conflict UI.
      this.saveConflicts.add(project.id);
      this.timers.delete(project.id);
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(project.id);
      void this.enqueue(project.id);
    }, AUTOSAVE_DELAY_MS);
    this.timers.set(project.id, timer);
  }

  async acceptExternal(project: Project) {
    const timer = this.timers.get(project.id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(project.id);
    }
    this.saveConflicts.delete(project.id);
    this.externalPending.add(project.id);
    const nextRevision = (this.revisions.get(project.id) ?? 0) + 1;
    this.revisions.set(project.id, nextRevision);
    this.latest.set(project.id, project);
    let accepted = false;
    try {
      await this.enqueue(project.id);
      accepted = !this.isDirty(project.id);
      return accepted;
    } finally {
      this.externalPending.delete(project.id);
      if (!accepted) this.saveConflicts.add(project.id);
    }
  }

  acceptPersisted(project: Project) {
    const timer = this.timers.get(project.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(project.id);
    this.externalPending.delete(project.id);
    this.saveConflicts.delete(project.id);
    const revision = (this.revisions.get(project.id) ?? 0) + 1;
    this.revisions.set(project.id, revision);
    this.savedRevisions.set(project.id, revision);
    this.latest.set(project.id, project);
    this.emit(project.id, null);
  }

  private enqueue(projectId: string) {
    const project = this.latest.get(projectId);
    const revision = this.revisions.get(projectId) ?? 0;
    const previous = this.chains.get(projectId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (!project) {
          return;
        }
        if ((this.savedRevisions.get(projectId) ?? 0) >= revision) {
          return;
        }
        const result = await this.saveProject(project);
        if (!result.ok) {
          this.emit(projectId, result.error.message);
          return;
        }
        if ((this.revisions.get(projectId) ?? 0) === revision) {
          this.savedRevisions.set(projectId, revision);
          this.emit(projectId, null);
        }
      });
    this.chains.set(projectId, next);
    return next;
  }

  async flush(projectId?: string) {
    const ids = projectId ? [projectId] : [...this.latest.keys()];
    for (const id of ids) {
      const timer = this.timers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(id);
      }
      if (this.saveConflicts.has(id)) continue;
      await this.enqueue(id);
    }
    return ids.every((id) => !this.isDirty(id));
  }

  async flushAll() {
    return this.flush();
  }

  isDirty(projectId: string) {
    return this.saveConflicts.has(projectId)
      || (this.revisions.get(projectId) ?? 0) > (this.savedRevisions.get(projectId) ?? 0);
  }
}

export const projectSaveScheduler = new ProjectSaveScheduler();
