import { useEffect, useRef, useState } from "react";
import type { ConversationState, PaperBundle } from "../shared/types.ts";
import type {
  PlanContent,
  PlanJob,
  ResearchPlan,
  SourceSelector,
  StudyType,
} from "../shared/research-plan.ts";
import {
  planJobDone,
  planVersionReady,
  studyTypeLabels,
} from "../shared/research-plan.ts";
import { focusLabels, verbosityLabels } from "../shared/learning-intent.ts";
import { researchApi } from "./research-api.ts";
import "./research-plan.css";

const statusLabels: Record<PlanJob["status"], string> = {
  queued: "等待生成",
  searching: "正在检索并核验文献",
  generating: "正在起草",
  reviewing: "草稿已保存，正在核对",
  completed: "生成成功",
  failed: "生成失败",
  cancelled: "已取消，保存内容保留",
  interrupted: "服务中断，未自动重发",
  conflict: "条件或版本变化，结果保留为候选",
};
const plain = (content: PlanContent) => ({
  ...content,
  sections: content.sections.map(({ author: _a, ...s }) => s),
});
function localRead<T>(key: string): T | undefined {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
}
function localWrite(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
type Draft = { version: string | null; content: PlanContent };
type TopicDraft = {
  question: string;
  conditions: string;
  studyTypes: StudyType[];
  typeStatus: ResearchPlan["topic"]["typeStatus"];
  sources: SourceSelector[];
  learningPreferences: ResearchPlan["topic"]["learningPreferences"];
};
export function ResearchPlanPanel({
  papers,
  conversation,
  initialQuestion,
  onResearch,
  onTitle,
}: {
  papers: PaperBundle[];
  conversation?: ConversationState;
  initialQuestion: string;
  onResearch: () => void;
  onTitle: (name: string) => void;
}) {
  const [plans, setPlans] = useState<ResearchPlan[]>([]);
  const [selected, setSelected] = useState<string | null>(
    () => localRead<string>("research-plan-selected") ?? null,
  );
  const [plan, setPlan] = useState<ResearchPlan>();
  const planRef = useRef(plan),
    cancelledJobs = useRef(new Set<string>());
  planRef.current = plan;
  useEffect(() => {
    onTitle(plan?.topic.question ?? "新医学课题");
  }, [plan?.topic.question, onTitle]);
  const [draft, setDraft] = useState<Draft>();
  const [topic, setTopic] = useState<TopicDraft>(
    () =>
      (initialQuestion.trim()
        ? undefined
        : localRead<TopicDraft>("research-plan-new-topic")) ?? {
        question: initialQuestion,
        conditions: "",
        studyTypes: [],
        typeStatus: "unknown",
        sources: [],
        learningPreferences: conversation?.learningPreferences ?? {
          verbosity: "standard",
          focus: "research-reasoning",
        },
      },
  );
  const [jobs, setJobs] = useState<PlanJob[]>([]),
    [instruction, setInstruction] = useState("");
  const [scope, setScope] = useState<
    "direction" | "design-draft" | "full-plan"
  >("full-plan");
  const [retrieveLiterature, setRetrieveLiterature] = useState(true);
  const [sectionId, setSectionId] = useState("");
  const [working, setWorking] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [historical, setHistorical] = useState("");
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    setEditing(false);
  }, [selected, historical]);
  const pending = useRef<{ planId: string; body: unknown } | undefined>(
    undefined,
  );
  const actionLock = useRef(false);
  const cancelLock = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  const active = jobs.find((j) => !planJobDone(j));
  const jobsPending = useRef(false),
    pollNow = useRef<(() => void) | undefined>(undefined);
  jobsPending.current = !!active;
  const latestJob = jobs.at(-1);
  const current = plan?.versions.find((v) => v.id === plan.currentVersion);
  const shown = historical
    ? plan?.versions.find((v) => v.id === historical)
    : current;
  const dirty =
    !!draft &&
    (!current ||
      draft.version !== current.id ||
      JSON.stringify(draft.content) !== JSON.stringify(current.content));
  const staleTopic = !!current && current.topic.version !== plan?.topic.version;
  const conflictDraft = selected
    ? localRead<Draft>(`research-plan-conflict-draft:${selected}`)
    : undefined;
  const totalCalls = jobs.reduce((n, j) => n + j.budget.attempts.length, 0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  async function listPlans() {
    const all = await researchApi<ResearchPlan[]>("/api/research-plans");
    setPlans(all);
    return all;
  }
  function topicFrom(p: ResearchPlan): TopicDraft {
    return {
      question: p.topic.question,
      conditions: p.topic.conditions,
      studyTypes: p.topic.studyTypes,
      typeStatus: p.topic.typeStatus,
      sources: p.topic.sources.flatMap(
        ({ paperId, sourceVersion, sourceId }) =>
          paperId && sourceVersion && sourceId
            ? [{ paperId, sourceVersion, sourceId }]
            : [],
      ),
      learningPreferences: p.topic.learningPreferences,
    };
  }
  function updateTopic(value: TopicDraft) {
    setTopic(value);
    localWrite(
      selected
        ? `research-plan-topic-draft:${selected}`
        : "research-plan-new-topic",
      value,
    );
  }
  function edit(content: PlanContent) {
    const value = {
      version: draft?.version ?? plan?.currentVersion ?? null,
      content,
    };
    setDraft(value);
    if (selected) localWrite(`research-plan-draft:${selected}`, value);
  }
  function install(p: ResearchPlan, force = false) {
    planRef.current = p;
    setPlan(p);
    const version = p.versions.find((v) => v.id === p.currentVersion);
    const old = draftRef.current;
    if (
      force ||
      !old ||
      (plan?.currentVersion === old.version &&
        JSON.stringify(old.content) ===
          JSON.stringify(
            plan?.versions.find((v) => v.id === old.version)?.content,
          ))
    ) {
      const value = version
        ? { version: version.id, content: version.content }
        : undefined;
      setDraft(value);
      draftRef.current = value;
      if (value) localWrite(`research-plan-draft:${p.id}`, value);
    }
  }
  useEffect(() => {
    let closed = false;
    void listPlans().catch((e) => {
      if (!closed) setError(e.message);
    });
    return () => {
      closed = true;
    };
  }, []);
  useEffect(() => {
    let closed = false,
      polling = false,
      timer: ReturnType<typeof setTimeout>;
    setPlan(undefined);
    setJobs([]);
    setHistorical("");
    setSectionId("");
    if (pending.current?.planId !== selected) pending.current = undefined;
    const cached = selected
      ? localRead<Draft>(`research-plan-draft:${selected}`)
      : undefined;
    setDraft(cached);
    draftRef.current = cached;
    if (!selected) {
      setTopic(
        localRead<TopicDraft>("research-plan-new-topic") ?? {
          question: initialQuestion,
          conditions: "",
          studyTypes: [],
          typeStatus: "unknown",
          sources: [],
          learningPreferences: conversation?.learningPreferences ?? {
            verbosity: "standard",
            focus: "research-reasoning",
          },
        },
      );
      return;
    }
    localWrite("research-plan-selected", selected);
    let previousCurrent: string | null | undefined;
    async function poll() {
      if (closed || polling) return;
      polling = true;
      try {
        const [received, history] = await Promise.all([
          researchApi<ResearchPlan>(`/api/research-plans/${selected}`),
          researchApi<PlanJob[]>(`/api/research-plans/${selected}/jobs`),
        ]);
        if (closed) return;
        const known = planRef.current;
        const p =
          known?.id === received.id && known.updatedAt > received.updatedAt
            ? known
            : received;
        const j = history.map((job) =>
          cancelledJobs.current.has(job.id)
            ? { ...job, status: "cancelled" as const }
            : job,
        );
        planRef.current = p;
        setPlan(p);
        setJobs(j);
        setPlans((old) => old.map((x) => (x.id === p.id ? p : x)));
        if (previousCurrent === undefined)
          setTopic(
            localRead<TopicDraft>(`research-plan-topic-draft:${selected}`) ??
              topicFrom(p),
          );
        const v = p.versions.find((v) => v.id === p.currentVersion),
          old = draftRef.current;
        const oldSaved = p.versions.find((v) => v.id === old?.version);
        if (
          v &&
          (!old ||
            (JSON.stringify(old.content) ===
              JSON.stringify(oldSaved?.content) &&
              previousCurrent !== p.currentVersion))
        ) {
          const value = { version: v.id, content: v.content };
          setDraft(value);
          draftRef.current = value;
          localWrite(`research-plan-draft:${selected}`, value);
        }
        previousCurrent = p.currentVersion;
      } catch (e) {
        if (!closed) setError((e as Error).message);
      } finally {
        polling = false;
      }
      if (!closed)
        timer = setTimeout(
          poll,
          document.hidden ? 10000 : jobsPending.current ? 900 : 3000,
        );
    }
    const wake = () => {
      if (document.hidden || polling) return;
      clearTimeout(timer);
      void poll();
    };
    pollNow.current = wake;
    document.addEventListener("visibilitychange", wake);
    void poll();
    return () => {
      closed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      if (pollNow.current === wake) pollNow.current = undefined;
    };
  }, [selected]);
  useEffect(() => {
    if (active) pollNow.current?.();
  }, [active?.id]);
  async function action(work: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      actionLock.current = false;
      setWorking(false);
    }
  }
  async function saveDraft() {
    if (!plan || !draft) return;
    const value = await researchApi<ResearchPlan>(
      `/api/research-plans/${plan.id}/versions`,
      {
        expectedVersion: draft.version,
        expectedTopicVersion: plan.topic.version,
        content: plain(draft.content),
      },
    );
    install(value, true);
    setHistorical("");
    await listPlans();
    setEditing(false);
    setNotice("已保存新版本，原稿保留；本版本尚未核对。");
  }
  async function start(
    actionName: "generate" | "revise" | "review",
    retry = false,
    target = plan,
  ) {
    if (!target) return;
    const body =
      retry && pending.current?.planId === target.id
        ? pending.current.body
        : {
            requestKey: crypto.randomUUID(),
            expectedVersion: target.currentVersion,
            expectedTopicVersion: target.topic.version,
            action: actionName,
            instruction,
            requestedScope: scope,
            retrieveLiterature: actionName !== "review" && retrieveLiterature,
            ...(sectionId && actionName === "revise" ? { sectionId } : {}),
          };
    pending.current = { planId: target.id, body };
    const j = await researchApi<PlanJob>(
      `/api/research-plans/${target.id}/jobs`,
      body,
    );
    pending.current = undefined;
    setJobs((old) => [...old.filter((x) => x.id !== j.id), j]);
    setNotice("已提交；任务继续执行，可切换专区。");
  }
  const topicChanged =
    !!plan && JSON.stringify(topic) !== JSON.stringify(topicFrom(plan));
  const readOnly = !!historical;
  const preview = readOnly ? shown?.content : draft?.content;
  return (
    <section className="rplan" aria-label="研究方案专区">
      <aside className="rplan-list">
        <div className="rplan-heading">
          <h2>研究方案</h2>
          <button
            onClick={() => {
              setSelected(null);
              localWrite("research-plan-selected", null);
              setPlan(undefined);
              setDraft(undefined);
            }}
          >
            新方案
          </button>
        </div>
        <p className="hint">从一个医学研究问题起步，可不上传论文。</p>
        {plans.map((p) => (
          <button
            key={p.id}
            aria-current={selected === p.id ? "page" : undefined}
            onClick={() => setSelected(p.id)}
          >
            <strong>{p.topic.question}</strong>
            <small>
              {p.archived ? "已归档 · " : ""}
              {p.versions.length} 个保存版本
            </small>
          </button>
        ))}
        <button onClick={onResearch}>返回论文讨论</button>
      </aside>
      <div className="rplan-main">
        {error && (
          <div role="alert" className="rplan-error">
            {error}
            <button onClick={() => setError("")}>关闭提示</button>
            {pending.current && (
              <button
                disabled={working}
                onClick={() => void action(() => start("generate", true))}
              >
                查询／重试同一请求
              </button>
            )}
          </div>
        )}
        {notice && <p role="status">{notice}</p>}
        <details className="rplan-card" open={!plan || !current}>
          <summary>
            {plan ? "课题条件与来源" : "开始一个新课题"}
            {topicChanged ? " · 有未保存条件" : ""}
          </summary>
          <label>
            研究问题或方向
            <textarea
              aria-label="研究问题或方向"
              rows={3}
              maxLength={3000}
              value={topic.question}
              onChange={(e) =>
                updateTopic({ ...topic, question: e.target.value })
              }
            />
          </label>
          {initialQuestion && initialQuestion !== topic.question && (
            <button
              onClick={() =>
                updateTopic({
                  ...topic,
                  question: initialQuestion.slice(0, 3000),
                })
              }
            >
              带入当前讨论选段／问题
            </button>
          )}
          <label>
            对象、资源和限制（可逐步补充）
            <textarea
              aria-label="对象、资源和限制"
              rows={3}
              maxLength={5000}
              value={topic.conditions}
              onChange={(e) =>
                updateTopic({ ...topic, conditions: e.target.value })
              }
            />
          </label>
          <details>
            <summary>更多设置（可选）</summary>
            <div className="rplan-fields">
              <label>
                研究类型
                <select
                  aria-label="研究类型"
                  value={topic.studyTypes[0] ?? ""}
                  onChange={(e) =>
                    updateTopic({
                      ...topic,
                      studyTypes: e.target.value
                        ? [e.target.value as StudyType]
                        : [],
                      typeStatus: e.target.value ? "provisional" : "unknown",
                    })
                  }
                >
                  <option value="">暂不确定</option>
                  {Object.entries(studyTypeLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {topic.studyTypes.length > 0 && (
                <label>
                  类型确认
                  <select
                    aria-label="类型确认"
                    value={topic.typeStatus}
                    onChange={(e) =>
                      updateTopic({
                        ...topic,
                        typeStatus: e.target.value as TopicDraft["typeStatus"],
                      })
                    }
                  >
                    <option value="provisional">暂定，按假设起草</option>
                    <option value="confirmed">我已确认</option>
                  </select>
                </label>
              )}
              <details>
                <summary>复合设计：补充研究类型</summary>
                {Object.entries(studyTypeLabels).map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={topic.studyTypes.includes(key as StudyType)}
                      onChange={() => {
                        const studyTypes = topic.studyTypes.includes(
                          key as StudyType,
                        )
                          ? topic.studyTypes.filter((x) => x !== key)
                          : [...topic.studyTypes, key as StudyType];
                        updateTopic({
                          ...topic,
                          studyTypes,
                          typeStatus: studyTypes.length
                            ? topic.typeStatus === "unknown"
                              ? "provisional"
                              : topic.typeStatus
                            : "unknown",
                        });
                      }}
                    />
                    {label}
                  </label>
                ))}
              </details>
              <label>
                讲解程度
                <select
                  aria-label="方案讲解程度"
                  value={topic.learningPreferences.verbosity}
                  onChange={(e) =>
                    updateTopic({
                      ...topic,
                      learningPreferences: {
                        ...topic.learningPreferences,
                        verbosity: e.target
                          .value as TopicDraft["learningPreferences"]["verbosity"],
                      },
                    })
                  }
                >
                  {Object.entries(verbosityLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                学习重点
                <select
                  aria-label="方案学习重点"
                  value={topic.learningPreferences.focus}
                  onChange={(e) =>
                    updateTopic({
                      ...topic,
                      learningPreferences: {
                        ...topic.learningPreferences,
                        focus: e.target
                          .value as TopicDraft["learningPreferences"]["focus"],
                      },
                    })
                  }
                >
                  {Object.entries(focusLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </details>
          <details>
            <summary>
              选择已有来源 · {topic.sources.length} 个（最多 12 个）
            </summary>
            <div className="rplan-source-picker">
              {papers.map((p) => (
                <details key={p.id}>
                  <summary>{p.title}</summary>
                  {p.sources
                    .filter((s) => s.text.trim())
                    .map((s) => {
                      const checked = topic.sources.some(
                        (r) =>
                          r.paperId === p.id &&
                          r.sourceId === s.id &&
                          r.sourceVersion === p.version,
                      );
                      return (
                        <label key={s.id}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!checked && topic.sources.length >= 12}
                            onChange={() =>
                              updateTopic({
                                ...topic,
                                sources: checked
                                  ? topic.sources.filter(
                                      (r) =>
                                        !(
                                          r.paperId === p.id &&
                                          r.sourceId === s.id
                                        ),
                                    )
                                  : [
                                      ...topic.sources,
                                      {
                                        paperId: p.id,
                                        sourceId: s.id,
                                        sourceVersion: p.version,
                                      },
                                    ],
                              })
                            }
                          />
                          {s.title} · {s.locator}
                        </label>
                      );
                    })}
                </details>
              ))}
            </div>
          </details>
          <p className="hint">
            缺条件可先讨论草稿；所选文献支持设计依据，其结果不会成为新课题的实测结果。
          </p>
          <button
            disabled={
              working ||
              (!!selected && !plan) ||
              !topic.question.trim() ||
              (!!plan && !topicChanged)
            }
            onClick={() =>
              void action(async () => {
                if (plan) {
                  const p = await researchApi<ResearchPlan>(
                    `/api/research-plans/${plan.id}/topic`,
                    { expectedTopicVersion: plan.topic.version, topic },
                    "PUT",
                  );
                  install(p);
                  localWrite(
                    `research-plan-topic-draft:${plan.id}`,
                    topicFrom(p),
                  );
                  setNotice(
                    "新条件已保存；旧稿和旧核对仍绑定原条件，请明确改稿。",
                  );
                } else {
                  const p = await researchApi<ResearchPlan>(
                    "/api/research-plans",
                    topic,
                  );
                  setPlan(p);
                  setSelected(p.id);
                  await start("generate", false, p);
                  await listPlans();
                }
              })
            }
          >
            {plan ? "保存课题条件" : "生成方案"}
          </button>
          {plan && topicChanged && (
            <button
              onClick={() => {
                updateTopic(topicFrom(plan));
                setError("");
              }}
            >
              取消条件修改
            </button>
          )}
        </details>
        {plan && (
          <>
            {staleTopic && (
              <p role="status" className="rplan-warning">
                课题条件已变化。当前保存稿使用旧条件，请改稿后重新核对。
              </p>
            )}
            <details
              className="rplan-card rplan-revise"
              open={!current || !!active}
            >
              <summary>{current ? "调整方案" : "起草方案"}</summary>
              <details>
                <summary>生成选项（可选）</summary>
                <label>
                  <input
                    type="checkbox"
                    checked={retrieveLiterature}
                    onChange={(e) => setRetrieveLiterature(e.target.checked)}
                  />
                  自动检索 PubMed
                  并核验文献（读取摘要，网络失败可改为已有来源起草）
                </label>
                <div className="rplan-fields">
                  <label>
                    本次范围
                    <select
                      aria-label="本次方案范围"
                      value={scope}
                      onChange={(e) => setScope(e.target.value as typeof scope)}
                    >
                      <option value="direction">方向框架</option>
                      <option value="design-draft">设计草案</option>
                      <option value="full-plan">
                        较完整方案（限现有条件）
                      </option>
                    </select>
                  </label>
                  {!!current && (
                    <label>
                      修改位置
                      <select
                        aria-label="修改位置"
                        value={sectionId}
                        onChange={(e) => setSectionId(e.target.value)}
                      >
                        <option value="">整体方案</option>
                        {current.content.sections.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.title}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              </details>
              <label>
                本轮建议
                <textarea
                  aria-label="方案本轮建议"
                  maxLength={3000}
                  rows={2}
                  placeholder="例如：先给整体思路；资源有限，请给备选路径"
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                />
              </label>
              <div className="rplan-actions">
                <button
                  disabled={
                    working ||
                    !!active ||
                    dirty ||
                    topicChanged ||
                    plan.archived
                  }
                  onClick={() =>
                    void action(() => start(current ? "revise" : "generate"))
                  }
                >
                  {current ? "按建议改稿并核对" : "起草并轻量核对"}
                </button>
                {!!current && (
                  <button
                    disabled={
                      working ||
                      !!active ||
                      dirty ||
                      topicChanged ||
                      staleTopic ||
                      plan.archived
                    }
                    onClick={() => void action(() => start("review"))}
                  >
                    核对当前保存版
                  </button>
                )}
                {active && (
                  <button
                    disabled={cancelling}
                    onClick={() =>
                      void (async () => {
                        if (cancelLock.current) return;
                        cancelLock.current = true;
                        setCancelling(true);
                        try {
                          const j = await researchApi<PlanJob>(
                            `/api/research-plan-jobs/${active.id}/cancel`,
                            {},
                          );
                          if (j.status === "cancelled")
                            cancelledJobs.current.add(j.id);
                          setJobs((old) =>
                            old.map((x) => (x.id === j.id ? j : x)),
                          );
                          setNotice(
                            "已取消本次任务，保存内容和手稿保留，可以继续其他操作。",
                          );
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          cancelLock.current = false;
                          setCancelling(false);
                        }
                      })()
                    }
                  >
                    {cancelling ? "正在取消…" : "取消方案任务"}
                  </button>
                )}
              </div>
              {dirty && (
                <p className="hint">
                  有未保存手稿，先保存后再提交生成或核对。版本冲突时手稿保留在本机。
                </p>
              )}
              {latestJob && (
                <div className="rplan-job" role="status">
                  <strong>{statusLabels[latestJob.status]}</strong>
                  {latestJob.error && <p>{latestJob.error}</p>}
                  {latestJob.literature && (
                    <details>
                      <summary>
                        文献检索与依据 · {latestJob.literature.selected.length}{" "}
                        篇
                      </summary>
                      <p>检索式：{latestJob.literature.query}</p>
                      <p>{latestJob.literature.queryReason}</p>
                      <p>{latestJob.literature.selectionReason}</p>
                      {latestJob.literature.selected.map((r) => (
                        <details key={r.id}>
                          <summary>
                            {r.title} · {r.bibliography?.year}
                          </summary>
                          <p>{r.excerpt}</p>
                          <p>
                            实际读取：
                            {r.bibliography?.level === "abstract"
                              ? "摘要"
                              : "元数据"}
                            ；Crossref：{r.bibliography?.crossref}
                          </p>
                          {r.bibliography?.notices.map((n, i) => (
                            <p key={i}>{n}</p>
                          ))}
                          <a href={r.url} target="_blank" rel="noreferrer">
                            打开 PubMed 原记录
                          </a>
                        </details>
                      ))}
                      {latestJob.literature.limitations.map((l, i) => (
                        <p key={i}>{l}</p>
                      ))}
                    </details>
                  )}
                  <details>
                    <summary>任务详情</summary>
                    <small>
                      本次 {latestJob.budget.attempts.length} /{" "}
                      {latestJob.budget.limit} 次调用 · 此方案累计 {totalCalls}{" "}
                      次 · {latestJob.capability.model}
                    </small>
                  </details>
                  {(latestJob.status === "conflict" ||
                    !latestJob.resultVersion) &&
                    latestJob.candidate && (
                      <details>
                        <summary>查看未覆盖当前版本的候选稿</summary>
                        {latestJob.candidate.content.sections.map((s) => (
                          <div key={s.id}>
                            <h3>{s.title}</h3>
                            <p>{s.text}</p>
                            <p>{s.rationale}</p>
                          </div>
                        ))}
                      </details>
                    )}
                </div>
              )}
            </details>
            {current && (
              <div className="rplan-actions">
                <details>
                  <summary>历史版本</summary>
                  <label>
                    保存版本
                    <select
                      aria-label="保存版本"
                      value={historical || current.id}
                      onChange={(e) =>
                        setHistorical(
                          e.target.value === current.id ? "" : e.target.value,
                        )
                      }
                    >
                      {[...plan.versions].reverse().map((v, i) => (
                        <option key={v.id} value={v.id}>
                          {i === 0 ? "当前 · " : "历史 · "}
                          {v.content.title} ·{" "}
                          {new Date(v.createdAt).toLocaleTimeString()}
                        </option>
                      ))}
                    </select>
                  </label>
                </details>
                {shown &&
                planVersionReady(shown) &&
                jobs.some(
                  (job) =>
                    job.id === shown.review?.jobId &&
                    job.status === "completed",
                ) ? (
                  <>
                    <a
                      href={`/api/research-plans/${plan.id}/exports/${shown.id}?format=docx`}
                    >
                      下载此保存版 Word 文档
                    </a>
                    <a
                      href={`/api/research-plans/${plan.id}/exports/${shown.id}`}
                    >
                      导出此保存版 Markdown
                    </a>
                  </>
                ) : shown ? (
                  <>
                    <button disabled title="方案需成功完成核对后才能导出">
                      导出方案
                    </button>
                    <small>
                      {shown.review
                        ? "核对未通过，暂不可导出"
                        : "尚未完成核对，暂不可导出"}
                    </small>
                  </>
                ) : null}
                {readOnly && (
                  <button
                    disabled={working}
                    onClick={() =>
                      void action(async () => {
                        const p = await researchApi<ResearchPlan>(
                          `/api/research-plans/${plan.id}/restore`,
                          {
                            versionId: historical,
                            expectedVersion: plan.currentVersion,
                            expectedTopicVersion: plan.topic.version,
                          },
                        );
                        install(p, true);
                        setTopic(topicFrom(p));
                        setHistorical("");
                        setNotice("已恢复为新版本，历史核对未复用。");
                      })
                    }
                  >
                    恢复为新版本
                  </button>
                )}
              </div>
            )}
            {draft && !readOnly && (
              <>
                {conflictDraft && (
                  <details className="rplan-card">
                    <summary>查看本机保留的冲突手稿</summary>
                    {conflictDraft.content.sections.map((s) => (
                      <section key={s.id}>
                        <h3>{s.title}</h3>
                        <p>{s.text}</p>
                        <p>{s.rationale}</p>
                      </section>
                    ))}
                  </details>
                )}
                {draft.version !== plan.currentVersion && (
                  <div role="alert" className="rplan-warning">
                    已有新的保存版本。你的手稿保留；可复制内容后载入保存稿再合并。
                    <button
                      onClick={() => {
                        localWrite(
                          `research-plan-conflict-draft:${plan.id}`,
                          draft,
                        );
                        install(plan, true);
                      }}
                    >
                      保留手稿副本并载入最新稿
                    </button>
                  </div>
                )}
                {editing && (
                  <div className="rplan-card">
                    <div className="rplan-actions">
                      <button onClick={() => setEditing(false)}>
                        返回阅读
                      </button>
                      {dirty && <small>未保存修改会保留在本机。</small>}
                    </div>
                    <label>
                      方案标题
                      <input
                        aria-label="方案标题"
                        maxLength={200}
                        value={draft.content.title}
                        onChange={(e) =>
                          edit({ ...draft.content, title: e.target.value })
                        }
                      />
                    </label>
                    {draft.content.sections.map((s, i) => (
                      <details key={s.id} open className="rplan-section">
                        <summary>
                          {s.title} ·{" "}
                          {s.author === "assistant"
                            ? "助手起草"
                            : s.author === "mixed"
                              ? "共同修改"
                              : s.author === "user"
                                ? "用户撰写"
                                : "归属未知"}
                        </summary>
                        <label>
                          章节标题
                          <input
                            aria-label={`章节 ${i + 1} 标题`}
                            maxLength={160}
                            value={s.title}
                            onChange={(e) =>
                              edit({
                                ...draft.content,
                                sections: draft.content.sections.map((x) =>
                                  x.id === s.id
                                    ? { ...x, title: e.target.value }
                                    : x,
                                ),
                              })
                            }
                          />
                        </label>
                        <label>
                          拟做什么
                          <textarea
                            aria-label={`章节 ${i + 1} 内容`}
                            rows={6}
                            maxLength={6000}
                            value={s.text}
                            onChange={(e) =>
                              edit({
                                ...draft.content,
                                sections: draft.content.sections.map((x) =>
                                  x.id === s.id
                                    ? { ...x, text: e.target.value }
                                    : x,
                                ),
                              })
                            }
                          />
                        </label>
                        <label>
                          设计理由
                          <textarea
                            aria-label={`章节 ${i + 1} 理由`}
                            rows={3}
                            maxLength={3000}
                            value={s.rationale}
                            onChange={(e) =>
                              edit({
                                ...draft.content,
                                sections: draft.content.sections.map((x) =>
                                  x.id === s.id
                                    ? { ...x, rationale: e.target.value }
                                    : x,
                                ),
                              })
                            }
                          />
                        </label>
                        <label>
                          内容类别
                          <select
                            aria-label={`章节 ${i + 1} 类别`}
                            value={s.kind}
                            onChange={(e) =>
                              edit({
                                ...draft.content,
                                sections: draft.content.sections.map((x) =>
                                  x.id === s.id
                                    ? {
                                        ...x,
                                        kind: e.target.value as typeof s.kind,
                                      }
                                    : x,
                                ),
                              })
                            }
                          >
                            <option value="proposal">设计提议</option>
                            <option value="hypothesis">待验证假设</option>
                            <option value="source-fact">有来源的事实</option>
                            <option value="possible-result">可能结果</option>
                          </select>
                        </label>
                        <p className="hint">
                          待确认：{s.unknowns.join("；") || "无新增项"}
                        </p>
                        {s.sourceRefs.map((id) => {
                          const r = shown?.topic.sources.find(
                            (r) => r.id === id,
                          );
                          return (
                            r && (
                              <details key={id}>
                                <summary>
                                  依据：{r.title} · {r.locator}
                                </summary>
                                <p>{r.excerpt}</p>
                                <small>
                                  {r.bibliography
                                    ? `PMID ${r.bibliography.pmid} · ${r.bibliography.level === "abstract" ? "摘要" : "元数据"} · Crossref ${r.bibliography.crossref}`
                                    : `${r.paperId}@${r.sourceVersion}`}
                                </small>
                              </details>
                            )
                          );
                        })}
                      </details>
                    ))}
                    <details open>
                      <summary>假设、关键问题与范围</summary>
                      {[
                        ...draft.content.assumptions,
                        ...draft.content.questions,
                        ...draft.content.limitations,
                      ].map((s, i) => (
                        <p key={i}>{s}</p>
                      ))}
                    </details>
                    <button
                      disabled={working || !dirty || topicChanged}
                      onClick={() => void action(saveDraft)}
                    >
                      保存手动修改
                    </button>
                    {dirty && (
                      <button
                        onClick={() => {
                          const value = current
                            ? {
                                version: current.id,
                                content: structuredClone(current.content),
                              }
                            : undefined;
                          setDraft(value);
                          draftRef.current = value;
                          if (selected) {
                            if (value)
                              localWrite(
                                `research-plan-draft:${selected}`,
                                value,
                              );
                            else
                              localStorage.removeItem(
                                `research-plan-draft:${selected}`,
                              );
                          }
                          setError("");
                        }}
                      >
                        放弃未保存修改
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
            {preview && (readOnly || !editing) && (
              <article
                className="rplan-card rplan-preview"
                aria-label="方案阅读"
              >
                <div className="rplan-preview-heading">
                  <h2>{preview.title}</h2>
                  {!readOnly && (
                    <button onClick={() => setEditing(true)}>编辑方案</button>
                  )}
                </div>
                {!readOnly && dirty && (
                  <p className="hint">
                    正在预览未保存修改，保存并核对后才能导出修改稿。
                  </p>
                )}
                {preview.sections.map((s) => (
                  <section key={s.id} className="rplan-section">
                    <h3>{s.title}</h3>
                    <p>{s.text}</p>
                    {s.rationale && (
                      <p className="rplan-rationale">设计理由：{s.rationale}</p>
                    )}
                    {(s.unknowns.length > 0 || s.sourceRefs.length > 0) && (
                      <details>
                        <summary>补充条件与依据</summary>
                        {s.unknowns.length > 0 && (
                          <p>待确认：{s.unknowns.join("；")}</p>
                        )}
                        {s.sourceRefs.map((id) => {
                          const source = shown?.topic.sources.find(
                            (r) => r.id === id,
                          );
                          return (
                            source && (
                              <details key={id}>
                                <summary>
                                  {source.title} · {source.locator}
                                </summary>
                                <p>{source.excerpt}</p>
                              </details>
                            )
                          );
                        })}
                      </details>
                    )}
                  </section>
                ))}
                <details>
                  <summary>假设、关键问题与范围</summary>
                  {[
                    ...preview.assumptions,
                    ...preview.questions,
                    ...preview.limitations,
                  ].map((text, i) => (
                    <p key={i}>{text}</p>
                  ))}
                </details>
                {!readOnly && dirty && (
                  <div className="rplan-actions">
                    <button
                      disabled={working || topicChanged}
                      onClick={() => void action(saveDraft)}
                    >
                      保存手动修改
                    </button>
                  </div>
                )}
              </article>
            )}
            {shown && (
              <details className="rplan-card rplan-review">
                <summary>
                  此保存版的轻量核对 ·{" "}
                  {shown.review
                    ? shown.review.status === "checked"
                      ? "所列范围已核对"
                      : "有待处理问题"
                    : "尚未核对"}
                </summary>
                {shown.review?.issues.map((i) => (
                  <p key={i.id}>
                    {i.severity === "blocking" ? "重要问题" : "建议"}：
                    {i.message}（待处理）
                  </p>
                ))}
                {shown.review?.limitations.map((s, i) => (
                  <p key={i}>{s}</p>
                ))}
                <p className="hint">
                  核对只覆盖当前记录的设计和来源，不代表学习迁移验证。
                </p>
              </details>
            )}
            <details className="rplan-card">
              <summary>方案管理</summary>
              <button
                disabled={working}
                onClick={() =>
                  void action(async () => {
                    const p = await researchApi<ResearchPlan>(
                      `/api/research-plans/${plan.id}`,
                      { archived: !plan.archived },
                      "PATCH",
                    );
                    install(p);
                    await listPlans();
                  })
                }
              >
                {plan.archived ? "取消归档" : "归档方案"}
              </button>
              <details>
                <summary>删除方案及关联任务记录</summary>
                <p>
                  删除这份方案的保存版本、来源副本和任务记录；原论文与论文讨论保留。本机手稿副本同时清除。
                </p>
                <button
                  disabled={working}
                  onClick={() =>
                    void action(async () => {
                      await researchApi(
                        `/api/research-plans/${plan.id}`,
                        {},
                        "DELETE",
                      );
                      try {
                        for (const key of [
                          `research-plan-draft:${plan.id}`,
                          `research-plan-topic-draft:${plan.id}`,
                          `research-plan-conflict-draft:${plan.id}`,
                        ])
                          localStorage.removeItem(key);
                      } catch {}
                      setSelected(null);
                      localWrite("research-plan-selected", null);
                      await listPlans();
                    })
                  }
                >
                  删除这份方案
                </button>
              </details>
            </details>
          </>
        )}
      </div>
    </section>
  );
}
