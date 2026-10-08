import type { AssistantMessage, PaperBundle } from "../shared/types.ts";
import type {
  ReadingAction,
  ReadingRange,
  ReadingSession,
} from "../shared/reading-session.ts";
import { digest } from "./materials.ts";

// These are bounded original-text units, not a claim that a chapter was understood.
export function readingUnits(
  paper: PaperBundle,
  paragraph = true,
): ReadingRange[] {
  return paper.sources
    .filter((s) => s.kind === "paper" && !s.image && s.text.trim())
    .flatMap((s) => {
      const units: ReadingRange[] = [];
      for (let start = 0; start < s.text.length;) {
        let end = Math.min(s.text.length, start + (paragraph ? 4800 : 2600));
        if (end < s.text.length) {
          const paragraphEnd = paragraph
            ? s.text.lastIndexOf("\n\n", end - 1)
            : -1;
          const boundary =
            paragraphEnd > start + 1600
              ? paragraphEnd + 1
              : s.text.lastIndexOf("\n", paragraph ? end - 1 : end);
          if (boundary > start + 1300) end = boundary + 1;
          else if (paragraph) {
            const sentence = [
              ...s.text.slice(start, end).matchAll(/[.!?。！？](?:\s|$)/g),
            ].at(-1);
            if (sentence && sentence.index! > 1600)
              end = start + sentence.index! + sentence[0].length;
          }
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
  if (/回.*主线|回.*原来.*位置/.test(q)) return "resume";
  // Local questions and preference changes must not move the reading cursor.
  // Only an explicit navigation request can enter a different paper section.
  if (/(?:跳到|转到|先看|先读|先讲|跳过)[^。！？\n]{0,20}(?:背景|引言|目的|方法|实验|结果|讨论|创新|局限)/.test(q))
    return "jump";
  if (/(?:总结|归纳).*(?:全文|整篇|整篇论文|已读|读过|目前所读)/.test(q) || /^(?:请|帮我)?(?:总结|归纳)(?:一下)?[。！! ]*$/.test(q))
    return "summary";
  if (/这个|这一个|这段|这一段|当前|刚才|上一轮|上一个|上述|重点|总结|归纳/.test(q))
    return "deepen";
  if (/一次.*多讲|多讲些|完整讲|从头.*讲/.test(q)) return "long";
  if (/详细|深入|展开|看不懂|不理解|基础|英文.*不懂|解释|为什么|怎么理解|什么是|方法|创新/.test(q)) return "deepen";
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
  // Historical cursors refer to the old segmentation; preserve their exact units.
  const paragraph =
    !previous || action === "start" || previous.segmentation === "paragraph-v2";
  const units = readingUnits(paper, paragraph);
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
          segmentation: "paragraph-v2",
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
    const terms = /背景|引言|目的/.test(question)
      ? /introduction|background|背景|引言/i
      : /方法|实验/.test(question)
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
  const summary =
    action === "summary" || (action !== "deepen" && cursor >= units.length);
  if (summary && state.summaryDelivered && action !== "summary")
    throw new Error(
      "当前可读原文主线和总结已交付。可回看方法、选择图件或直接提出新问题。",
    );
  // Include all delivered text when it fits. Otherwise sample across the whole
  // journey rather than misrepresenting only the last pages as a paper summary.
  let summaryChars = 0;
  const stride = Math.max(
    1,
    Math.ceil(state.delivered.reduce((n, r) => n + r.end - r.start, 0) / 14000),
  );
  const summaryRanges = state.delivered.filter((r, i) => {
    if (stride > 1 && i % stride !== 0 && i !== state.delivered.length - 1)
      return false;
    if (summaryChars + r.end - r.start > 16000) return false;
    summaryChars += r.end - r.start;
    return true;
  });
  let ranges = summary
    ? summaryRanges
    : action === "deepen" && state.lastRanges.length
      ? state.lastRanges
      : units.slice(cursor, cursor + (action === "long" ? 3 : 1));
  if (!ranges.length) ranges = units.slice(0, 1);
  // Multiple excerpts of the same source are joined without pretending to cover the gap.
  let readingChars = ranges.reduce((n, r) => n + r.end - r.start, 0);
  const contextRanges = summary
    ? []
    : state.lastRanges
        .filter((r) => !ranges.some((current) => current.unitId === r.unitId))
        .slice(-3)
        .filter((r) => {
          if (readingChars + r.end - r.start > 16000) return false;
          readingChars += r.end - r.start;
          return true;
        });
  const visibleRanges = [...contextRanges, ...ranges];
  const sources: PaperBundle["sources"] = [...new Set(visibleRanges.map((r) => r.sourceId))].map(
    (id) => {
      const source = paper.sources.find((s) => s.id === id)!;
      const parts = visibleRanges.filter((r) => r.sourceId === id);
      return {
        ...source,
        text: parts.map((r) => source.text.slice(r.start, r.end)).join("\n\n"),
        locator: parts.map((r) => r.locator).join("；"),
        excerptRanges: parts.map((r) => ({
          start: r.start, end: r.end,
          role: ranges.some((current) => current.unitId === r.unitId)
            ? "current" as const : "context" as const,
        })),
      };
    },
  );
  // Bring the figure actually referenced in this passage alongside its caption.
  // The current provider accepts one original image per generation.
  if (!summary) {
    const currentText = ranges
      .map((r) =>
        paper.sources
          .find((s) => s.id === r.sourceId)!
          .text.slice(r.start, r.end),
      )
      .join("\n");
    const figure = [
      ...currentText.matchAll(/(?:Fig(?:ure)?\.?|图)\s*(\d+)/gi),
    ].find(
      (match) =>
        !/(?:Extended\s+Data|Supplementary|Supplemental|补充|扩展)\s*$/i.test(
          currentText.slice(Math.max(0, match.index! - 30), match.index),
        ),
    )?.[1];
    const image =
      figure &&
      paper.sources.find(
        (s) =>
          s.image &&
          s.figure &&
          new RegExp(`^${figure}(?:[^0-9]|$)`).test(s.figure),
      );
    if (image && readingChars + image.text.length <= 18000) sources.push(image);
  }
  const goal = `${question}\n中文带读：${summary ? "仅总结已经交付的范围，标明未覆盖部分" : action === "deepen" ? "按用户本次要求解释或概括当前片段，不强行展开，不推进下一片段" : action === "start" ? "先说明研究问题、对象和阅读方向，再讲清第一个单元" : "讲清本次新原文单元，已讲概念只作必要衔接，不重复上一轮全文"}。${summary && state.delivered.length > ranges.length ? `本次从已交付范围中选取${ranges.length}个片段用于回顾，未重载全部已读原文；概括研究主线与关键证据，明确缺少的部分，不称逐项核验的全文总结。` : ""}英文术语首次给英文与通俗中文解释，区分原意、基础补充与推断，不称已读全文。当前位置：${ranges.map((r) => r.locator).join("；")}。${contextRanges.length ? `同时提供了前情原文供衔接与核对，前情范围 ${contextRanges.map((r) => r.locator).join("；")}。` : ""}`;
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
