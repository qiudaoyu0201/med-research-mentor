import type { ConversationState, PaperBundle } from "../shared/types.ts";
import type { WorkspaceIndex } from "../shared/workspace.ts";
import { paperName } from "../shared/workspace.ts";
import { ObjectMenu } from "./research-menu.tsx";
import { ResearchIcon } from "./research-icons.tsx";

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
  onPlan,
  onSettings,
  onRecords,
  mode,
  onImport,
  onCreateProject,
  onEditProject,
  onEditPaper,
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
  onPlan: () => void;
  onSettings: () => void;
  onRecords: () => void;
  mode: "research" | "ppt" | "plan";
  onImport: () => void;
  onCreateProject: () => void;
  onEditProject: (id: string) => void;
  onEditPaper: (paper: PaperBundle, archive?: boolean) => void;
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
    .filter((c) => c.recentTurnIds.length && c.purpose !== "ppt-generation")
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
              医学科研<span>导师</span>
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
            aria-label="论文带读"
            title="论文带读"
            aria-current={mode === "research" ? "page" : undefined}
            disabled={busy}
            onClick={onHome}
          >
            <ResearchIcon name="book" />
            <span>论文带读</span>
          </button>
          <button
            aria-label="研究方案"
            aria-current={mode === "plan" ? "page" : undefined}
            onClick={onPlan}
          >
            <ResearchIcon name="book" />
            <span>研究方案</span>
          </button>
          <button
            aria-label="PPT 汇报"
            aria-current={mode === "ppt" ? "page" : undefined}
            onClick={onPpt}
          >
            <ResearchIcon name="slides" />
            <span>PPT 汇报</span>
          </button>
        </nav>
        {mode !== "research" ? (
          <div id="generation-navigation" className="tg-navigation-slot" />
        ) : (
          <>
            <button
              className="rp-new-task"
              aria-label="＋ 导入论文"
              title="导入论文"
              disabled={busy}
              onClick={onImport}
            >
              <ResearchIcon name="plus" />
              <span>＋ 导入论文</span>
            </button>
            <label className="rp-search">
              <ResearchIcon name="search" />
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
                      <ObjectMenu
                        objectKey={group.id}
                        label={`课题操作 ${group.name}`}
                        actions={[
                          {
                            label: "讨论方向",
                            run: () => onProject(group.id || null),
                          },
                          ...(group.id
                            ? [
                                {
                                  label: "重命名／归档课题",
                                  run: () => onEditProject(group.id),
                                },
                              ]
                            : []),
                        ]}
                      >
                        <span>{group.name}</span>
                        <small>{items.length}</small>
                      </ObjectMenu>
                    </summary>
                    <div className="rp-task-list">
                      {items.map((paper) => (
                        <ObjectMenu
                          key={paper.id}
                          objectKey={paper.id}
                          label={`论文操作 ${paperName(paper, index)}`}
                          actions={[
                            {
                              label: "重命名／移动到课题",
                              run: () => onEditPaper(paper),
                            },
                            {
                              label: "查看论文信息",
                              run: () => onEditPaper(paper),
                            },
                            {
                              label: "归档论文",
                              run: () => onEditPaper(paper, true),
                            },
                          ]}
                        >
                          <button
                            className={`rp-task ${paperId === paper.id ? "rp-task-active" : ""}`}
                            disabled={busy}
                            onClick={() => onPaper(paper)}
                            title={paperName(paper, index)}
                          >
                            <span>{paperName(paper, index)}</span>
                            {paper.id === "xu-2018" && <small>示例材料</small>}
                          </button>
                        </ObjectMenu>
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
              <details className="rw-recents">
                <summary>最近讨论</summary>
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
              </details>
            </div>
          </>
        )}
        <footer className="rw-sidebar-footer">
          <small>PDF · 上限 30 MiB / 100 页</small>
          <button aria-label="设置" title="设置" onClick={onSettings}>
            <ResearchIcon name="gear" />
            <span>设置</span>
          </button>
        </footer>
      </aside>
    </>
  );
}
