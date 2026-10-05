import type { CSSProperties } from "react";
export type IconName =
  | "sidebar"
  | "book"
  | "plus"
  | "search"
  | "folder"
  | "gear"
  | "person"
  | "slides"
  | "more"
  | "arrow"
  | "copy"
  | "star"
  | "note"
  | "message"
  | "edit"
  | "paperclip"
  | "chevron";
const paths: Record<IconName, string> = {
  sidebar: "M4 4h16v16H4z M9 4v16 M6 8h1 M6 12h1 M6 16h1",
  book: "M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1z M12 5v15",
  plus: "M12 5v14 M5 12h14",
  search: "M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15 M16 16l5 5",
  folder: "M3 7V5h7l2 2h9v13H3z",
  gear: "m10 3 4 0 .5 2.5 2 1.2 2.4-.8 2 3.4-1.9 1.7v2l1.9 1.7-2 3.4-2.4-.8-2 1.2L14 21h-4l-.5-2.5-2-1.2-2.4.8-2-3.4L5 13v-2L3.1 9.3l2-3.4 2.4.8 2-1.2z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
  person:
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M6 18c1-5 11-5 12 0",
  slides: "M3 4h18v13H3z M12 17v4 M8 21h8 M7 8h5 M7 12h9",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  arrow: "M12 19V5 M6 11l6-6 6 6",
  copy: "M8 8h12v13H8z M16 8V3H3v13h5",
  star: "m12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z",
  note: "M4 3h16v18H4z M8 8h8 M8 12h8 M8 16h5",
  message: "M3 4h18v13H9l-6 4z M7 8h10 M7 12h7",
  edit: "m5 15 11-11 4 4L9 19l-5 1z M14 6l4 4",
  paperclip: "m9 14 7-7a3 3 0 0 1 4 4L10 21a5 5 0 0 1-7-7L14 3 M6 17 17 6",
  chevron: "m9 5 7 7-7 7",
};
export function ResearchIcon({
  name,
  style,
}: {
  name: IconName;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={`rw-icon rw-icon-${name}`}
      style={style}
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="21"
      height="21"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 3.5 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function actionIcon(label: string): IconName {
  if (/复制/.test(label)) return "copy";
  if (/收藏/.test(label)) return "star";
  if (/笔记|记录|版本/.test(label)) return "note";
  if (/汇报|页/.test(label)) return "slides";
  if (/添加|导入/.test(label)) return "plus";
  if (/重命名|编辑|修改|调整/.test(label)) return "edit";
  if (/课题|移动|归档/.test(label)) return "folder";
  if (/原文|论文|来源|图/.test(label)) return "book";
  return "message";
}
