import { assertClosureProducts } from "./closure-product-gate.ts";
import { readFile, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { trainingEngine } from "./training-engine.ts";
import { digest } from "./materials.ts";
import {
  createClosure,
  advanceClosure,
  type ClosureInput,
  type ClosureState,
} from "./learning-closure.ts";
import type { Provider } from "./provider.ts";

export interface FrozenFile {
  path: string;
  sha256: string;
}
export async function claimClosureHistory(
  claims: string,
  historyHash: string,
  directory: string,
  contractHash: string,
) {
  if (!/^[a-f0-9]{64}$/.test(historyHash))
    throw new Error("历史文件指纹无效。");
  await mkdir(claims, { recursive: true });
  const claim = await open(join(claims, `${historyHash}.json`), "wx");
  try {
    await claim.writeFile(JSON.stringify({ directory, contractHash }));
  } finally {
    await claim.close();
  }
}
export async function assertClosureHistoryClaim(
  claims: string,
  historyHash: string,
  directory: string,
  contractHash: string,
) {
  if (!/^[a-f0-9]{64}$/.test(historyHash))
    throw new Error("历史文件指纹无效。");
  const claim = JSON.parse(
    await readFile(join(claims, `${historyHash}.json`), "utf8"),
  );
  if (claim.directory !== directory || claim.contractHash !== contractHash)
    throw new Error("历史账本已绑定其他实验目录或合同，不能复制后重跑。");
}
export interface ClosureManifest {
  version: "closure-experiment-v1";
  id: string;
  history: FrozenFile;
  crossValidation?: FrozenFile;
  /** Each input is a frozen ClosureInput, not a regenerated learner answer. */
  phases: {
    id: string;
    kind: "reading" | "ppt" | "proposal";
    input: FrozenFile;
    product?: FrozenFile;
    files: FrozenFile[];
  }[];
}
export interface ClosureExperiment {
  version: "closure-experiment-v1";
  contractHash: string;
  historicalAttempts: number;
  combinedAttempts: number;
  status: "pending" | "complete" | "blocked";
  phases: { id: string; closure: ClosureState }[];
}
export async function frozenBytes(file: FrozenFile) {
  const bytes = await readFile(file.path);
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
    throw new Error(`冻结文件已变化：${file.path}`);
  return bytes;
}

/** Accept only explicit known report shapes; never treat an absent counter as zero. */
export function inheritedClosureAttempts(report: any): number {
  if (["running", "pending", "ready"].includes(report.status))
    throw new Error("前序实验尚未终止。");
  const budgets =
    report.version === "closure-experiment-v1"
      ? report.phases?.map((p: any) => p.closure.budget)
      : (report.batches?.map((b: any) => b.budget) ??
        (report.batch ? [report.batch.budget] : undefined));
  if (
    !Array.isArray(budgets) ||
    !budgets.length ||
    budgets.some((b: any) => !Array.isArray(b.attempts))
  )
    throw new Error("无法识别前序账本，禁止从零开始。");
  const attempts = budgets.flatMap((b: any) => b.attempts);
  if (
    attempts.some((a: any) => a.status !== "succeeded") ||
    new Set(attempts.map((a: any) => a.id)).size !== attempts.length
  )
    throw new Error("前序请求未全部确认或编号重复，不自动重发。");
  if (
    report.batches?.some((b: any) => b.status === "running") ||
    report.batch?.status === "running" ||
    report.phases?.some((p: any) => p.closure.inFlight)
  )
    throw new Error("前序阶段仍活动。");
  const inherited =
    report.version === "closure-experiment-v1"
      ? report.historicalAttempts
      : report.priorAttempts;
  const total =
    report.combinedAttempts ??
    (Number.isSafeInteger(inherited) ? inherited + attempts.length : NaN);
  if (
    !Number.isSafeInteger(total) ||
    total < attempts.length ||
    total < 1 ||
    (inherited !== undefined &&
      (!Number.isSafeInteger(inherited) ||
        inherited < 0 ||
        total !== inherited + attempts.length))
  )
    throw new Error("前序累计消耗不一致或缺失。");
  return total;
}

async function loadContract(manifest: ClosureManifest, provider: Provider) {
  if (
    manifest.version !== "closure-experiment-v1" ||
    !/^[\w-]{1,100}$/.test(manifest.id) ||
    !Array.isArray(manifest.phases) ||
    !manifest.phases.length ||
    new Set(manifest.phases.map((p) => p.id)).size !== manifest.phases.length ||
    ["reading", "ppt", "proposal"].some(
      (kind) => !manifest.phases.some((p) => p.kind === kind),
    )
  )
    throw new Error("闭环计划必须保留阅读、汇报、研究方案三类阶段及唯一编号。");
  if (manifest.crossValidation || manifest.phases.some((p) => p.product)) await assertClosureProducts(manifest);
  const historicalAttempts = inheritedClosureAttempts(
    JSON.parse((await frozenBytes(manifest.history)).toString()),
  );
  const inputs: ClosureInput[] = [];
  const kinds = {
    reading: "evidence-retelling",
    ppt: "report-outline",
    proposal: "design-draft",
  };
  for (const phase of manifest.phases) {
    const input: ClosureInput = JSON.parse(
      (await frozenBytes(phase.input)).toString(),
    );
    if (
      !kinds[phase.kind] ||
      input.initial.task.kind !== kinds[phase.kind] ||
      !phase.files.length
    )
      throw new Error("阶段类型或冻结材料文件缺失。");
    for (const image of [
      input.initialImage,
      input.transferImage,
      ...input.learner.exposures.map((e) => e.image),
    ])
      if (
        image &&
        !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)
      )
        throw new Error(
          "闭环原图必须以内嵌图片字节冻结，不能引用可变路径或网址。",
        );
    for (const file of phase.files) await frozenBytes(file);
    inputs.push(input);
  }
  const contractHash = digest({
    manifest,
    engine: await trainingEngine(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    provider: {
      id: provider.id,
      model: provider.model,
      settings: provider.settings,
      capabilities: provider.capabilities,
      billingMode: provider.billingMode,
    },
  });
  return { inputs, historicalAttempts, contractHash };
}

export async function prepareClosureExperiment(
  manifest: ClosureManifest,
  provider: Provider,
): Promise<ClosureExperiment> {
  const loaded = await loadContract(manifest, provider);
  return {
    version: manifest.version,
    contractHash: loaded.contractHash,
    historicalAttempts: loaded.historicalAttempts,
    combinedAttempts: loaded.historicalAttempts,
    status: "pending",
    phases: manifest.phases.map((phase, i) => ({
      id: phase.id,
      closure: createClosure(`${manifest.id}-${i}`, loaded.inputs[i], provider),
    })),
  };
}

/** One counted stage. A completed phase never hides unrun phases in other functions. */
export async function stepClosureExperiment(
  manifest: ClosureManifest,
  state: ClosureExperiment,
  provider: Provider,
  persist: (state: ClosureExperiment) => Promise<void>,
  signal: AbortSignal,
  admit: () => Promise<unknown>,
) {
  const loaded = await loadContract(manifest, provider);
  if (
    state.version !== manifest.version ||
    state.contractHash !== loaded.contractHash ||
    state.historicalAttempts !== loaded.historicalAttempts ||
    state.phases.length !== manifest.phases.length ||
    state.phases.some((p, i) => p.id !== manifest.phases[i].id)
  )
    throw new Error("实验合同、阶段、模型或历史消耗已变化。");
  const used = () =>
    state.phases.reduce((n, p) => n + p.closure.budget.attempts.length, 0);
  if (state.combinedAttempts !== state.historicalAttempts + used())
    throw new Error("累计消耗与阶段账本不符。");
  if (
    state.status === "blocked" ||
    state.phases.some(
      (p) =>
        p.closure.status === "blocked" ||
        p.closure.inFlight ||
        p.closure.budget.attempts.some((a) => a.status !== "succeeded"),
    )
  )
    throw new Error("实验存在阻塞或未知请求，保留账本，不重发。");
  const phase = state.phases.find((p) => p.closure.status !== "complete");
  if (!phase) {
    if (state.phases.some((p) => p.closure.stage !== "done"))
      throw new Error("阶段终态不一致。");
    state.status = "complete";
    await persist(structuredClone(state));
    return;
  }
  if (state.status === "complete")
    throw new Error("实验完成标记与待运行阶段不一致。");
  signal.throwIfAborted();
  await admit();
  const save = async () => {
    state.combinedAttempts = state.historicalAttempts + used();
    state.status = state.phases.some((p) => p.closure.status === "blocked")
      ? "blocked"
      : state.phases.every((p) => p.closure.status === "complete")
        ? "complete"
        : "pending";
    await persist(structuredClone(state));
  };
  await advanceClosure(
    phase.closure,
    loaded.inputs[state.phases.indexOf(phase)],
    provider,
    async (snapshot) => {
      phase.closure = snapshot;
      await save();
    },
    signal,
  );
}
