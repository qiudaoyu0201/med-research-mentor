import type { ConversationState, PaperBundle } from "../shared/types.ts";
import type { WorkspaceIndex } from "../shared/workspace.ts";
import { paperName } from "../shared/workspace.ts";

export function ResearchNavigation({
  index,
  papers,
  conversations,
  paperId,
  projectId,
  busy,
  search,
  setSearch,
  onPaper,
  onProject,
  onHome,
  onPpt,
  onSettings,
  onRecords,
  mode,
  onImport,
  onCreateProject,
  onEditProject,
  onResume,
  mobile,
  close,
}: {
  index: WorkspaceIndex;
  papers: PaperBundle[];
  conversations: ConversationState[];
  paperId?: string;
  projectId: string | null;
  busy: boolean;
  search: string;
  setSearch: (text: string) => void;
  onPaper: (paper: PaperBundle) => void;
  onProject: (id: string | null) => void;
  onHome: () => void;
  onPpt: () => void;
  onSettings: () => void;
  onRecords: () => void;
  mode: "research" | "ppt";
  onImport: () => void;
  onCreateProject: () => void;
  onEditProject: (id: string) => void;
  onResume: (id: string) => void;
  mobile: boolean;
  close: () => void;
}) {
  const groups = [
    ...index.projects.filter((p) => !p.archived),
    { id: "", name: "未分组论文" },
  ];
  const filtered = papers.filter((p) =>
    paperName(p, index).toLowerCase().includes(search.toLowerCase()),
  );
  const recent = [...conversations]
    .filter((c) => c.recentTurnIds.length)
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
    .slice(0, 4);
  return (
    <>
      {mobile && (
        <button
          className="rp-nav-backdrop"
          aria-label="关闭导航遮罩"
          onClick={close}
        />
      )}
      <aside
        className={`rp-sidebar ${mobile ? "rp-sidebar-open" : ""}`}
        aria-label="课题与论文导航"
      >
        <div className="rp-sidebar-brand">
          <div>
            <strong>
              科研<span>助手</span>
            </strong>
            <small>从一个问题开始读论文</small>
          </div>
          <button
            className="rp-mobile-close"
            aria-label="关闭导航"
            onClick={close}
          >
            ×
          </button>
        </div>
        <nav className="rw-main-nav" aria-label="主导航">
          <button
            aria-current={mode === "research" ? "page" : undefined}
            disabled={busy}
            onClick={onHome}
          >
            论文研究
          </button>
          <button
            aria-current={mode === "ppt" ? "page" : undefined}
            onClick={onPpt}
          >
            PPT 汇报
          </button>
        </nav>
        <button className="rp-new-task" disabled={busy} onClick={onImport}>
          ＋ 导入论文
        </button>
        <label className="rp-search">
          <input
            aria-label="搜索论文"
            placeholder="搜索我的论文"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="rp-sidebar-scroll">
          <div className="rp-section-label">
            我的课题{" "}
            <button
              aria-label="新建课题"
              disabled={busy}
              onClick={onCreateProject}
            >
              ＋
            </button>
          </div>
          {groups.map((group) => {
            const items = filtered.filter((p) => {
              const owner = index.papers.find(
                (m) => m.paperId === p.id,
              )?.projectId;
              const visible = index.projects.some(
                (g) => g.id === owner && !g.archived,
              )
                ? owner
                : "";
              return visible === group.id;
            });
            return (
              <details
                key={group.id}
                className="rw-project"
                open={!!search || projectId === (group.id || null)}
              >
                <summary>
                  <span>{group.name}</span>
                  <small>{items.length}</small>
                </summary>
                <div className="rw-project-actions">
                  <button
                    disabled={busy}
                    onClick={() => onProject(group.id || null)}
                  >
                    讨论方向
                  </button>
                  {group.id && (
                    <button
                      aria-label={`管理课题 ${group.name}`}
                      disabled={busy}
                      onClick={() => onEditProject(group.id)}
                    >
                      管理
                    </button>
                  )}
                </div>
                <div className="rp-task-list">
                  {items.map((paper) => (
                    <button
                      key={paper.id}
                      className={`rp-task ${paperId === paper.id ? "rp-task-active" : ""}`}
                      disabled={busy}
                      onClick={() => onPaper(paper)}
                      title={paperName(paper, index)}
                    >
                      <span>{paperName(paper, index)}</span>
                      {paper.id === "xu-2018" && <small>示例材料</small>}
                    </button>
                  ))}
                </div>
                {!items.length && (
                  <p className="rp-search-empty">
                    {search ? "没有匹配论文" : "可在此课题导入论文"}
                  </p>
                )}
              </details>
            );
          })}
          <div className="rp-section-label rw-recents">最近讨论</div>
          {recent.map((c) => (
            <button
              key={c.id}
              className="rp-task"
              disabled={busy}
              onClick={() => onResume(c.id)}
            >
              <span>
                {c.title || c.goal || "科研讨论"}
                <small className="rw-recent-paper">
                  {papers.find((p) => p.id === c.paperId)
                    ? paperName(
                        papers.find((p) => p.id === c.paperId)!,
                        index,
                      )
                    : "研究想法"}
                </small>
              </span>
            </button>
          ))}
        </div>
        <footer className="rw-sidebar-footer">
          <small>PDF · 上限 30 MiB / 100 页</small>
          <button onClick={onSettings}>设置</button>
          <button onClick={onRecords}>个人记录</button>
        </footer>
      </aside>
    </>
  );
}
