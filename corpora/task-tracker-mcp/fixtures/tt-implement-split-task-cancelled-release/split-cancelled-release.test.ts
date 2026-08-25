import { describe, expect, it } from "vitest";
import { openDatabase, type DatabaseInstance } from "../../src/db/connection.js";
import { createProject } from "../../src/domain/projects.js";
import { createRelease, setTaskRelease } from "../../src/domain/releases.js";
import { createTask, splitTask } from "../../src/domain/tasks.js";
import { listTasks } from "../../src/domain/status.js";
import type { BudgetEstimator } from "../../src/domain/budget.js";

const est: BudgetEstimator = { estimateTokens: () => 0 };

/**
 * Sets the status directly rather than going through cancelRelease, matching
 * the helper tests/releases.test.ts uses: this fixture is about what a
 * cancelled release does to *other* operations, so it should not also depend
 * on the lifecycle function's own guards passing.
 */
function markCancelled(db: DatabaseInstance, releaseId: string): void {
  db.prepare(
    `UPDATE releases SET status = 'cancelled', cancellation_reason = 'gate said no' WHERE id = ?`,
  ).run(releaseId);
}

function setup() {
  const db = openDatabase(":memory:");
  const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
  const release = createRelease(db, { project_id: project.id, version: "0.1" });
  return { db, project, release };
}

describe("split_task on a task in a cancelled release", () => {
  it("splits it, and the subtasks inherit the cancelled release", () => {
    const { db, project, release } = setup();
    const parent = createTask(db, est, {
      project_id: project.id,
      title: "salvageable parent",
      complexity_hint: "normal",
      release_id: release.id,
    }).task;
    markCancelled(db, release.id);

    const { new_task_ids } = splitTask(db, est, parent.id, [
      { title: "part one", complexity_hint: "normal" },
      { title: "part two", complexity_hint: "normal" },
    ]);

    expect(new_task_ids).toHaveLength(2);
    const tasks = listTasks(db, project.id).filter((t) => new_task_ids.includes(t.id));
    expect(tasks).toHaveLength(2);
    for (const t of tasks) {
      expect(t.release_id).toBe(release.id);
    }
    // The parent is gone, as split_task always does.
    expect(listTasks(db, project.id).some((t) => t.id === parent.id)).toBe(false);
  });

  it("still refuses to assign a NEW task into a cancelled release", () => {
    const { db, project, release } = setup();
    markCancelled(db, release.id);

    expect(() =>
      createTask(db, est, {
        project_id: project.id,
        title: "brand new work",
        complexity_hint: "normal",
        release_id: release.id,
      }),
    ).toThrow(/cancelled/i);
  });

  it("still refuses to move an existing task into a cancelled release", () => {
    const { db, project, release } = setup();
    const other = createRelease(db, { project_id: project.id, version: "0.2" });
    const task = createTask(db, est, {
      project_id: project.id,
      title: "elsewhere",
      complexity_hint: "normal",
      release_id: other.id,
    }).task;
    markCancelled(db, release.id);

    expect(() => setTaskRelease(db, task.id, release.id)).toThrow(/cancelled/i);
  });

  it("still refuses to split a task whose release already shipped", () => {
    const { db, project, release } = setup();
    const parent = createTask(db, est, {
      project_id: project.id,
      title: "shipped work",
      complexity_hint: "normal",
      release_id: release.id,
    }).task;
    db.prepare(`UPDATE releases SET status = 'released' WHERE id = ?`).run(release.id);

    expect(() =>
      splitTask(db, est, parent.id, [{ title: "part one", complexity_hint: "normal" }]),
    ).toThrow();
  });
});
