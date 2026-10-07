import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { trainingLineage } from "../server/training-lineage.ts";

test("new protocols retain prior unknown attempt cost and reject concurrent or duplicate ledgers", async () => {
  const root = resolve("runs/internal-training");
  await mkdir(root, { recursive: true });
  const previous = await mkdtemp(join(root, "lineage-test-"));
  const env = process.env.TUTOR_TRAINING_PREVIOUS_DIR;
  try {
    process.env.TUTOR_TRAINING_PREVIOUS_DIR = previous;
    await mkdir(join(previous, "records/training"), { recursive: true });
    const report = {
      priorAttempts: 28,
      batches: [
        {
          status: "stopped",
          budget: {
            attempts: [
              { id: "ok", status: "succeeded" },
              { id: "unresolved", status: "unknown" },
            ],
          },
        },
      ],
    };
    const save = () =>
      writeFile(
        join(previous, "records/training/report.json"),
        JSON.stringify(report),
      );
    await save();
    const first = await trainingLineage(join(root, "next"));
    assert.equal(first.attempts, 30);
    assert.ok(first.reportHash);
    assert.deepEqual(await trainingLineage(join(root, "next")), first);
    await assert.rejects(trainingLineage(previous));
    report.batches[0].status = "running";
    await save();
    await assert.rejects(trainingLineage(join(root, "next")), /尚在运行/);
    report.batches[0].status = "stopped";
    report.batches[0].budget.attempts.push({ id: "ok", status: "succeeded" });
    await save();
    await assert.rejects(trainingLineage(join(root, "next")), /重复/);
  } finally {
    if (env === undefined) delete process.env.TUTOR_TRAINING_PREVIOUS_DIR;
    else process.env.TUTOR_TRAINING_PREVIOUS_DIR = env;
    await rm(previous, { recursive: true });
  }
});
