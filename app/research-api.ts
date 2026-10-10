import type { PaperBundle } from "../shared/types.ts";
import type { WorkspaceBootstrap } from "../shared/workspace.ts";

// Normal navigation still receives a complete snapshot; polling sends only
// paper fingerprints and merges changed material into the previous snapshot.
export async function pollWorkspace(previous?: WorkspaceBootstrap) {
  const response = await fetch("/api/workspace", {
    ...(previous?.paperRevisions
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paperRevisions: previous.paperRevisions }),
        }
      : {}),
  });
  const value: WorkspaceBootstrap & { error?: string } = await response.json();
  if (!response.ok) throw new Error(value.error || "工作区刷新失败，请重试。");
  if (previous && value.paperIds) {
    const papers = new Map(previous.papers.map((paper) => [paper.id, paper]));
    for (const paper of value.papers) papers.set(paper.id, paper);
    value.papers = value.paperIds.map((id) => {
      const paper = papers.get(id);
      if (!paper) throw new Error("资料更新不完整，请重新打开工作区。");
      return paper;
    });
  }
  return value;
}

export async function researchApi<T>(
  url: string,
  body?: unknown,
  method = "POST",
  keepalive = false,
): Promise<T> {
  const response = await fetch(
    url,
    body === undefined
      ? undefined
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          keepalive,
        },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "操作失败，请重试。");
  return value;
}
export function validateImport(files: File[]) {
  if (files.length !== 1)
    throw new Error("每次请导入一个文件，可以继续补充材料。");
  const file = files[0];
  if (/\.(png|jpe?g)$/i.test(file.name))
    throw new Error("图片导入将在内容准入检查完成后开放；现在可以导入 PDF。");
  if (!/\.pdf$/i.test(file.name))
    throw new Error("当前支持 PDF，请先将其他文档导出为 PDF。");
  if (!file.size) throw new Error("文件为空，请重新选择 PDF。");
  if (file.size > 30 * 1024 * 1024)
    throw new Error("PDF 超过 30 MiB，请拆分后导入。");
  return file;
}
export async function importPaper(
  files: File[],
  importId: string = crypto.randomUUID(),
) {
  const file = validateImport(files);
  const body = new FormData();
  body.append("pdf", file);
  const response = await fetch("/api/papers", {
    method: "POST",
    headers: { "X-Import-Id": importId },
    body,
  });
  const value = await response.json();
  if (!response.ok && !value.paper)
    throw new Error(value.error || "上传失败，请重试。");
  return {
    paper: (value.paper ?? value) as PaperBundle,
    error: value.error as string | undefined,
  };
}
