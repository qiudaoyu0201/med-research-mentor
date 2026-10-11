import { useEffect } from "react";
import type { GenerationDraft } from "../shared/workspace.ts";
import { researchApi } from "./research-api.ts";

const writes = new Map<string, Promise<unknown>>();
export function useArtifactIntake(
  kind: "ppt" | "plan",
  id: string | undefined,
  intake: GenerationDraft,
  enabled: boolean,
  onError: (message: string) => void,
) {
  const content = JSON.stringify(intake);
  useEffect(() => {
    if (!id || !enabled) return;
    const key = `${kind}:${id}`;
    const save = () => {
      const next = (writes.get(key) ?? Promise.resolve())
        .catch(() => {})
        .then(() =>
          researchApi(
            `/api/artifacts/${kind}/${id}`,
            { intake: JSON.parse(content) },
            "PATCH",
          ),
        );
      writes.set(key, next);
      void next.catch((e) => onError(`草稿尚未同步：${e.message}`));
    };
    const timer = setTimeout(save, 400);
    return () => {
      clearTimeout(timer);
      save();
    };
  }, [kind, id, content, enabled]);
}
