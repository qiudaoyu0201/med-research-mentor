import type {
  AssistantTurn,
  ConversationState,
  PaperBundle,
  Source,
} from "./types.ts";

export interface Project {
  id: string;
  name: string;
  goal?: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface PaperMetadata {
  paperId: string;
  projectId: string | null;
  displayName?: string;
}
export interface SourceAnchor {
  textView?: "pdf";
  paperId: string;
  sourceVersion: string;
  sourceId: string;
  excerpt: string;
  page?: number;
}
export interface ResearchNote {
  id: string;
  conversationId: string;
  turnId?: string;
  paperId: string | null;
  title: string;
  text: string;
  anchors: SourceAnchor[];
  evidence?: Source[];
  createdAt: string;
  updatedAt: string;
}
export interface ReadingPosition {
  conversationId: string;
  paperId: string | null;
  sourceVersion?: string;
  sourceId?: string;
  panel: "sources" | "notes" | null;
}
export interface WorkspaceIndex {
  projects: Project[];
  papers: PaperMetadata[];
  notes: ResearchNote[];
  positions: ReadingPosition[];
  lastConversationId?: string;
  currentPaperId?: string | null;
  currentProjectId?: string | null;
}
export interface ReadingStart {
  coverage?: {
    sourceIds: string[];
    truncatedSourceIds: string[];
    availableSources: number;
    fullText: false;
  };
  autoGenerate?: boolean;
  paperId: string;
  sourceVersion: string;
  label: string;
  excerpt: string;
  sourceId?: string;
  questions: string[];
  summary?: string;
  sourceIds?: string[];
  status?: "queued" | "running" | "completed" | "failed" | "cancelled";
  error?: string;
}
export type ResearchTurn = AssistantTurn & {
  run?: import("./types.ts").TaskRun;
};
export interface WorkspaceBootstrap {
  index: WorkspaceIndex;
  papers: PaperBundle[];
  conversations: ConversationState[];
  paperRevisions?: Record<string, string>;
  paperIds?: string[];
  recoveryNotice?: string;
}
export function paperName(paper: PaperBundle, index: WorkspaceIndex) {
  return (
    index.papers.find((m) => m.paperId === paper.id)?.displayName || paper.title
  );
}
export function validateAnchor(
  anchor: SourceAnchor,
  paper: PaperBundle,
): Source {
  const source = paper.sources.find(
    (s) => s.id === anchor.sourceId && s.kind === "paper",
  );
  if (
    anchor.paperId !== paper.id ||
    anchor.sourceVersion !== paper.version ||
    !source ||
    !anchor.excerpt.trim() ||
    !(
      source.text.includes(anchor.excerpt) ||
      (anchor.textView === "pdf" &&
        paper.pdfUrl &&
        source.text
          .replace(/\s/g, "")
          .includes(anchor.excerpt.replace(/\s/g, "")))
    ) ||
    anchor.page !== source.page
  ) {
    throw new Error("所选原文不属于当前论文或来源版本，请重新选择。");
  }
  return source;
}

// A source excerpt is available immediately without claiming a model summary.
export function readingStart(paper: PaperBundle): ReadingStart {
  const sources = paper.sources.filter(
    (s) => s.kind === "paper" && s.text.trim().length > 50,
  );
  const source = sources.find((s) => s.section === "overview") ?? sources[0];
  const abstract = source?.text.match(
    /(?:\bAbstract\b|摘要)\s*[:：]?\s*([\s\S]{60,}?)(?=\b(?:Introduction|Keywords|Results|Background)\b|关键词|引言|$)/i,
  )?.[1];
  const study = source?.text.match(
    /(?:\bHere we\b|\bIn this study\b|本研究)[\s\S]{30,}/i,
  )?.[0];
  const excerpt = (abstract || study || source?.text || "")
    .trim()
    .slice(0, 700);
  const subject = paper.title.replace(/\.pdf$/i, "").slice(0, 55);
  const figure = sources.find((s) => s.figure && s.image);
  return {
    paperId: paper.id,
    sourceVersion: paper.version,
    label: abstract
      ? "提取的摘要片段"
      : study
        ? "研究描述摘录"
        : "正文起点摘录",
    excerpt,
    sourceId: source?.id,
    questions: source
      ? [
          `这篇关于「${subject}」的论文要解决什么研究问题？`,
          "结合这篇论文的原文，带我理解核心实验的设计与对照。",
          figure
            ? `带我看这篇论文的 ${figure.figure} 图表。`
            : "这篇论文的结果能支持什么结论，还不能说明什么？",
        ]
      : [],
  };
}
