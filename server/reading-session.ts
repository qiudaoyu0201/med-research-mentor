import type { AssistantMessage, PaperBundle } from "../shared/types.ts";
import type {
  ReadingAction,
  ReadingRange,
  ReadingSession,
} from "../shared/reading-session.ts";
import { digest } from "./materials.ts";

// These are bounded original-text units, not a claim that a chapter was understood.
export function readingUnits(paper: PaperBundle): ReadingRange[] {
  return paper.sources
    .filter((s) => s.kind === "paper" && !s.image && s.text.trim())
    .flatMap((s) => {
      const units: ReadingRange[] = [];
      for (let start = 0; start < s.text.length;) {
        let end = Math.min(s.text.length, start + 2600);
        if (end < s.text.length) {
          const boundary = s.text.lastIndexOf("\n", end);
          if (boundary > start + 1300) end = boundary + 1;
        }
        units.push({
          unitId: `${s.id}-${start}-${end}`,
          sourceId: s.id,
          sourceHash: digest(s.text),
          excerptHash: digest(s.text.slice(start, end)),
          start,
          end,
          locator: `${s.locator} · 提取字符 ${start}–${end}`,
        });
        start = end;
      }
      return units;
    });
}
export function readingAction(
  message: AssistantMessage,
  active?: ReadingSession,
): ReadingAction | undefined {
  if (
    message.focus ||
    message.sourceAnchor ||
    message.figureSourceId ||
    message.deckEdit ||
    message.exportRunId ||
    message.module === "ppt" ||
    /PPT|汇报|幻灯/i.test(message.question)
  )
    return;
  if (message.readingAction) return message.readingAction;
  if (!active)
    return /带我.*(?:读|理解)|开始带读|从头.*讲/.test(message.question)
      ? "start"
      : undefined;
  const q = message.question.trim();
  if (/重新开始.*(?:读|讲)|从头开始带读/.test(q)) return "start";
  if (/总结|归纳/.test(q)) return "summary";
  if (/回.*主线|回.*原来.*位置/.test(q)) return "resume";
  if (/一次.*多讲|多讲些|完整讲|从头.*讲/.test(q)) return "long";
  if (/重点|跳到|先看|讲.*方法|创新/.test(q)) return "jump";
  if (/详细|深入|展开|看不懂|不理解|基础|英文.*不懂/.test(q)) return "deepen";
  if (/^(继续|接着|下一|往下)/.test(q)) return "continue";
}
export function prepareReading(
  paper: PaperBundle,
  previous: ReadingSession | undefined,
  action: ReadingAction,
  question: string,
) {
  if (previous && previous.paperVersion !== paper.version && action !== "start")
    throw new Error("论文版本已变化，请明确重新开始带读；旧讨论仍保留。");
  const units = readingUnits(paper);
  if (!units.length)
    throw new Error("没有可读取的论文正文，请在资料中补充原文。");
  if (
    previous &&
    action !== "start" &&
    previous.delivered.some((r) => {
      const s = paper.sources.find((s) => s.id === r.sourceId);
      return (
        !s ||
        digest(s.text) !== r.sourceHash ||
        digest(s.text.slice(r.start, r.end)) !== r.excerptHash
      );
    })
  )
    throw new Error(
      "原文内容与已交付覆盖不一致，请重新对应资料或明确重新开始。",
    );
  const state: ReadingSession =
    previous && action !== "start"
      ? structuredClone(previous)
      : {
          paperId: paper.id,
          paperVersion: paper.version,
          revision: previous?.revision ?? 0,
          cursor: 0,
          mainCursor: 0,
          topic: null,
          delivered: [],
          lastRanges: [],
          lastTurnId: "",
          summaryDelivered: false,
          label: "中文带读起点",
        };
  let cursor = state.cursor;
  if (action === "start") cursor = 0;
  if (action === "long" && /从头/.test(question)) {
    cursor = 0;
    state.topic = null;
  }
  if (action === "resume") {
    cursor = state.mainCursor;
    state.topic = null;
  }
  if (action === "jump") {
    const terms = /方法|实验/.test(question)
      ? /method|material|方法|实验设计/i
      : /创新|局限/.test(question)
        ? /discussion|limitation|讨论|局限/i
        : /result|结果/i;
    const found = units.findIndex((u) =>
      terms.test(
        paper.sources
          .find((s) => s.id === u.sourceId)!
          .text.slice(u.start, u.end),
      ),
    );
    if (found < 0)
      throw new Error(
        "现有正文未定位到所需专题。请选中相关原文或图件后提问，阅读进度保留。",
      );
    if (!state.topic) state.mainCursor = state.cursor;
    state.topic = question;
    cursor = found;
  }
  const summary = action === "summary" || cursor >= units.length;
  if (summary && state.summaryDelivered && action !== "summary")
    throw new Error(
      "当前可读原文主线和总结已交付。可回看方法、选择图件或直接提出新问题。",
    );
  let ranges = summary
    ? state.delivered.slice(-6)
    : action === "deepen" && state.lastRanges.length
      ? state.lastRanges
      : units.slice(cursor, cursor + (action === "long" ? 3 : 1));
  if (!ranges.length) ranges = units.slice(0, 1);
  // Multiple excerpts of the same source are joined without pretending to cover the gap.
  const contextRanges = summary
    ? []
    : state.lastRanges
        .filter((r) => !ranges.some((current) => current.unitId === r.unitId))
        .slice(-3);
  const visibleRanges = [...contextRanges, ...ranges];
  const sources = [...new Set(visibleRanges.map((r) => r.sourceId))].map(
    (id) => {
      const source = paper.sources.find((s) => s.id === id)!;
      const parts = visibleRanges.filter((r) => r.sourceId === id);
      return {
        ...source,
        text: parts.map((r) => source.text.slice(r.start, r.end)).join("\n\n"),
        locator: parts.map((r) => r.locator).join("；"),
      };
    },
  );
  const goal = `${question}\n中文带读：${summary ? "仅总结已经交付的范围，标明未覆盖部分" : action === "deepen" ? "深入解释当前片段，不推进下一片段" : action === "start" ? "先说明研究问题、对象和阅读方向，再讲清第一个单元" : "讲清本次新原文单元，已讲概念只作必要衔接，不重复上一轮全文"}。${summary && state.delivered.length > ranges.length ? `本次只提供最近${ranges.length}个已交付片段，更早讲过的内容未在本轮重新提供；请明示总结范围，不能称全部已读内容的完整总结。` : ""}英文术语首次给英文与通俗中文解释，区分原意、基础补充与推断，不称已读全文。当前位置：${ranges.map((r) => r.locator).join("；")}。${contextRanges.length ? `同时提供了前情原文供衔接与核对，前情范围 ${contextRanges.map((r) => r.locator).join("；")}。` : ""}`;
  return {
    action,
    ranges,
    state,
    paper: { ...paper, sources },
    goal,
    summary,
    nextCursor:
      summary || action === "deepen" ? state.cursor : cursor + ranges.length,
    total: units.length,
  };
}
export function completeReading(
  prepared: ReturnType<typeof prepareReading>,
  turnId: string,
) {
  const { state, ranges, summary, nextCursor, total } = prepared;
  state.revision++;
  state.lastTurnId = turnId;
  state.cursor = nextCursor;
  if (!state.topic) state.mainCursor = nextCursor;
  state.lastRanges = ranges;
  if (!summary)
    state.delivered = [
      ...new Map(
        [...state.delivered, ...ranges].map((r) => [r.unitId, r]),
      ).values(),
    ];
  state.summaryDelivered = summary && nextCursor >= total;
  state.label = summary
    ? `已覆盖 ${state.delivered.length} / ${total} 个原文片段 · 本次总结 ${ranges.length} 个已交付片段`
    : `${state.topic ? "专题带读" : "主线带读"} · 已覆盖 ${state.delivered.length} / ${total} 个原文片段${nextCursor >= total ? "，可继续总结" : "，可接着读"}`;
  return state;
}
