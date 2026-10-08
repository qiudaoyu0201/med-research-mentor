import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  trainingLineage,
  assertTrainingDispatchLineage,
  iterationLineage,
} from "../server/training-lineage.ts";

test("a renamed training directory cannot silently create a zero-cost root", () => {
  const empty = { previousDirectory: null, reportHash: null, attempts: 0 };
  assert.doesNotThrow(() => assertTrainingDispatchLineage("runs/internal-training/cycle-1", empty));
  assert.throws(() => assertTrainingDispatchLineage("runs/internal-training/cycle-4", empty), /从零/);
  assert.doesNotThrow(() => assertTrainingDispatchLineage("runs/internal-training/cycle-4", {
    previousDirectory: "runs/internal-training/cycle-3", reportHash: "hash", attempts: 4,
  }));
});

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
test("新增额度强制前序关联并继承每一新周期消耗，未知派发或第四周期拒绝", async () => {
  const root = resolve("runs/internal-training");
  await mkdir(root, { recursive: true });
  const previous = await mkdtemp(join(root, "iteration-lineage-test-"));
  const env = process.env.TUTOR_TRAINING_PREVIOUS_DIR;
  try {
    delete process.env.TUTOR_TRAINING_PREVIOUS_DIR;
    await assert.rejects(iterationLineage(join(root, "next")), /显式关联/);
    process.env.TUTOR_TRAINING_PREVIOUS_DIR = previous;
    await mkdir(join(previous, "records/training"), { recursive: true });
    const report = {
      priorAttempts: 44,
      quota: {
        version: "iteration-v1.1-70x3",
        cycle: 1,
        historicalAttempts: 44,
        priorProductAttempts: 0,
        previousReportHash: "a".repeat(64),
        originReportHash: "a".repeat(64),
      },
      batches: [
        {
          status: "complete",
          phase: "M1",
          budget: { attempts: [{ id: "a", status: "succeeded" }] },
        },
      ],
    };
    const save = () =>
      writeFile(
        join(previous, "records/training/report.json"),
        JSON.stringify(report),
      );
    await save();
    const next = await iterationLineage(join(root, "next"));
    assert.equal(next.cycle, 2);
    assert.equal(next.priorProductAttempts, 1);
    assert.equal(next.historicalAttempts, 44);
    assert.equal(next.originReportHash, report.quota.originReportHash);
    assert.notEqual(next.previousReportHash, report.quota.previousReportHash);
    report.batches[0].budget.attempts[0].status = "unknown";
    await save();
    await assert.rejects(iterationLineage(join(root, "next")), /未确认/);
    report.batches[0].budget.attempts[0].status = "succeeded";
    report.priorAttempts = 0;
    await save();
    await assert.rejects(iterationLineage(join(root, "next")), /不一致/);
    report.priorAttempts = 44;
    report.quota.cycle = 3;
    await save();
    await assert.rejects(iterationLineage(join(root, "next")), /无效/);
  } finally {
    if (env === undefined) delete process.env.TUTOR_TRAINING_PREVIOUS_DIR;
    else process.env.TUTOR_TRAINING_PREVIOUS_DIR = env;
    await rm(previous, { recursive: true });
  }
});
