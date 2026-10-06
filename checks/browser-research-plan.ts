import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.TUTOR_BASE_URL ?? "http://127.0.0.1:4327";
const folder = "runs/research-plan-implementation/browser";
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const report = {
  status: "running",
  modelCalls: 0,
  assertions: [] as string[],
  screenshots: [] as string[],
};
async function api(path: string, body?: unknown) {
  const response =
    body === undefined
      ? await page.request.get(base + path)
      : await page.request.post(base + path, { data: body });
  assert.ok(response.ok(), await response.text());
  return response.json();
}
try {
  await page.goto(base);
  await page.getByRole("button", { name: "研究方案", exact: true }).click();
  await page.getByRole("button", { name: "新方案", exact: true }).click();
  await page
    .getByLabel("研究问题或方向", { exact: true })
    .fill("医学对照设计 · 浏览器验收");
  await page
    .getByLabel("对象、资源和限制", { exact: true })
    .fill("有限设备；先看框架，不编样本量");
  assert.equal(
    await page.getByLabel("研究类型", { exact: true }).isVisible(),
    false,
  );
  await page.getByText("更多设置（可选）", { exact: true }).click();
  await page
    .getByLabel("研究类型", { exact: true })
    .selectOption("basic-translational");
  await page.getByLabel("方案讲解程度", { exact: true }).selectOption("brief");
  const createdResponse = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith("/api/research-plans"),
  );
  let firstGeneration: any;
  await page.route("**/api/research-plans/*/jobs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    firstGeneration = route.request().postDataJSON();
    return route.fulfill({
      status: 409,
      json: { error: "固定生成提交响应，不调用模型" },
    });
  });
  await page.getByRole("button", { name: "生成方案", exact: true }).click();
  const p = await (await createdResponse).json();
  await page
    .getByRole("alert")
    .getByText("固定生成提交响应，不调用模型")
    .waitFor();
  assert.equal(firstGeneration.action, "generate");
  assert.equal(firstGeneration.expectedTopicVersion, p.topic.version);
  const firstGenerationKey = firstGeneration.requestKey;
  await page
    .getByRole("button", { name: "查询／重试同一请求", exact: true })
    .click();
  assert.equal(firstGeneration.requestKey, firstGenerationKey);
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  await page.unroute("**/api/research-plans/*/jobs");
  assert.equal(p.topic.sources.length, 0);
  assert.equal(p.currentVersion, null);
  await page
    .getByRole("button", { name: "起草并轻量核对", exact: true })
    .waitFor();
  report.assertions.push(
    "无 PDF 一次点击创建并提交生成；非必填设置默认折叠，展开后可保存；并列入口可达",
  );
  const seed = await api(`/api/research-plans/${p.id}/versions`, {
    expectedVersion: null,
    expectedTopicVersion: p.topic.version,
    content: {
      title: "未执行的设计草稿",
      sections: [
        {
          id: "design",
          title: "对照与测量",
          text: "用户原稿，拟比较测量对象。",
          rationale: "排除操作解释。",
          kind: "proposal",
          sourceRefs: [],
          unknowns: ["设备和指标待确认"],
        },
      ],
      assumptions: ["基础实验假设"],
      questions: ["现有设备是什么？"],
      limitations: ["没有样本依据，不给固定 n。"],
    },
  });
  await page.getByLabel("章节 1 内容", { exact: true }).waitFor();
  await page
    .getByLabel("章节 1 内容", { exact: true })
    .fill("手动修改后的内容，仍为计划。");
  await page.reload();
  await page.getByRole("button", { name: "研究方案", exact: true }).click();
  await page.getByLabel("章节 1 内容", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("章节 1 内容", { exact: true }).inputValue(),
    "手动修改后的内容，仍为计划。",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "按建议改稿并核对", exact: true })
      .isEnabled(),
    false,
  );
  report.assertions.push("未保存手稿刷新恢复；未保存时生成不覆盖手稿");
  await page.getByRole("button", { name: "保存手动修改", exact: true }).click();
  await page
    .getByText("已保存新版本，原稿保留；本版本尚未核对。", { exact: true })
    .waitFor();
  const saved = await api(`/api/research-plans/${p.id}`);
  assert.equal(saved.versions.length, 2);
  assert.equal(saved.versions[1].review, undefined);
  const markdown = await page.request.get(
    base + `/api/research-plans/${p.id}/exports/${saved.currentVersion}`,
  );
  assert.ok(markdown.ok());
  assert.match(await markdown.text(), /手动修改后的内容/);
  assert.match(await markdown.text(), /未核对/);
  assert.equal(
    await page.getByLabel("保存版本", { exact: true }).isVisible(),
    false,
  );
  await page.getByText("历史版本", { exact: true }).click();
  await page
    .getByLabel("保存版本", { exact: true })
    .selectOption(seed.currentVersion);
  await page.getByRole("button", { name: "恢复为新版本", exact: true }).click();
  await page
    .getByText("已恢复为新版本，历史核对未复用。", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("章节 1 内容", { exact: true }).inputValue(),
    "用户原稿，拟比较测量对象。",
  );
  assert.equal((await api(`/api/research-plans/${p.id}`)).versions.length, 3);
  report.assertions.push("真实 API 保存、精确版本导出、恢复追加版本与核对失效");
  await page
    .getByLabel("方案本轮建议", { exact: true })
    .fill("优先设计理由，不扩写背景");
  let body: any;
  await page.route(`**/api/research-plans/${p.id}/jobs`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    body = route.request().postDataJSON();
    await route.fulfill({
      status: 409,
      json: { error: "并发条件已变化，草稿保留" },
    });
  });
  await page
    .getByRole("button", { name: "按建议改稿并核对", exact: true })
    .click();
  await page.getByRole("alert").getByText("并发条件已变化，草稿保留").waitFor();
  assert.equal(body.instruction, "优先设计理由，不扩写背景");
  const firstKey = body.requestKey;
  await page
    .getByRole("button", { name: "查询／重试同一请求", exact: true })
    .click();
  assert.equal(body.requestKey, firstKey);
  report.assertions.push(
    "固定冲突响应下本轮建议与同键重试正确；此步骤不调用模型",
  );
  await page.unroute(`**/api/research-plans/${p.id}/jobs`);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.evaluate(
      (theme) => (document.documentElement.dataset.researchTheme = theme),
      theme,
    );
    for (const width of [1280, 1440, 1920, 960]) {
      await page.setViewportSize({ width, height: 960 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        ),
        false,
      );
      const name = `${folder}/${theme}-${width}.png`;
      await page.screenshot({ path: name, fullPage: true });
      report.screenshots.push(name);
    }
  }
  report.assertions.push(
    "浅深色、少动效及 960/1280/1440/1920 CSS 视口无横向裁切；不替代原生缩放／真人体验",
  );
  assert.deepEqual(errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  throw e;
} finally {
  await writeFile(
    `${folder}/report.json`,
    JSON.stringify({ ...report, errors }, null, 2),
  );
  await browser.close();
}
