export type Module = "paper" | "method" | "figure" | "ppt";
export type ExplanationDepth =
  "brief" | "standard" | "deep" | "foundations" | "mechanism";
export type Mode = "example" | "live";
export type SourceKind = "paper" | "foundation" | "interpretation";
export interface Source {
  id: string;
  title: string;
  kind: SourceKind;
  text: string;
  locator: string;
  url?: string;
  page?: number;
  figure?: string;
  caption?: string;
  verified: boolean;
  image?: string;
  attachmentId?: string;
  paperId?: string;
  paperVersion?: string;
  section?: "figure" | "results" | "methods" | "overview";
  relatedFigures?: string[];
  foundation?: FoundationMetadata;
}
export interface FoundationMetadata {
  version: string;
  concepts: string[];
  aliases: string[];
  prerequisites: string[];
  scope: string;
  limitations: string;
  status: "candidate" | "available" | "disabled";
  references: {
    id: string;
    title: string;
    url: string;
    locator: string;
    doi?: string;
    pmid?: string;
  }[];
  claims: { text: string; referenceIds: string[] }[];
  verification: { date: string; readScope: string; supportedClaims: string[] };
}
export interface MaterialRequest {
  id: string;
  concept: string;
  question: string;
  reason: string;
  kind: "foundation" | "paper" | "figure";
  paperId: string;
  sourceVersion: string;
  matchedIds: string[];
  status: "provided" | "pending" | "resolved";
}
export interface MaterialSnapshot {
  hash: string;
  phase: "initial" | "revision";
  sources: Source[];
  addedIds: string[];
}
export interface PaperBundle {
  id: string;
  title: string;
  version: string;
  doi?: string;
  scope: string;
  sources: Source[];
  pageCount?: number;
  pdfUrl?: string;
  parseStatus?: string;
}
export interface Section {
  title: string;
  text: string;
  kind: SourceKind | "background";
  citations: string[];
}
export interface LearningUnit {
  title: string;
  question: string;
  sections: Section[];
  terms: { name: string; explanation: string }[];
  nextQuestion: string;
}
export interface Breakpoint {
  id: string;
  sentence: string;
  missingConcept: string;
  question: string;
  status: "open" | "resolved" | "insufficient";
}
export interface NoviceFeedback {
  understood: string[];
  breakpoints: Breakpoint[];
}
export interface ReviewIssue {
  id: string;
  location: string;
  type: "fact" | "scope" | "teaching" | "material";
  evidence: string[];
  suggestion: string;
  severity: "blocking" | "warning";
  resolved: boolean;
}
export interface ReviewResult {
  issues: ReviewIssue[];
  checkedSources: string[];
  limitations: string[];
}
export interface Slide {
  title: string;
  bullets: string[];
  notes: string;
  citations: string[];
  imageSource?: string;
}
export interface DeckOutline {
  slides: Slide[];
}
export interface DeckVersion {
  displayName?: string;
  id: string;
  conversationId: string;
  paperId: string;
  sourceVersion: string;
  sourceIds: string[];
  sourceHash: string;
  createdAt: string;
  parentId?: string;
  restoredFrom?: string;
  runId?: string;
  slideIndex?: number;
  request?: string;
  origin: "example" | "live";
  status:
    | "queued"
    | "revising"
    | "checking"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  outline: DeckOutline;
  review: ReviewResult;
  budget?: BudgetState;
  roles: {
    role: string;
    input: unknown;
    output?: unknown;
    error?: string;
    instructions: string;
  }[];
  error?: string;
}
export interface Profile {
  id: string;
  version: string;
  name: string;
  background: string;
  difficulties: string;
}
export interface TaskInput {
  paperId: string;
  module: Module;
  mode: Mode;
  question: string;
  profileId: string;
  sourceIds: string[];
  taughtConcepts: string[];
  previous?: LearningUnit;
  visibleImage?: string;
  modules?: Module[];
  slideCount?: number;
  contextSummary?: string;
  openQuestions?: { id: string; question: string; sourceIds: string[] }[];
  conversationId?: string;
  turnId?: string;
  groupId?: string;
  missingFoundations?: { id: string; title: string }[];
  workflow?: "direct";
  checks?: { readability: boolean };
  focusedText?: string;
  depth?: ExplanationDepth;
}
export type RunStatus =
  | "queued"
  | "teaching"
  | "novice"
  | "checking"
  | "revising"
  | "rereading"
  | "rechecking"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface RoleRecord {
  attemptId?: string;
  role: string;
  inputKeys: string[];
  input: unknown;
  output?: unknown;
  durationMs: number;
  usage?: unknown;
}
export interface TaskRun {
  id: string;
  input: TaskInput;
  status: RunStatus;
  createdAt: string;
  endedAt?: string;
  calls: number;
  model: string;
  skillVersions: Record<string, string>;
  profileVersion: string;
  sourceVersion: string;
  events: { status: RunStatus; time: string }[];
  roles: RoleRecord[];
  draft?: LearningUnit;
  result?: LearningUnit;
  deck?: DeckOutline;
  novice?: NoviceFeedback;
  review?: ReviewResult;
  error?: string;
  budget?: BudgetState;
  cacheHit?: string;
  materials?: MaterialSnapshot[];
  materialRequests?: MaterialRequest[];
  evaluationBudget?: BudgetState;
}

