import type { DatabaseInstance } from "../db/connection.js";
import { requireEpic } from "./epics.js";
import { requireProject } from "./projects.js";
import type { Task } from "./tasks.js";

/**
 * How far past its 30-minute lease an in-progress task has to sit before the
 * audit stops calling it a warning and calls it a hard finding.
 */
const CRITICAL_OVERRUN_MINUTES = 120;

export type AuditSeverity = "ok" | "warning" | "critical";

export interface EpicAuditEntry {
  task_id: string;
  task_number: number;
  minutes_past_lease: number;
  severity: AuditSeverity;
}

export interface EpicAuditReport {
  project_id: string;
  epic_id: string;
  checked_at: string;
  entries: EpicAuditEntry[];
}

function minutesPastLease(task: Task, nowIso: string): number {
  if (task.lock_expires_at === null) return 0;
  const overrunMs = Date.parse(nowIso) - Date.parse(task.lock_expires_at);
  return overrunMs <= 0 ? 0 : Math.floor(overrunMs / 60_000);
}

function severityFor(minutesPastLease: number): AuditSeverity {
  if (minutesPastLease >= CRITICAL_OVERRUN_MINUTES) return "critical";
  if (minutesPastLease > 0) return "warning";
  return "ok";
}

/**
 * Read-only sweep over one epic's in-progress tasks, reporting which of them
 * are holding a lock whose lease has already run out. Same staleness
 * condition the board surfaces per task, aggregated per epic instead.
 */
export function auditEpicLeases(
  db: DatabaseInstance,
  projectRef: string,
  epicRef: string,
): EpicAuditReport {
  const project = requireProject(db, projectRef);
  const epic = requireEpic(db, project.id, epicRef);
  const nowIso = new Date().toISOString();

  const tasks = db
    .prepare(`SELECT * FROM tasks WHERE epic_id = ? AND status = 'in_progress' ORDER BY task_number ASC`)
    .all(epic.id) as Task[];

  const entries: EpicAuditEntry[] = tasks.map((task) => {
    const minutes = minutesPastLease(task, nowIso);
    return {
      task_id: task.id,
      task_number: task.task_number,
      minutes_past_lease: minutes,
      severity: severityFor(minutes),
    };
  });

  return {
    project_id: project.id,
    epic_id: epic.id,
    checked_at: nowIso,
    entries,
  };
}
