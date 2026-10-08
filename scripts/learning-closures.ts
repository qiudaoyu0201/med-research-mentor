import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { RecordStorage } from "../server/storage.ts";
import { createProvider } from "../server/model-config.ts";
import { trainingAdmission } from "../server/training-admission.ts";
import {
  claimClosureHistory,
  assertClosureHistoryClaim,
  prepareClosureExperiment,
  stepClosureExperiment,
  type ClosureManifest,
  type ClosureExperiment,
} from "../server/closure-experiment.ts";

export async function main() {
  const [command, manifestPath, output] = process.argv.slice(2);
  if (
    !["prepare", "step", "run", "status"].includes(command) ||
    !manifestPath ||
    !output
  )
    throw new Error(
      "用法：training:closures prepare|step|run|status <冻结清单.json> <实验目录>",
    );
  const directory = resolve(output),
    root = resolve("runs/internal-training"),
    rel = relative(root, directory);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("使用独立内部训练目录。");
  await mkdir(directory, { recursive: true });
  const store = new RecordStorage(join(directory, "records"));
  if (command === "status") {
    const state = await store.read<ClosureExperiment>(
      "closure-experiments",
      "report",
    );
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  // Share the existing training dispatch lock. A stale lock is evidence to inspect,
  // never a reason to resend an unknown remote request.
  const lockPath = join(root, "dispatch.lock");
  const lock = await open(lockPath, "wx");
  const controller = new AbortController(),
    cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const manifest: ClosureManifest = JSON.parse(
      await readFile(resolve(manifestPath), "utf8"),
    );
    const provider = createProvider();
    const persist = (state: ClosureExperiment) =>
      store.save("closure-experiments", "report", state);
    let state: ClosureExperiment;
    if (command === "prepare") {
      state = await prepareClosureExperiment(manifest, provider);
      const claim = await open(join(directory, "closure-manifest.json"), "wx");
      try {
        await claim.writeFile(JSON.stringify(manifest, null, 2));
      } finally {
        await claim.close();
      }
      // The same historical frontier cannot fund another fresh directory.
      // Keep this claim after completion; the next experiment inherits this report.
      await claimClosureHistory(
        join(root, "closure-history-claims"),
        manifest.history.sha256,
        directory,
        state.contractHash,
      );
      await persist(state);
    } else {
      const frozen = JSON.parse(
        await readFile(join(directory, "closure-manifest.json"), "utf8"),
      );
      if (JSON.stringify(frozen) !== JSON.stringify(manifest))
        throw new Error("清单与已准备实验不一致。");
      state = await store.read<ClosureExperiment>(
        "closure-experiments",
        "report",
      );
      await assertClosureHistoryClaim(
        join(root, "closure-history-claims"),
        manifest.history.sha256,
        directory,
        state.contractHash,
      );
      do {
        await stepClosureExperiment(
          manifest,
          state,
          provider,
          persist,
          controller.signal,
          trainingAdmission,
        );
        // Continue using exactly the durable snapshot, including costs.
        state = await store.read<ClosureExperiment>(
          "closure-experiments",
          "report",
        );
      } while (command === "run" && state.status === "pending");
    }
    console.log(
      JSON.stringify(
        {
          status: state.status,
          historicalAttempts: state.historicalAttempts,
          combinedAttempts: state.combinedAttempts,
          phases: state.phases.map((p) => ({
            id: p.id,
            stage: p.closure.stage,
            status: p.closure.status,
            transferPassed: p.closure.transferPassed,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    await lock.close();
    await unlink(lockPath);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
