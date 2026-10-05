import type { PaperBundle } from "../shared/types.ts";

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
export async function importPaper(files: File[]) {
  const file = validateImport(files);
  const body = new FormData();
  body.append("pdf", file);
  const response = await fetch("/api/papers", { method: "POST", body });
  const value = await response.json();
  if (!response.ok && !value.paper)
    throw new Error(value.error || "上传失败，请重试。");
  return {
    paper: (value.paper ?? value) as PaperBundle,
    error: value.error as string | undefined,
  };
}
