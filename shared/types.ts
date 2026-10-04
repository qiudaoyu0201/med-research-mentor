export type Module = "paper" | "method" | "figure" | "ppt";
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
  kind: SourceKind;
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
}