export interface TokenUsage {
  input: number | null;
  output: number | null;
  cachedInput: number | null;
  total: number | null;
}
export interface Attempt {
  id: string;
  turnId: string;
  groupId: string | null;
  role: string;
  model: string;
  sourceHash: string;
  modelSettings?: { effort: string; imageMode: string; transport: string };
  imageCount?: number;
  skillHash: string;
  startedAt: string;
  durationMs: number;
  status: "reserved" | "succeeded" | "failed" | "cancelled" | "unknown";
  inputChars: number;
  outputChars: number;
  usage?: unknown;
  tokens: TokenUsage;
  rawOutput?: string;
  error?: string;
}
export interface BudgetState {
  limit: number;
  groupLimit: number;
  deadline: string;
  attempts: Attempt[];
  revisions: string[];
  billingMode: "chatgpt";
  amount: null;
}
export type AssistantAction =
  | "paper.read"
  | "method.explain"
  | "figure.explain"
  | "ppt.compose"
  | "ppt.export"
  | "material.request";
export interface AssistantPlan {
  goal: string;
  modules: Module[];
  sourceIds: string[];
  slideCount: number | null;
  groups: { id: string; actions: AssistantAction[]; dependsOn: string[] }[];
  clarification: string | null;
  estimatedCalls: number;
}
export interface AssistantMessage {
  slideCount?: number;
  clientMessageId: string;
  question: string;
  mode: Mode;
  paperId?: string | null;
  module?: Module;
  sourceIds?: string[];
  profileId?: string;
  visibleImage?: string;
  exportRunId?: string;
  focus?: { runId: string; sectionIndex: number; excerpt: string };
  sourceAnchor?: import("./workspace.ts").SourceAnchor;
  figureSourceId?: string;
  attachmentIds?: string[];
  depth?: ExplanationDepth;
  readabilityCheck?: boolean;
  deckEdit?: { versionId: string; slideIndex: number };
}
export interface ConversationState {
  explanationDepth?: ExplanationDepth;
  preferenceRevision?: number;
  mainChat?: boolean;
  id: string;
  version: number;
  title?: string;
  titleEdited?: boolean;
  projectId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  paperId: string | null;
  sourceVersion: string | null;
  goal: string;
  profileId: string;
  taughtConcepts: { name: string; unitId: string }[];
  userProgress: { unitId: string; state: string }[];
  learningRecords?: LearningRecord[];
  openQuestions: { id: string; question: string; sourceIds: string[] }[];
  taskGroups: { id: string; status: string; dependsOn: string[] }[];
  artifacts: { id: string; kind: string; sourceHash: string }[];
  recentTurnIds: string[];
  summaries: { turnId: string; text: string }[];
  lastRunId?: string;
  latestDeckVersionId?: string;
  pending?: {
    questionId?: string;
    question: string;
    sourceIds: string[];
    module?: Module;
  };
}
export interface LearningRecord {
  id: string;
  version: number;
  kind: "favorite" | "feedback" | "question";
  paperId: string | null;
  unitId?: string;
  sectionIndex?: number;
  sourceText?: string;
  text: string;
  feedback?: "read" | "confused" | "understood";
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  history: {
    text: string;
    feedback?: "read" | "confused" | "understood";
    resolved: boolean;
  }[];
}
export interface AssistantReply {
  content: LearningUnit | null;
  artifacts: { id: string; kind: string; url: string }[];
  pendingQuestions: { id: string; question: string; sourceIds: string[] }[];
  nextStep: string;
  deckVersionId?: string;
}
export interface AssistantTurn {
  id: string;
  conversationId: string;
  message: AssistantMessage;
  paperId?: string | null;
  sourceVersion?: string | null;
  attachments?: import("./attachments.ts").ResearchAttachment[];
  status:
    | "queued"
    | "planning"
    | "checking-attachments"
    | "running"
    | "clarification"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  createdAt: string;
  endedAt?: string;
  plan?: AssistantPlan;
  runId?: string;
  budget: BudgetState;
  reply?: AssistantReply;
  error?: string;
}
