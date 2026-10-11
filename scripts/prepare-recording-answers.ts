import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createProvider } from "../server/model-config.ts";
import { unitSchema, reviewSchema } from "../server/schemas.ts";
import type { PaperBundle } from "../shared/types.ts";

// Offline preparation only: never inserts completed turns or fabricated run logs.
const [paperFile, stepsFile, outputDirectory] = process.argv.slice(2);
if (!paperFile || !stepsFile || !outputDirectory)
  throw new Error(
    "Usage: tsx scripts/prepare-recording-answers.ts PAPER STEPS OUTPUT",
  );
const paper: PaperBundle = JSON.parse(
  await readFile(resolve(paperFile), "utf8"),
);
const steps = z
  .array(
    z.object({
      question: z.string().min(1),
      sourceIds: z.array(z.string()).min(1),
      guidance: z.string(),
    }),
  )
  .min(1)
  .max(8)
  .parse(JSON.parse(await readFile(resolve(stepsFile), "utf8")));
const ids = new Set(steps.flatMap((step) => step.sourceIds));
for (const id of ids)
  if (!paper.sources.some((source) => source.id === id))
    throw new Error(`Unknown source: ${id}`);
const selected = paper.sources.filter((source) => ids.has(source.id));
const sources = selected.map(({ image, ...source }) => source);
const image = selected.find((source) => source.image)?.image;
const schema = z.object({ answers: z.array(unitSchema).length(steps.length) });
const reviewsSchema = z.object({
  reviews: z.array(reviewSchema).length(steps.length),
});
const provider = createProvider();
const output = resolve(outputDirectory);
await mkdir(output, { recursive: true });
const provenance = {
  preparedAt: new Date().toISOString(),
  model: provider.model,
  paperId: paper.id,
  sourceDigest: createHash("sha256")
    .update(JSON.stringify(selected))
    .digest("hex"),
  purpose: "prerecorded-answer-preparation",
};
const instructions = `你是医学科研入门导师。根据论文原文与附图，为连续演示准备回答。每步约350—650汉字，3—5个清楚的小标题，段落短而自然，中英文术语首次解释。回答必须准确，不编造数据、颜色、坐标、处理或原文不存在的结论。citations只用给定source id。严格按照steps次序，question原样保留。第三步回应第二步的引用，第四步接回论文主线而非重新从摘要开始。后一步减少重复解释。TAF与non-TAF是成像与共定位的操作性分类，不应写成绝对空间定位或全部物理断裂。一次简短解释检测分辨率即可。γH2AX是损伤反应标记。比例上升不等于绝对数量上升。只使用材料能支持的具体图像信息。你在做提前准备，不声称实时运行或通过系统多agent全流程。`;
let generated = await provider.generate(
  instructions,
  { steps, sources },
  schema,
  AbortSignal.timeout(240_000),
  image,
);
const calls: unknown[] = [{ role: "generation", usage: generated.usage }];
let approved = false;
let reviews: z.infer<typeof reviewsSchema> | undefined;
for (let round = 0; round < 3; round++) {
  for (const [index, answer] of generated.output.answers.entries()) {
    if (answer.question !== steps[index].question)
      throw new Error("Question order mismatch");
    for (const section of answer.sections)
      for (const citation of section.citations)
        if (!ids.has(citation))
          throw new Error(`Invalid citation: ${citation}`);
  }
  console.log(`Review round ${round + 1}`);
  const checked = await provider.generate(
    "审查科研带读预备稿。逐步核对材料是否支持事实、图号、图像颜色、坐标、时间、比例与数量关系、因果措辞；关注会误导初学者的错误，不纠缠无关细节或要求详讲未问面板。按回答顺序返回reviews。没有问题时issues为空。发现的问题resolved=false，不能假称修正完成。检查引用来源是否吻合。",
    { steps, sources, answers: generated.output.answers },
    reviewsSchema,
    AbortSignal.timeout(240_000),
    image,
  );
  reviews = checked.output;
  calls.push({ role: "review", round, usage: checked.usage, reviews });
  if (
    // Warnings are retained for the recording notes; only unresolved blocking
    // findings prevent a prepared answer from being accepted.
    reviews.reviews.every((review) =>
      review.issues.every((issue) => issue.resolved || issue.severity === "warning"),
    )
  ) {
    approved = true;
    break;
  }
  if (round === 2) break;
  generated = await provider.generate(
    instructions + "\n根据审查逐项修正。保留无错内容，不增加无关细节。",
    { steps, sources, answers: generated.output.answers, reviews },
    schema,
    AbortSignal.timeout(240_000),
    image,
  );
  calls.push({ role: "revision", round, usage: generated.usage });
}
const artifact = {
  ...provenance,
  approved,
  steps,
  answers: generated.output.answers,
  reviews,
  calls,
};
await writeFile(
  join(output, approved ? "answers.json" : "answers-needs-review.json"),
  JSON.stringify(artifact, null, 2),
);
if (!approved)
  throw new Error(
    "Draft saved; review remains unresolved. No approved cache produced.",
  );
const markdown = generated.output.answers
  .map(
    (answer, index) =>
      `## ${index + 1}. ${answer.title}\n\n提问：${answer.question}\n\n` +
      answer.sections
        .map((section) => `### ${section.title}\n\n${section.text}`)
        .join("\n\n") +
      "\n\n" +
      answer.terms
        .map((term) => `${term.name}：${term.explanation}`)
        .join("\n\n"),
  )
  .join("\n\n---\n\n");
await writeFile(
  join(output, "四步预备回答.md"),
  `# 论文带读：四步预备回答\n\n${markdown}\n`,
);
console.log(`Prepared and reviewed ${steps.length} answers: ${output}`);
