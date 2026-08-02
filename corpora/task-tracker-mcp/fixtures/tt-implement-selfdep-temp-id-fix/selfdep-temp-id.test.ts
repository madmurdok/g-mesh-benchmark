import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/connection.js";
import { createProject } from "../../src/domain/projects.js";
import { createTasks } from "../../src/domain/tasks.js";
import type { BudgetEstimator } from "../../src/domain/budget.js";

const noopEstimator: BudgetEstimator = { estimateTokens: () => 0 };

function setup() {
  const db = openDatabase(":memory:");
  const project = createProject(db, { name: "Demo", root_path: "/tmp/demo" });
  return { db, project };
}

/** Runs `fn`, returns the Error it threw, or fails the test if it threw nothing. */
function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return err as Error;
  }
  throw new Error("expected createTasks to throw, but it returned normally");
}

describe("createTasks: a spec whose depends_on names its own temp_id", () => {
  it("fails with an error naming the offending temp_id, not the opaque self-dependency error", () => {
    const { db, project } = setup();

    const error = captureError(() =>
      createTasks(db, noopEstimator, project.id, [
        { temp_id: "schema", title: "Build schema", complexity_hint: "normal", depends_on: ["schema"] },
      ]),
    );

    // The whole point of the fix: the message must identify *which* temp_id is
    // wrong, so the client can find it in its own batch input.
    expect(error.message).toMatch(/schema/);
    // ...and must no longer be the generic addDependency self-check message,
    // which says nothing about temp_ids and reads as a server bug to a client
    // that never repeated a real task id anywhere.
    expect(error.message).not.toMatch(/^A task cannot depend on itself$/);

    // Same all-or-nothing transaction guarantee every other createTasks
    // failure mode has: nothing from the batch survives.
    const count = db.prepare("SELECT COUNT(*) AS cnt FROM tasks").get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it("detects the self-reference on any spec in the batch, not just the first", () => {
    const { db, project } = setup();

    const error = captureError(() =>
      createTasks(db, noopEstimator, project.id, [
        { temp_id: "schema", title: "Build schema", complexity_hint: "normal" },
        {
          temp_id: "domain",
          title: "Build domain layer",
          complexity_hint: "normal",
          depends_on: ["schema", "domain"],
        },
      ]),
    );

    expect(error.message).toMatch(/domain/);
    expect(error.message).not.toMatch(/^A task cannot depend on itself$/);

    const count = db.prepare("SELECT COUNT(*) AS cnt FROM tasks").get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });
});
