import type {
  BudgetState,
  LearningIntent,
  LearningPreferences,
} from "./types.ts";

export const studyTypeIds = [
  "basic-translational",
  "clinical-observational",
  "clinical-interventional",
  "secondary-research",
  "bioinformatics",
  "medical-imaging",
] as const;
export const studyTypeLabels = {
  "basic-translational": "基础／转化实验",
  "clinical-observational": "临床观察",
  "clinical-interventional": "临床干预",
  "secondary-research": "二次研究",
  bioinformatics: "生物信息／组学",
  "medical-imaging": "医学影像",
} as const satisfies Record<(typeof studyTypeIds)[number], string>;
export type StudyType = (typeof studyTypeIds)[number];
export interface SourceSelector {
  paperId: string;
  sourceVersion: string;
  sourceId: string;
}
export interface SourceRef extends Partial<SourceSelector> {
  sourceType?: "local" | "pubmed";
  bibliography?: {
    pmid: string;
    doi?: string;
    authors: string[];
    year: string;
    journal: string;
    level: "metadata" | "abstract";
    fetchedAt: string;
    crossref: "matched" | "mismatch" | "unavailable" | "no-doi";
    notices: string[];
  };
  id: string;
  kind: "paper" | "foundation" | "interpretation";
  title: string;
  locator: string;
  excerpt: string;
  hash: string;
  verified: boolean;
  url?: string;
}
export interface ResearchTopic {
  id: string;
  version: string;
  question: string;
  conditions: string;
  studyTypes: StudyType[];
  typeStatus: "confirmed" | "provisional" | "unknown";
  sources: SourceRef[];
  learningPreferences: LearningPreferences;
  createdAt: string;
}
export interface TaskContextV2 {
  schemaVersion: "2";
  learningIntent: LearningIntent;
  topicRef: { id: string; version: string };
  capabilityRef: { id: string; version: string };
  researchProfile: {
    domain: "medical";
    studyTypes: StudyType[];
    status: ResearchTopic["typeStatus"];
  };
  artifactRef: { kind: "research-plan"; id: string; version: string | null };
  executionMode: "online";
  workMode: "assisted";
  requestedScope: "direction" | "design-draft" | "full-plan";
  requestGuidance: { currentInstructions: string[] };
  reviewPolicy: "lightweight";
  learningSourceRefs: SourceRef[];
  targetSourceRefs: SourceRef[];
}
// Separate versioned module contract: legacy paper TaskInput never receives a fake paperId.
export interface ResearchTaskInput {
  schemaVersion: "2";
  module: "research-plan";
  context: TaskContextV2;
}
export interface PlanSection {
  id: string;
  title: string;
  text: string;
  rationale: string;
  kind: "proposal" | "hypothesis" | "source-fact" | "possible-result";
  sourceRefs: string[];
  unknowns: string[];
  author: "assistant" | "user" | "mixed" | "unknown";
}
export interface PlanContent {
  title: string;
  sections: PlanSection[];
  assumptions: string[];
  questions: string[];
  limitations: string[];
}
export interface PlanReview {
  id: string;
  jobId: string;
  versionId: string;
  status: "checked" | "issues";
  purposes: ["artifact-quality"];
  issues: {
    id: string;
    sectionId: string;
    severity: "blocking" | "warning";
    message: string;
    evidence: string[];
    status: "open";
  }[];
  checkedSourceRefs: string[];
  limitations: string[];
  createdAt: string;
}
export interface ResearchPlanVersion {
  id: string;
  parentId: string | null;
  restoredFrom?: string;
  createdAt: string;
  topic: ResearchTopic;
  content: PlanContent;
  origin: "assistant" | "user" | "restore";
  jobId?: string;
  review?: PlanReview;
}
export function planVersionReady(version: ResearchPlanVersion) {
  return (
    !!version.review &&
    version.review.versionId === version.id &&
    !version.review.issues.some((issue) => issue.severity === "blocking")
  );
}
export interface ResearchPlan {
  id: string;
  topic: ResearchTopic;
  currentVersion: string | null;
  versions: ResearchPlanVersion[];
  updatedAt: string;
  archived: boolean;
}
export type PlanJobStatus =
  | "queued"
  | "searching"
  | "generating"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "conflict";
export interface PlanJob {
  literature?: import("./literature.ts").LiteratureSearch;
  id: string;
  planId: string;
  status: PlanJobStatus;
  phase: "generation" | "review";
  requestKey: string;
  requestHash: string;
  context: TaskContextV2;
  expectedVersion: string | null;
  resultVersion: string | null;
  candidate?: ResearchPlanVersion;
  review?: PlanReview;
  reviewHistory?: PlanReview[];
  budget: BudgetState;
  createdAt: string;
  error?: string;
  capability: {
    id: string;
    version: string;
    model: string;
    modelFingerprint: string;
    scope: string;
    evidenceLevel: "engineering-preview";
    rulesHash: string;
  };
}
export const planJobDone = (job: PlanJob) =>
  ["completed", "failed", "cancelled", "interrupted", "conflict"].includes(
    job.status,
  );
