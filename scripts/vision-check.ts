import { chromium } from "playwright";
import { CodexProvider } from "../server/provider.ts";
import { z } from "zod";
const browser = await chromium.launch({ channel: "msedge", headless: true });
let data: Buffer;
try {
  const page = await browser.newPage({ viewport: { width: 300, height: 200 } });
  await page.setContent(
    '<body style="margin:0;background:white;display:grid;place-items:center;height:100vh"><div style="width:90px;height:90px;border-radius:50%;background:#e33333"></div></body>',
  );
  data = await page.screenshot();
} finally {
  await browser.close();
}
const result = await new CodexProvider().generate(
  "只判断所给图片，不使用工具。",
  { question: "白色背景中央是什么颜色和形状？用中文回答。" },
  z.object({ color: z.string(), shape: z.string() }),
  AbortSignal.timeout(180_000),
  "data:image/png;base64," + data.toString("base64"),
);
console.log(JSON.stringify(result));
