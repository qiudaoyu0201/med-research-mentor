import type {
  ResearchPlanVersion,
  SourceRef,
} from "../shared/research-plan.ts";

// Only frozen local references with the same paper identity and snapshot share
// a bibliography entry. Original source records and section bindings stay intact.
export function planReferences(version: ResearchPlanVersion) {
  const used = new Set(version.content.sections.flatMap((s) => s.sourceRefs));
  const groups: {
    source: SourceRef;
    members: SourceRef[];
    location: string;
  }[] = [];
  const keys = new Map<string, number>();
  const numbers = new Map<string, number>();
  for (const source of version.topic.sources.filter((s) => used.has(s.id))) {
    const local =
      !source.bibliography &&
      source.paperId &&
      source.sourceVersion &&
      source.paperTitle;
    const key = local
      ? JSON.stringify([
          "local",
          source.paperId,
          source.sourceVersion,
          source.paperTitle,
          source.kind,
          source.url ?? null,
        ])
      : JSON.stringify(["single", source.id]);
    let index = keys.get(key);
    if (index === undefined) {
      index = groups.length;
      keys.set(key, index);
      groups.push({ source, members: [], location: "" });
    }
    groups[index].members.push(source);
    numbers.set(source.id, index + 1);
  }
  for (const group of groups) {
    group.location = [
      ...new Set(group.members.map((s) => s.title + " · " + s.locator)),
    ].join("；");
  }
  return {
    groups,
    citationNumbers(ids: string[]) {
      return [...new Set(ids.map((id) => numbers.get(id)))];
    },
  };
}
