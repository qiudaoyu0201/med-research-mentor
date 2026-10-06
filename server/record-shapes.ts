import { z } from "zod";
import { unitSchema, reviewSchema, deckSchema } from "./schemas.ts";
// Read-time shape checks protect consumers before any nested access. Keep unknown
// fields for backward compatibility; do not fill in missing content or discard it.
const str = z.string(),
  num = z.number().finite(),
  bool = z.boolean(),
  strings = z.array(str);
const object = (shape: Record<string, z.ZodType>) =>
  z.object(shape).passthrough();
const source = object({
  id: str,
  title: str,
  kind: z.enum(["paper", "foundation", "interpretation"]),
  text: str,
  locator: str,
  verified: bool,
  page: num.optional(),
  image: str.optional(),
  relatedFigures: strings.optional(),
});
const review = reviewSchema;
const deck = deckSchema;
const attempt = object({ id: str, status: str });
const budget = object({
  attempts: z.array(attempt),
  limit: num,
  groupLimit: num,
  deadline: str,
  revisions: strings,
});
const topic = object({
  id: str,
  version: str,
  question: str,
  conditions: str,
  studyTypes: strings,
  typeStatus: str,
  sources: z.array(
    object({
      id: str,
      title: str,
      locator: str,
      excerpt: str,
      hash: str,
      paperId: str,
      sourceVersion: str,
      sourceId: str,
    }),
  ),
  learningPreferences: object({ verbosity: str, focus: str }),
});
const content = object({
  title: str,
  sections: z.array(
    object({
      id: str,
      title: str,
      text: str,
      rationale: str,
      kind: str,
      author: str,
      sourceRefs: strings,
      unknowns: strings,
    }),
  ),
  assumptions: strings,
  questions: strings,
  limitations: strings,
});
const planReview = object({
  id: str,
  jobId: str,
  versionId: str,
  status: str,
  issues: z.array(
    object({
      id: str,
      sectionId: str,
      severity: z.enum(["blocking", "warning"]),
      message: str,
      evidence: strings,
    }),
  ),
  checkedSourceRefs: strings,
  limitations: strings,
});
const planVersion = object({
  id: str,
  createdAt: str,
  topic,
  content,
  origin: str,
  review: planReview.optional(),
});
const arrayObjects = z.array(z.record(str, z.unknown()));
const anchor = object({
  paperId: str,
  sourceVersion: str,
  sourceId: str,
  excerpt: str,
});
const shapes: Record<string, z.ZodType> = {
  papers: object({
    id: str,
    title: str,
    version: str,
    scope: str,
    sources: z.array(source),
  }),
  workspace: object({
    projects: z.array(
      object({
        id: str,
        name: str,
        archived: bool,
        createdAt: str,
        updatedAt: str,
      }),
    ),
    papers: z.array(object({ paperId: str, projectId: str.nullable() })),
    notes: z.array(
      object({
        id: str,
        conversationId: str,
        paperId: str.nullable(),
        title: str,
        text: str,
        anchors: z.array(anchor),
        createdAt: str,
        updatedAt: str,
      }),
    ),
    positions: z.array(
      object({
        conversationId: str,
        paperId: str.nullable(),
        panel: z.enum(["sources", "notes"]).nullable(),
      }),
    ),
  }),
  "reading-guides": object({
    id: str,
    paperId: str,
    sourceVersion: str,
    label: str,
    excerpt: str,
    questions: strings,
    budget,
    status: str,
  }),
  conversations: object({
    id: str,
    version: num,
    paperId: str.nullable(),
    sourceVersion: str.nullable(),
    goal: str,
    profileId: str,
    taughtConcepts: arrayObjects,
    userProgress: arrayObjects,
    openQuestions: arrayObjects,
    taskGroups: arrayObjects,
    artifacts: arrayObjects,
    recentTurnIds: strings,
    summaries: arrayObjects,
  }),
  turns: object({
    id: str,
    conversationId: str,
    message: object({ clientMessageId: str, question: str, mode: str }),
    status: str,
    createdAt: str,
    budget,
  }),
  runs: object({
    id: str,
    input: object({
      paperId: str,
      module: str,
      mode: str,
      question: str,
      profileId: str,
      sourceIds: strings,
      taughtConcepts: strings,
    }),
    status: str,
    createdAt: str,
    roles: arrayObjects,
    events: arrayObjects,
    skillVersions: z.record(str, str),
    sourceVersion: str,
    calls: num,
    model: str,
    result: unitSchema.optional(),
    draft: unitSchema.optional(),
    review: review.optional(),
    deck: deck.optional(),
  }),
  "deck-versions": object({
    id: str,
    conversationId: str,
    paperId: str,
    sourceVersion: str,
    sourceIds: strings,
    sourceHash: str,
    createdAt: str,
    status: str,
    outline: deck,
    review,
    roles: arrayObjects,
  }),
  "research-plans": object({
    id: str,
    topic,
    currentVersion: str.nullable(),
    versions: z.array(planVersion),
    updatedAt: str,
    archived: bool,
  }),
  "research-plan-jobs": object({
    id: str,
    planId: str,
    status: str,
    phase: str,
    requestKey: str,
    requestHash: str,
    context: object({
      schemaVersion: str,
      topicRef: object({ id: str, version: str }),
    }),
    expectedVersion: str.nullable(),
    resultVersion: str.nullable(),
    budget,
    instructions: object({ generation: str, review: str }),
    capability: object({ id: str, version: str, model: str }),
  }),
  "display-assets": object({
    image: str,
    width: num.positive(),
    height: num.positive(),
    purpose: z.enum(["page", "original", "legacy", "crop"]),
  }),
  "attachment-originals": object({ base64: str }),
  attachments: object({
    id: str,
    conversationId: str,
    paperId: str.nullable(),
    name: str,
    hash: str,
    status: str,
  }),
  learners: object({
    id: str,
    version: num,
    profile: object({
      id: str,
      version: str,
      background: str,
      concepts: arrayObjects,
    }),
    concepts: arrayObjects,
    visible: arrayObjects,
    observations: arrayObjects,
  }),
  outlines: deck,
};
shapes["task-cache"] = shapes.runs;
shapes.sessions = object({
  paperId: str,
  page: num,
  module: str,
  bookmarks: strings,
  progress: arrayObjects,
});
export function validRecordShape(group: string, value: unknown, id?: string) {
  if (group === "material-cache" && id?.endsWith("-pdf-figures-v2"))
    return object({
      pages: strings,
      parseStatus: str,
      figures: z.array(source.omit({ id: true }).extend({ suffix: str })),
    }).safeParse(value).success;
  return shapes[group]?.safeParse(value).success ?? true;
}
