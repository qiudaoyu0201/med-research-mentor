import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { parse } from "yaml";
import type { Module } from "../shared/types.ts";

const skillRoot = resolve("skills");
export function parseSkill(text: string, id: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${id}: 缺少 Skill YAML 入口`);
  const metadata = parse(match[1]);
  if (
    !metadata ||
    metadata.name !== id ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ||
    id.length > 64 ||
    typeof metadata.description !== "string" ||
    !metadata.description.trim() ||
    metadata.description.length > 1024
  )
    throw new Error(`${id}: Skill 名称或触发说明无效`);
  return {
    id,
    name: id,
    description: metadata.description,
    metadata,
    body: match[2],
  };
}
export async function skillCatalog() {
  return Promise.all(
    (await readdir(skillRoot))
      .filter((id) => id !== "shared")
      .sort()
      .map(async (id) => {
        const entry = parseSkill(
          await readFile(resolve(skillRoot, id, "SKILL.md"), "utf8"),
          id,
        );
        return {
          id: entry.id,
          name: entry.name,
          description: entry.description,
        };
      }),
  );
}
export async function loadSkill(
  id: string,
  override?: { id: string; text: string; version: string },
) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error("Skill 编号无效");
  const original = await readFile(resolve(skillRoot, id, "SKILL.md"), "utf8");
  const entry = parseSkill(original, id);
  const manifest = JSON.parse(
    await readFile(resolve(skillRoot, id, "manifest.json"), "utf8"),
  );
  const text = override?.id === id ? override.text : entry.body;
  const version = override?.id === id ? override.version : manifest.version;
  await validateSkillReferences(id, text);
  return {
    id,
    text,
    version,
    description: entry.description,
    hash: `${version}:${createHash("sha256")
      .update(original + text)
      .digest("hex")
      .slice(0, 12)}`,
  };
}
export async function loadSkillReference(id: string, path: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || isAbsolute(path))
    throw new Error("Skill 引用路径无效");
  const root = await realpath(resolve(skillRoot, id));
  const target = await realpath(resolve(root, path));
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Skill 引用不能越过包目录");
  return readFile(target, "utf8");
}
async function validateSkillReferences(id: string, body: string) {
  for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
    const link = match[1].split("#")[0];
    if (!link || /^(https?:|mailto:)/.test(link)) continue;
    await loadSkillReference(id, link);
  }
}
export const routes: Record<Module, string[]> = {
  paper: [
    "medical-paper-guide",
    "medical-term-explainer",
    "medical-evidence-chain",
  ],
  method: ["medical-method-tutor", "medical-term-explainer"],
  figure: ["medical-figure-tutor", "medical-evidence-chain"],
  ppt: [
    "medical-journal-club-ppt",
    "medical-term-explainer",
    "medical-evidence-chain",
  ],
};
export async function loadSkills(
  module: Module | Module[],
  override?: { id: string; text: string; version: string },
) {
  const ids = [
    ...new Set(
      (Array.isArray(module) ? module : [module]).flatMap((m) => routes[m]),
    ),
    "medical-novice-simulator",
    "medical-grounding-check",
  ];
  const shared = await readFile("skills/shared/rules.md", "utf8");
  const modules = await Promise.all(
    ids.map(async (id) => {
      return loadSkill(id, override);
    }),
  );
  const digest = (text: string) =>
    createHash("sha256").update(text).digest("hex").slice(0, 12);
  return {
    shared,
    modules,
    versions: Object.fromEntries([
      ["shared", digest(shared)],
      ...modules.map((m) => [m.id, m.hash]),
    ]),
  };
}
export async function assistantRules() {
  const skill = await loadSkill("medical-research-assistant");
  return { text: skill.text, version: skill.hash };
}
export async function allSkills() {
  return Promise.all(
    (await readdir("skills"))
      .filter((id) => id !== "shared")
      .map(async (id) => ({
        ...JSON.parse(await readFile(`skills/${id}/manifest.json`, "utf8")),
        text: await readFile(`skills/${id}/SKILL.md`, "utf8"),
      })),
  );
}
