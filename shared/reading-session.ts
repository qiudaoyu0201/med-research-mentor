export type ReadingAction =
  "start" | "continue" | "deepen" | "jump" | "long" | "summary" | "resume";
export interface ReadingRange {
  unitId: string;
  sourceId: string;
  sourceHash: string;
  excerptHash: string;
  start: number;
  end: number;
  locator: string;
}
export interface ReadingSession {
  paperId: string;
  paperVersion: string;
  revision: number;
  cursor: number;
  mainCursor: number;
  topic: string | null;
  delivered: ReadingRange[];
  lastRanges: ReadingRange[];
  lastTurnId: string;
  summaryDelivered: boolean;
  label: string;
}
