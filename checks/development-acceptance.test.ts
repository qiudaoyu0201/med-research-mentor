import test from "node:test";
import assert from "node:assert/strict";
import type { TaskRun } from "../shared/types.ts";
import { strictDevelopmentAcceptance } from "../server/development-acceptance.ts";

test("strict development rejects remaining learner gaps and partial completed products", () => {
  const run = {
    status: "completed",
    input: { module: "paper" },
    result: {},
    review: { issues: [] },
    novice: { breakpoints: [] },
  } as unknown as TaskRun;
  assert.equal(strictDevelopmentAcceptance(run), true);
  assert.equal(
    strictDevelopmentAcceptance({ ...run, review: undefined }),
    false,
  );
  assert.equal(
    strictDevelopmentAcceptance({ ...run, novice: undefined }),
    false,
  );
  assert.equal(
    strictDevelopmentAcceptance({
      ...run,
      review: {
        ...run.review!,
        issues: [
          {
            id: "gap",
            type: "teaching",
            severity: "warning",
            resolved: false,
            location: "方法",
            suggestion: "补全",
            evidence: [],
          },
        ],
      },
    }),
    false,
  );
  assert.equal(
    strictDevelopmentAcceptance({
      ...run,
      novice: {
        understood: [],
        breakpoints: [
          {
            id: "gap",
            sentence: "群体平均",
            missingConcept: "单个对象",
            question: "怎样区分",
            status: "insufficient",
          },
        ],
      },
    }),
    false,
  );
  assert.equal(
    strictDevelopmentAcceptance({
      ...run,
      input: { ...run.input, module: "ppt", slideCount: 6 },
    }),
    false,
  );
});
