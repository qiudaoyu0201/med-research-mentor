export function generationFeedback(status: string, message?: string) {
  if (status === "cancelled")
    return {
      role: "status" as const,
      text: "已取消生成，已有内容已保留，可调整要求后重新生成。",
    };
  return {
    role: "alert" as const,
    text: message || "本次未完成，可调整要求后重新生成。",
  };
}
