import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Module } from "../shared/types.ts";
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
  module: Module,
  override?: { id: string; text: string; version: string },
) {
  const ids = [
    ...routes[module],
    "medical-novice-simulator",
    "medical-grounding-check",
  ];
  const shared = await readFile("skills/shared/rules.md", "utf8");
  const modules = await Promise.all(
    ids.map(async (id) => {
      const text =
        override?.id === id
          ? override.text
          : await readFile(`skills/${id}/SKILL.md`, "utf8");
      const manifest = JSON.parse(
        await readFile(`skills/${id}/manifest.json`, "utf8"),
      );
      return {
        id,
        text,
        version: override?.id === id ? override.version : manifest.version,
      };
    }),
  );
  const digest = (text: string) =>
    createHash("sha256").update(text).digest("hex").slice(0, 12);
  return {
    shared,
    modules,
    versions: Object.fromEntries([
      ["shared", digest(shared)],
      ...modules.map((m) => [m.id, `${m.version}:${digest(m.text)}`]),
    ]),
  };
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
