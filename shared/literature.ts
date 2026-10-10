import type { SourceRef } from "./research-plan.ts";
export interface LiteratureSearch {
  id: string;
  cacheKey?: string;
  cacheHit?: boolean;
  cachedFrom?: string;
  excluded?: SourceRef[];
  topicVersion: string;
  query: string;
  queryReason: string;
  startedAt: string;
  completedAt?: string;
  status: "completed" | "empty" | "failed" | "cancelled";
  requests: {
    url: string;
    status: number | null;
    error?: string;
    at: string;
  }[];
  candidatePmids: string[];
  selected: SourceRef[];
  selectionReason: string;
  limitations: string[];
  error?: string;
}
