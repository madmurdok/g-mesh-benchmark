import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/connection.js";
import { createProject } from "../../src/domain/projects.js";
import { createTask } from "../../src/domain/tasks.js";
import { cancelTask, releaseTask } from "../../src/domain/lifecycle.js";
import { getNextTask, getProjectStatus } from "../../src/domain/status.js";
import type { BudgetEstimator } from "../../src/domain/budget.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };

/** A project with exactly one task, already cancelled with a stored reason. */
function setup() {
  const db = openDatabase(":memory:");
  const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
  const { task } = createTask(db, noopEstimator, {
    project_id: project.id,
    title: "Build schema",
    complexity_hint: "normal",
  });
  cancelTask(db, { task_id: task.id, reason: "duplicate of another task" });
  return { db, project, task };
}

describe("release_task on a cancelled task", () => {
  it("is rejected, the same way claim_task and cancel_task already reject one", () => {
    const { db, task } = setup();

    expect(() => releaseTask(db, { task_id: task.id, session_id: "session-1" })).toThrow(/cancelled/i);
  });

  it("leaves the cancellation intact instead of silently resurrecting the task as pending", () => {
    const { db, task } = setup();

    try {
      releaseTask(db, { task_id: task.id, session_id: "session-1" });
    } catch {
      // The rejection itself is asserted above; here we only care that the row
      // is untouched either way — a release that "succeeds" must not have
      // rewritten the status behind the rejection's back.
    }

    const row = db
      .prepare(`SELECT status, cancellation_reason FROM tasks WHERE id = ?`)
      .get(task.id);
    expect(row).toMatchObject({
      status: "cancelled",
      cancellation_reason: "duplicate of another task",
    });
  });

  it("keeps the cancelled task out of the project's status counts and out of the work queue", () => {
    const { db, project, task } = setup();

    const before = getProjectStatus(db, project.id);
    expect(before).toMatchObject({ cancelled: 1, pending: 0 });

    try {
      releaseTask(db, { task_id: task.id, session_id: "session-1" });
    } catch {
      // see above
    }

    // The whole point of the bug: a cancelled task that flips back to pending
    // silently vanishes from the cancelled count and becomes actionable again.
    const after = getProjectStatus(db, project.id);
    expect(after).toMatchObject({ cancelled: 1, pending: 0 });
    expect(getNextTask(db, project.id).task).toBeNull();
  });

  it("force does not override the cancelled state either", () => {
    const { db, task } = setup();

    expect(() =>
      releaseTask(db, { task_id: task.id, session_id: "session-1", force: true }),
    ).toThrow(/cancelled/i);

    const row = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(task.id);
    expect(row).toMatchObject({ status: "cancelled" });
  });
});
