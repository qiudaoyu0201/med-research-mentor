import type { ConversationState, PaperBundle } from "../shared/types.ts";
import type { WorkspaceIndex } from "../shared/workspace.ts";
import { digest } from "./materials.ts";

export function visibleWorkspace(
  index: WorkspaceIndex,
  papers: PaperBundle[],
  conversations: ConversationState[],
  known?: Record<string, string>,
) {
  const visible = papers.filter(
    (p) => !index.papers.find((m) => m.paperId === p.id)?.archived,
  );
  const paperIds = visible.map((p) => p.id);
  const paperRevisions = Object.fromEntries(
    visible.map((p) => [p.id, digest(p)]),
  );
  return {
    papers: known
      ? visible.filter((p) => known[p.id] !== paperRevisions[p.id])
      : visible,
    paperIds,
    paperRevisions,
    conversations: conversations.filter(
      (c) => !c.paperId || paperIds.includes(c.paperId),
    ),
  };
}
