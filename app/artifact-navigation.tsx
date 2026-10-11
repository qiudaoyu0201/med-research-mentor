import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ArtifactSummary, WorkspaceIndex } from "../shared/workspace.ts";
import { researchApi } from "./research-api.ts";
import { ObjectMenu } from "./research-menu.tsx";

export function ArtifactNavigation({
  kind,
  selected,
  revision,
  disabled,
  index,
  onSelect,
  onNew,
  onArchived,
  onCreateProject,
  onEditProject,
}: {
  kind: "ppt" | "plan";
  selected?: string;
  revision: string;
  disabled: boolean;
  index: WorkspaceIndex;
  onSelect: (artifact: ArtifactSummary) => void;
  onNew: () => void;
  onArchived: (id: string) => void;
  onCreateProject: () => void;
  onEditProject: (id: string) => void;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [all, setAll] = useState<ArtifactSummary[]>([]),
    [search, setSearch] = useState(""),
    [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const label = kind === "ppt" ? "汇报" : "方案";
  async function refresh() {
    setAll(await researchApi<ArtifactSummary[]>("/api/artifacts"));
  }
  useEffect(() => {
    setHost(document.getElementById("generation-navigation"));
  }, []);
  useEffect(() => {
    let stale = false;
    const load = () =>
      void researchApi<ArtifactSummary[]>("/api/artifacts")
        .then((a) => {
          if (!stale) setAll(a);
        })
        .catch((e) => {
          if (!stale) setError(e.message);
        });
    load();
    window.addEventListener("artifacts-changed", load);
    return () => {
      stale = true;
      window.removeEventListener("artifacts-changed", load);
    };
  }, [revision, kind]);
  async function patch(item: ArtifactSummary, body: object) {
    if (working || disabled) return;
    setWorking(true);
    setError("");
    try {
      await researchApi(`/api/artifacts/${kind}/${item.id}`, body, "PATCH");
      await refresh();
      if ("archived" in body && body.archived) onArchived(item.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  const groups = [
    ...index.projects.filter((p) => !p.archived),
    { id: "", name: "未分组" },
  ];
  if (!host) return null;
  return createPortal(
    <>
      <button
        className="rp-new-task"
        disabled={disabled || working}
        onClick={onNew}
      >
        ＋ 新建{label}
      </button>
      <label className="rp-search">
        <input
          aria-label={`搜索${label}`}
          placeholder={`搜索我的${label}`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <div className="rp-sidebar-scroll">
        <div className="rp-section-label">
          我的课题{" "}
          <button aria-label="新建课题" onClick={onCreateProject}>
            ＋
          </button>
        </div>
        {groups.map((group) => {
          const items = all
            .filter(
              (a) =>
                a.kind === kind &&
                !a.archived &&
                a.title.toLowerCase().includes(search.toLowerCase()) &&
                (groups.some((g) => g.id === a.projectId)
                  ? a.projectId
                  : "") === group.id,
            )
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          return (
            <details className="rw-project" key={group.id} open>
              <summary>
                {group.id ? (
                  <ObjectMenu
                    objectKey={group.id}
                    label={`课题操作 ${group.name}`}
                    actions={[
                      {
                        label: "管理课题",
                        disabled: disabled || working,
                        run: () => onEditProject(group.id),
                      },
                    ]}
                  >
                    <span>
                      {group.name} <small>{items.length}</small>
                    </span>
                  </ObjectMenu>
                ) : (
                  <span>
                    {group.name} <small>{items.length}</small>
                  </span>
                )}
              </summary>
              <div className="rp-task-list">
                {items.map((item) => (
                  <ObjectMenu
                    key={item.id}
                    objectKey={item.id}
                    label={`${label}操作 ${item.title}`}
                    actions={[
                      {
                        label: "重命名",
                        run: () => {
                          const name = window.prompt(
                            `${label}名称`,
                            item.title,
                          );
                          if (name?.trim())
                            void patch(item, { displayName: name.trim() });
                        },
                      },
                      {
                        label: "移动到课题",
                        children: groups.map((g) => ({
                          label: g.name,
                          run: () =>
                            void patch(item, { projectId: g.id || null }),
                        })),
                      },
                      {
                        label: "归档",
                        run: () => void patch(item, { archived: true }),
                      },
                    ]}
                  >
                    <button
                      className={`rp-task ${selected === item.id ? "rp-task-active" : ""}`}
                      disabled={disabled || working}
                      onClick={() => onSelect(item)}
                      title={item.title}
                    >
                      <span>
                        {item.title}
                        <small className="rw-recent-paper">
                          {item.versionCount
                            ? `${item.versionCount} 个版本`
                            : "待生成"}
                        </small>
                      </span>
                    </button>
                  </ObjectMenu>
                ))}
              </div>
              {!items.length && <p className="rp-search-empty">暂无{label}</p>}
            </details>
          );
        })}
        {error && <p role="alert">{error}</p>}
      </div>
    </>,
    host,
  );
}
