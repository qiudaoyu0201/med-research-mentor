import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cases, assistantCases } from "../evals/cases.ts";
import { evaluateRun, generationAttempts } from "../server/evaluation.ts";
import { TaskManager } from "../server/orchestrator.ts";
import { sample } from "../examples/bundle.ts";
import type { Provider } from "../server/provider.ts";
const unit = {
  title: "原理",
  question: "检测",
  terms: [],
  nextQuestion: "对照？",
  sections: [
    {
      title: "测量原理",
      text: "讲解虽然出现扩增、测量、对照，但未解释测量与信号之间的关系。",
      kind: "foundation",
      citations: ["qpcr-basics"],
    },
  ],
};
const review = { issues: [], checkedSources: ["qpcr-basics"], limitations: [] };
test("case registry has ten development and four holdout scenarios", () => {
  const all = [...cases, ...assistantCases];
  assert.equal(all.length, 14);
  assert.equal(all.filter((c) => c.split === "development").length, 10);
  assert.equal(all.filter((c) => c.split === "holdout").length, 4);
});
test("rubric evaluates meaning; keyword presence alone cannot pass", async () => {
  const testCase = cases.find((c) => c.id === "pcr")!;
  const provider: Provider = {
    model: "test",
    async generate(_instructions, input: any, schema) {
      if (input.criteria)
        return {
          output: schema.parse({
            checks: input.criteria.map((criterion: string) => ({
              criterion,
              passed: !criterion.startsWith("语义条件"),
              location: "测量原理",
              sourceIds: ["qpcr-basics"],
              explanation: "未解释荧光读数与复制目标的联系。",
            })),
          }),
        };
      if (input.explanation)
        return { output: schema.parse({ understood: [], breakpoints: [] }) };
      if (input.draft) return { output: schema.parse(review) };
      return { output: schema.parse({ unit, deck: null }) };
    },
  };
  const manager = new TaskManager(provider, async () => {});
  const run = await manager.start(
    {
      paperId: sample.id,
      module: "method",
      mode: "live",
      question: testCase.question,
      sourceIds: testCase.sourceIds,
      profileId: "methods",
      taughtConcepts: [],
    },
    sample,
  );
  await manager.wait(run.id);
  const result = await evaluateRun(
    testCase,
    run,
    sample.sources,
    provider,
    new AbortController().signal,
    async () => {},
  );
  assert.ok(result.screening?.every((s) => s.present));
  assert.equal(result.passed, false);
  assert.match(result.findings.join(" "), /语义条件/);
  assert.equal(generationAttempts(run).length, 4);
  assert.equal(run.budget?.attempts.length, 3);
  assert.equal(run.evaluationBudget?.attempts.length, 1);
});
test("live replay counts evaluator calls, reuses precise baseline, and rejects unreviewed candidates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tutor-replay-"));
  const script = `import assert from 'node:assert/strict'; import {readFile} from 'node:fs/promises'; import {replay,decideRevision} from './server/replay.ts';
const text=await readFile('skills/medical-method-tutor/SKILL.md','utf8'); let calls=0;
const unit={title:'原理',question:'PCR',terms:[],nextQuestion:'对照',sections:[{title:'测量原理',text:'扩增复制目标核酸，荧光测量反映产物积累，对照限定背景，不能替代蛋白功能。',kind:'foundation',citations:['qpcr-basics']}]};
const p={model:'replay-fixture',generate:async(i,x,s)=>{calls++;const o=x.criteria?{checks:x.criteria.map(criterion=>({criterion,passed:true,location:'测量原理',sourceIds:['qpcr-basics'],explanation:'解释测量与信号的联系'}))}:x.explanation?{understood:[],breakpoints:[]}:x.draft?{issues:[],checkedSources:['qpcr-basics'],limitations:[]}:{unit,deck:null};return {output:s.parse(o)}}};
const input={skillId:'medical-method-tutor',text,mode:'live',caseIds:['pcr']};const first=await replay(input,p);assert.equal(first.calls,8);assert.equal(first.baselineCalls,4);assert.equal(first.candidateCalls,4);assert.equal(first.results[0].candidate.passed,true);assert.equal(first.complete,true);
const second=await replay(input,p);assert.equal(second.calls,4);assert.equal(second.results[0].baseline.reused,true);assert.equal(second.results[0].candidate.reused,false);assert.ok(second.results[0].baseline.durationMs>=0);assert.equal(calls,12);await decideRevision(second.id,{decision:'keep',note:'通过确定性合同'});
const staticBatch=await replay({...input,mode:'fixture'},p);await assert.rejects(decideRevision(staticBatch.id,{decision:'keep',note:'只有静态检查'}),/未完成/);
await assert.rejects(replay({...input,caseIds:['term','pcr','flow','figure','chain']},p),/四个/);console.log('replay checks passed');`;
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { env: { ...process.env, TUTOR_DATA_DIR: dir }, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /replay checks passed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
