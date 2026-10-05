import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type {
  PaperBundle,
  Profile,
  TaskRun,
  Module,
  Mode,
  Source,
  DeckOutline,
  LearningUnit,
} from "../shared/types.ts";
import "./style.css";
import { useConversation, ConversationPanel } from "./conversation.tsx";
import { DeckVersionPanel } from "./deck-versions.tsx";
import { PersonalRecordsPanel } from "./learning-records.tsx";
import type { ConversationState } from "../shared/types.ts";
GlobalWorkerOptions.workerSrc = workerUrl;
const moduleNames: Record<Module, string> = {
  paper: "论文带读",
  method: "方法讲解",
  figure: "图表解读",
  ppt: "汇报 PPT",
};
const statusNames: Record<string, string> = {
  queued: "准备材料",
  teaching: "正在讲解",
  novice: "正在检查理解步骤",
  checking: "正在对照论文",
  revising: "正在修订",
  rereading: "正在复读",
  rechecking: "正在复查",
  completed: "已完成",
  failed: "任务失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
async function api<T = any>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || "操作失败") as Error & {
      paper?: PaperBundle;
    };
    error.paper = body.paper;
    throw error;
  }
  return body;
}
const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function PdfReader({
  paper,
  page,
  zoom,
  onImage,
  onError,
}: {
  paper: PaperBundle;
  page: number;
  zoom: number;
  onImage: (url: string) => void;
  onError: (message: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    container = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null),
    [selection, setSelection] = useState<{
      x: number;
      y: number;
      w: number;
      h: number;
    } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let render: any;
    const task = getDocument({ url: paper.pdfUrl });
    (async () => {
      try {
        const pdf = await task.promise;
        const p = await pdf.getPage(page);
        const viewport = p.getViewport({ scale: zoom });
        if (cancelled || !canvas.current) return;
        const target = canvas.current;
        target.width = viewport.width;
        target.height = viewport.height;
        render = p.render({
          canvas: target,
          canvasContext: target.getContext("2d")!,
          viewport,
        });
        await render.promise;
      } catch (error) {
        if (!cancelled) onError("PDF 页面无法显示，请选其他页或补原文。");
      }
    })();
    setSelection(null);
    return () => {
      cancelled = true;
      render?.cancel();
      void task.destroy();
    };
  }, [paper.pdfUrl, page, zoom]);
  const point = (event: React.PointerEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    };
  };
  return (
    <div className="pdf-scroll">
      <p className="hint">拖动圈选图件区域，将所选图像用于下一次实时提问。</p>
      <div
        className="pdf-canvas"
        ref={container}
        onPointerDown={(e) => {
          if (!canvas.current) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = point(e);
          setStart(p);
          setSelection({ x: p.x, y: p.y, w: 0, h: 0 });
        }}
        onPointerMove={(e) => {
          if (!start) return;
          const p = point(e);
          setSelection({
            x: Math.min(start.x, p.x),
            y: Math.min(start.y, p.y),
            w: Math.abs(p.x - start.x),
            h: Math.abs(p.y - start.y),
          });
        }}
        onPointerUp={() => {
          setStart(null);
          if (
            !selection ||
            selection.w < 10 ||
            selection.h < 10 ||
            !canvas.current
          )
            return;
          const src = canvas.current,
            ratio = src.width / src.getBoundingClientRect().width,
            target = document.createElement("canvas");
          target.width = Math.min(1400, selection.w * ratio);
          target.height = (target.width * selection.h) / selection.w;
          target
            .getContext("2d")!
            .drawImage(
              src,
              selection.x * ratio,
              selection.y * ratio,
              selection.w * ratio,
              selection.h * ratio,
              0,
              0,
              target.width,
              target.height,
            );
          onImage(target.toDataURL("image/png"));
        }}
      >
        <canvas ref={canvas} />
        {selection && (
          <div
            className="selection"
            style={{
              left: selection.x,
              top: selection.y,
              width: selection.w,
              height: selection.h,
            }}
          />
        )}
      </div>
    </div>
  );
}

function App() {
  const [papers, setPapers] = useState<PaperBundle[]>([]),
    [sample, setSample] = useState<PaperBundle | null>(null),
    [profiles, setProfiles] = useState<Profile[]>([]),
    [paperId, setPaperId] = useState("xu-2018");
  const [module, setModule] = useState<Module>("paper"),
    [mode, setMode] = useState<Mode>("example"),
    [profileId, setProfileId] = useState("beginner"),
    [runs, setRuns] = useState<TaskRun[]>([]),
    [current, setCurrent] = useState<TaskRun | null>(null);
  const [question, setQuestion] = useState(""),
    [method, setMethod] = useState("qpcr"),
    [page, setPage] = useState(1),
    [zoom, setZoom] = useState(1),
    [activeSource, setActiveSource] = useState("xu-question"),
    [selectedSources, setSelectedSources] = useState<string[]>([]),
    [image, setImage] = useState<string | undefined>();
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [settings, setSettings] = useState(false),
    [showLibrary, setShowLibrary] = useState(true),
    [model, setModel] = useState<any>(null);
  const [bookmarks, setBookmarks] = useState<string[]>([]),
    [progress, setProgress] = useState<
      { unitId: string; state: "read" | "confused" | "understood" }[]
    >([]),
    [saveState, setSaveState] = useState("已保存"),
    [outline, setOutline] = useState<DeckOutline>({ slides: [] }),
    [deckUrl, setDeckUrl] = useState(""),
    [deckVersionId, setDeckVersionId] = useState<string>(),
    [manualText, setManualText] = useState(""),
    [ratio, setRatio] = useState(47);
  const [skills, setSkills] = useState<any[]>([]),
    [skillId, setSkillId] = useState("medical-method-tutor"),
    [candidate, setCandidate] = useState(""),
    [batch, setBatch] = useState<any>(null),
    [replayMode, setReplayMode] = useState<"fixture" | "live">("fixture"),
    [showReplay, setShowReplay] = useState(false);
  const file = useRef<HTMLInputElement>(null),
    sourceRefs = useRef<Record<string, HTMLElement | null>>({}),
    sourceDetails = useRef<HTMLDetailsElement | null>(null),
    pollRef = useRef(0);
  const paper = papers.find((p) => p.id === paperId) || sample;
  const chat = useConversation(
    (run) => {
      setCurrent(run);
      if (run.input.paperId !== "foundation-only")
        setPaperId(run.input.paperId);
      setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]);
      if (run.deck) setOutline(run.deck);
    },
    setError,
    () => setCurrent(null),
  );
  const sources = paper
    ? [
        ...paper.sources,
        ...(paper.id !== sample?.id
          ? sample?.sources.filter((s) => s.kind === "foundation") || []
          : []),
      ]
    : [];
  useEffect(() => {
    setDeckVersionId(undefined);
  }, [paperId]);
  const isRunning =
    !!current &&
    !["completed", "failed", "cancelled", "interrupted"].includes(
      current.status,
    );
  useEffect(() => {
    Promise.all([api("/api/bootstrap"), api("/api/session")])
      .then(async ([data, session]) => {
        setSample(data.sample);
        setPapers([data.sample, ...data.papers]);
        setProfiles(data.profiles);
        setRuns(data.runs);
        setSkills(data.skills);
        if (data.revisions.length) setBatch(data.revisions.at(-1));
        setOutline(data.defaultDeck);
        if (session) {
          setPaperId(session.paperId);
          setPage(session.page);
          setModule(session.module);
          setBookmarks(session.bookmarks);
          setProgress(session.progress);
          const saved = await api("/api/outlines/" + session.paperId);
          if (saved) setOutline(saved);
        }
        setReady(true);
      })
      .catch((e) => setError(e.message));
    void api("/api/model")
      .then(setModel)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!ready) return;
    setSaveState("保存中");
    const timer = setTimeout(() => {
      void api(
        "/api/session",
        json({ paperId, page, module, bookmarks, progress }, "PUT"),
      )
        .then(() => setSaveState("已保存"))
        .catch(() => setSaveState("保存失败，可导出当前内容"));
    }, 400);
    return () => clearTimeout(timer);
  }, [ready, paperId, page, module, bookmarks, progress]);
  useEffect(() => {
    setSelectedSources(
      module === "method"
        ? sources
            .filter(
              (s) =>
                s.kind === "foundation" &&
                (method === "flow"
                  ? s.id === "flow-basics"
                  : s.id !== "flow-basics"),
            )
            .map((s) => s.id)
        : paper?.id === sample?.id
          ? sources
              .filter(
                (s) => !s.id.startsWith("xu-original-") || s.page === page,
              )
              .map((s) => s.id)
          : sources
              .filter((s) => s.page === page || s.kind === "foundation")
              .map((s) => s.id),
    );
    setImage(undefined);
  }, [paperId, page, ready, module, method]);
  useEffect(() => {
    if (!ready || !outline.slides.length) return;
    const timer = setTimeout(() => {
      void api("/api/outlines/" + paperId, json(outline, "PUT")).catch(() =>
        setSaveState("大纲保存失败"),
      );
    }, 600);
    return () => clearTimeout(timer);
  }, [outline, ready, paperId]);
  useEffect(() => {
    setCandidate(skills.find((s) => s.id === skillId)?.text || "");
  }, [skills, skillId]);
  useEffect(() => {
    if (!isRunning || !current) return;
    const token = ++pollRef.current;
    const timer = setInterval(() => {
      void api<TaskRun>("/api/tasks/" + current.id)
        .then((run) => {
          if (token !== pollRef.current) return;
          setCurrent(run);
          if (run.status === "completed") {
            setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]);
            if (run.deck) setOutline(run.deck);
          }
          if (run.error) setError(run.error);
        })
        .catch((e) => setError(e.message));
    }, 700);
    return () => {
      clearInterval(timer);
      pollRef.current++;
    };
  }, [current?.id, isRunning]);
  async function execute(q: string, actualMode = mode) {
    if (!paper) return;
    setError("");
    setNotice("");
    setBusy(true);
    setDeckUrl("");
    try {
      await chat.send(q, {
        paperId: paper.id,
        module,
        mode: actualMode,
        profileId,
        sourceIds: selectedSources,
        ...(image ? { visibleImage: image } : {}),
      });
      setShowLibrary(false);
      setQuestion("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function loadExample() {
    await execute(
      module === "method"
        ? method === "flow"
          ? "流式细胞术基础"
          : "PCR/qPCR 基础"
        : module === "figure"
          ? "Figure 1 图注带读"
          : module === "ppt"
            ? "生成基础汇报大纲"
            : "从研究问题开始",
      "example",
    );
  }
  async function uploadPdf(event: React.ChangeEvent<HTMLInputElement>) {
    const pdf = event.target.files?.[0];
    if (!pdf) return;
    setBusy(true);
    setError("");
    setNotice("读取 PDF 中");
    const form = new FormData();
    form.append("pdf", pdf);
    try {
      const result = await api<PaperBundle>("/api/papers", {
        method: "POST",
        body: form,
      });
      selectPaper(result);
      setNotice(
        result.parseStatus === "needs-text"
          ? "页面可查看，但缺少可提取文本，请补充原文。"
          : "已读取 PDF，请检查文字顺序后选择材料。",
      );
    } catch (e) {
      const err = e as Error & { paper?: PaperBundle };
      if (err.paper) selectPaper(err.paper);
      setError(err.message);
    } finally {
      setBusy(false);
      setNotice((prev) => (prev === "读取 PDF 中" ? "" : prev));
      event.target.value = "";
    }
  }
  function selectPaper(p: PaperBundle) {
    setPapers((prev) =>
      prev.some((x) => x.id === p.id) ? prev : [...prev, p],
    );
    setPaperId(p.id);
    setPage(1);
    setCurrent(null);
    setActiveSource(p.sources[0]?.id || "");
    setMode(p.id === "xu-2018" ? "example" : "live");
    setOutline(p.id === "xu-2018" ? outline : { slides: [] });
    setDeckUrl("");
    setImage(undefined);
    setShowLibrary(false);
    void api("/api/outlines/" + p.id).then((saved) => {
      if (saved) setOutline(saved);
    });
  }
  function locate(id: string) {
    const source = sources.find((s) => s.id === id);
    if (source?.page) setPage(source.page);
    setActiveSource(id);
    if (sourceDetails.current) sourceDetails.current.open = true;
    sourceRefs.current[id]?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }
  function updateSlide(i: number, key: string, value: any) {
    setDeckUrl("");
    setOutline((prev) => ({
      slides: prev.slides.map((s, j) => (i === j ? { ...s, [key]: value } : s)),
    }));
  }
  async function makeDeck() {
    if (!paper) return;
    setBusy(true);
    setError("");
    try {
      if (deckVersionId && chat.state) {
        const version = await api("/api/deck-versions/" + deckVersionId);
        if (JSON.stringify(version.outline) !== JSON.stringify(outline))
          throw new Error("编辑器还有未保存的更改，请先逐页保存并核对。");
        const artifact = await api(
          `/api/deck-versions/${deckVersionId}/export`,
          json({ conversationId: chat.state.id }),
        );
        setDeckUrl(artifact.url);
        return;
      }
      const result = await api(
        "/api/decks",
        json({
          paperId,
          outline,
          ...(current?.deck ? { runId: current.id } : {}),
        }),
      );
      setDeckUrl(result.url);
      setNotice("PPTX 已生成，文本和讲稿可编辑。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function savePersonal(
    kind: "favorite" | "feedback",
    feedback?: "read" | "confused" | "understood",
    sectionIndex?: number,
  ) {
    if (!current?.input.conversationId)
      throw new Error("此历史讲解未绑定会话；请重新打开讲解后保存个人记录。");
    const id = current.input.conversationId;
    if (chat.state?.id !== id) await chat.select(id);
    const state = await api<ConversationState>(`/api/conversations/${id}`);
    chat.setState(
      await api<ConversationState>(
        `/api/conversations/${id}/records`,
        json({
          version: state.version,
          kind,
          unitId: current.id,
          ...(feedback ? { feedback } : {}),
          ...(sectionIndex !== undefined ? { sectionIndex } : {}),
        }),
      ),
    );
  }
  async function mark(state: "read" | "confused" | "understood") {
    if (!current) return;
    try {
      await savePersonal("feedback", state);
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setProgress((prev) => [
      ...prev.filter((p) => p.unitId !== current.id),
      { unitId: current.id, state },
    ]);
  }
  async function runReplay() {
    setBusy(true);
    setError("");
    try {
      setBatch(
        await api(
          "/api/replays",
          json({ skillId, text: candidate, mode: replayMode }),
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!ready)
    return (
      <main className="loading">
        <div className="app-symbol">医</div>
        <h1>医学科研入门导师</h1>
        <p>{error || "正在加载…"}</p>
      </main>
    );
  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setShowLibrary(true)}>
          <span className="app-symbol">医</span>
          <span>
            医学科研入门导师<small>从看见结果，到理解科研</small>
          </span>
        </button>
        <span className="saved">
          <i />
          {saveState}
        </span>
        <button className="quiet" onClick={() => setSettings(!settings)}>
          设置与记录
        </button>
      </header>
      {error && (
        <div role="alert" className="alert">
          {error}
          <button onClick={() => setError("")}>关闭</button>
        </div>
      )}
      {notice && (
        <div role="status" className="notice">
          {notice}
        </div>
      )}
      {settings && (
        <section className="settings panel">
          <div className="panel-heading">
            <h2>设置与学习记录</h2>
            <button onClick={() => setSettings(false)}>收起</button>
          </div>
          <div className="settings-grid">
            <div>
              <label>
                运行模式
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as Mode)}
                  disabled={isRunning}
                >
                  <option value="example">示例讲解</option>
                  <option value="live">实时对话</option>
                </select>
              </label>
              <p className="hint">
                GPT-6.1 Sol ·{" "}
                {model?.authenticated ? "ChatGPT 登录已识别" : "模型尚未连接"}
              </p>
              {model?.error && <p className="hint">{model.error}</p>}
              <button onClick={() => void api("/api/model").then(setModel)}>
                重新检查连接
              </button>
              <details>
                <summary>资料信息</summary>
                <p className="hint">实时对话将选中的材料发送给云端模型。</p>
                <p className="hint">{paper?.scope}</p>
              </details>
            </div>
            <div>
              <label>
                本次模拟画像
                <select
                  value={profileId}
                  onChange={(e) => setProfileId(e.target.value)}
                  disabled={isRunning}
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={() => setShowReplay(!showReplay)}>
                规则版本与案例回放
              </button>
            </div>
            <div>
              <strong>主动收藏的术语</strong>
              <p className="hint">
                {bookmarks.join("、") || "还没有收藏。点击讲解中的术语收藏。"}
              </p>
              <button onClick={() => setBookmarks([])}>清空收藏</button>
            </div>
          </div>
          <div className="history">
            {runs.slice(0, 10).map((r) => (
              <div key={r.id}>
                <button
                  onClick={() => {
                    if (isRunning) return;
                    const p = papers.find((p) => p.id === r.input.paperId);
                    if (p) selectPaper(p);
                    setCurrent(r);
                    setModule(r.input.module);
                    setMode(r.input.mode);
                    if (r.deck) setOutline(r.deck);
                  }}
                >
                  {r.result?.title || r.input.question}
                  <small>
                    {statusNames[r.status]} ·{" "}
                    {new Date(r.createdAt).toLocaleString("zh-CN")}
                  </small>
                </button>
                <button
                  aria-label="删除记录"
                  disabled={isRunning}
                  onClick={() =>
                    void api("/api/tasks/" + r.id, { method: "DELETE" })
                      .then(() => {
                        setRuns((prev) => prev.filter((x) => x.id !== r.id));
                        if (current?.id === r.id) setCurrent(null);
                      })
                      .catch((e) => setError(e.message))
                  }
                >
                  删除
                </button>
              </div>
            ))}
          </div>
          <PersonalRecordsPanel
            state={chat.state}
            ensure={chat.ensure}
            onState={chat.setState}
            onView={chat.view}
            disabled={busy || isRunning || Boolean(chat.active)}
          />
        </section>
      )}
      {showReplay && (
        <section className="panel replay">
          <div className="panel-heading">
            <h2>跨案例规则比较</h2>
            <button onClick={() => setShowReplay(false)}>收起</button>
          </div>
          <p className="hint">选择教学模块，对比修改前后的讲解。</p>
          <select value={skillId} onChange={(e) => setSkillId(e.target.value)}>
            {skills
              .filter(
                (s) =>
                  ![
                    "medical-novice-simulator",
                    "medical-grounding-check",
                  ].includes(s.id),
              )
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} · {s.version}
                </option>
              ))}
          </select>
          <textarea
            aria-label="候选规则"
            rows={8}
            value={candidate}
            onChange={(e) => setCandidate(e.target.value)}
          />
          <div className="action-row">
            <select
              aria-label="回放模式"
              value={replayMode}
              onChange={(e) => setReplayMode(e.target.value as any)}
            >
              <option value="fixture">规则检查</option>
              <option value="live">实时完整回放 · 最多 96 次生成</option>
            </select>
            <button disabled={busy || isRunning} onClick={runReplay}>
              保存基线并比较
            </button>
            {busy && (
              <button
                onClick={() =>
                  void api("/api/replays/cancel", json({})).then(() =>
                    setNotice("正在取消回放…"),
                  )
                }
              >
                取消回放
              </button>
            )}
          </div>
          {batch && (
            <>
              <p>
                {batch.mode === "fixture" ? "规则检查结果" : "实时案例比较"} ·{" "}
                {batch.calls} 次调用 ·{" "}
                {batch.decision === "pending"
                  ? "待决定"
                  : batch.decision === "keep"
                    ? "已保存候选"
                    : "已撤回"}
              </p>
              <table>
                <thead>
                  <tr>
                    <th>案例</th>
                    <th>划分</th>
                    <th>基线</th>
                    <th>候选</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.results.map((r: any) => (
                    <tr key={r.caseId}>
                      <td>{r.caseId}</td>
                      <td>{r.split === "holdout" ? "留出" : "开发"}</td>
                      <td>
                        {r.baseline.passed
                          ? "通过"
                          : r.baseline.findings.join("；")}
                      </td>
                      <td>
                        {r.candidate.passed
                          ? "通过"
                          : r.candidate.findings.join("；")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="action-row">
                {["keep", "revert"].map((decision) => (
                  <button
                    key={decision}
                    disabled={batch.decision !== "pending"}
                    onClick={() =>
                      void api(
                        "/api/revisions/" + batch.id + "/decision",
                        json({ decision, note: "用户在比较面板审查后决定" }),
                      )
                        .then(setBatch)
                        .catch((e) => setError(e.message))
                    }
                  >
                    {decision === "keep" ? "保留候选" : "撤回候选"}
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
      )}
      {showLibrary ? (
        <main className="library">
          <div className="eyebrow">你的科研学习空间</div>
          <h1>
            读懂一篇论文，
            <br />
            从一个问题开始。
          </h1>
          <p className="intro">
            把术语、方法和图表拆开理解，再把实验连成你能讲清楚的证据链。
          </p>
          <div className="library-grid">
            <section className="paper-card panel">
              <div className="paper-label">
                基础医学 <span>示例论文</span>
              </div>
              <h2>
                衰老细胞如何
                <br />
                影响身体功能？
              </h2>
              <p>Xu et al. · Nature Medicine · 2018</p>
              <div className="paper-route">
                <span>研究问题</span>
                <i>→</i>
                <span>移植实验</span>
                <i>→</i>
                <span>功能变化</span>
              </div>
              <button
                className="primary"
                onClick={() => {
                  if (sample) selectPaper(sample);
                }}
              >
                打开示例论文 <span>↗</span>
              </button>
            </section>
            <section className="upload-card panel">
              <span className="upload-icon">＋</span>
              <h2>开始阅读你的论文</h2>
              <p>上传文本型 PDF，在原文旁讲解、圈选图件和追问。</p>
              <button onClick={() => file.current?.click()} disabled={busy}>
                选择 PDF
              </button>
              <small>PDF · 最大 30 MB · 100 页</small>
              {papers
                .filter((p) => p.id !== "xu-2018")
                .map((p) => (
                  <button
                    key={p.id}
                    className="paper-link"
                    onClick={() => selectPaper(p)}
                  >
                    {p.title}
                  </button>
                ))}
            </section>
          </div>
          <div className="entrance-grid">
            {(Object.entries(moduleNames) as [Module, string][]).map(
              ([id, name], i) => (
                <button
                  key={id}
                  onClick={() => {
                    setModule(id);
                    setShowLibrary(false);
                  }}
                >
                  <span className="entrance-icon">
                    {["文", "术", "图", "演"][i]}
                  </span>
                  <strong>{name}</strong>
                  <small>
                    {
                      [
                        "按单元展开研究与推理",
                        "PCR、qPCR 与流式基础",
                        "先学怎么看，再解释含义",
                        "先调整大纲，再导出讲稿",
                      ][i]
                    }
                  </small>
                </button>
              ),
            )}
          </div>
        </main>
      ) : (
        <main className="workspace">
          <div className="workspace-heading">
            <div>
              <button className="back" onClick={() => setShowLibrary(true)}>
                ‹ 论文库
              </button>
              <h1>{paper?.title}</h1>
            </div>
            <div className="workspace-controls">
              <select
                aria-label="选择论文"
                value={paperId}
                disabled={isRunning}
                onChange={(e) => {
                  const p = papers.find((p) => p.id === e.target.value);
                  if (p) selectPaper(p);
                }}
              >
                {papers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
              <button onClick={() => file.current?.click()} disabled={busy}>
                上传 PDF
              </button>
            </div>
          </div>
          <nav className="tabs" aria-label="学习模块">
            {(Object.entries(moduleNames) as [Module, string][]).map(
              ([id, name]) => (
                <button
                  key={id}
                  className={module === id ? "active" : ""}
                  disabled={isRunning}
                  onClick={() => {
                    setModule(id);
                    setCurrent(null);
                    setDeckUrl("");
                  }}
                >
                  {name}
                </button>
              ),
            )}
          </nav>
          {module === "ppt" ? (
            <div className="deck-workspace">
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <div className="eyebrow">可编辑大纲</div>
                    <h2>把理解整理成汇报</h2>
                  </div>
                  <span className="badge">{outline.slides.length} 页</span>
                </div>
                <p className="hint">调整标题、要点、顺序和讲稿。</p>
                {!outline.slides.length && (
                  <p>请先用实时模式生成这篇论文的大纲。</p>
                )}
                {outline.slides.map((slide, i) => (
                  <article className="slide-editor" key={i}>
                    <span className="slide-number">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <input
                        aria-label={`第 ${i + 1} 页标题`}
                        value={slide.title}
                        maxLength={65}
                        onChange={(e) =>
                          updateSlide(i, "title", e.target.value)
                        }
                      />
                      <textarea
                        aria-label={`第 ${i + 1} 页内容`}
                        value={slide.bullets.join("\n")}
                        rows={3}
                        onChange={(e) =>
                          updateSlide(i, "bullets", e.target.value.split("\n"))
                        }
                      />
                      <details>
                        <summary>讲稿与来源</summary>
                        <textarea
                          aria-label={`第 ${i + 1} 页讲稿`}
                          value={slide.notes}
                          onChange={(e) =>
                            updateSlide(i, "notes", e.target.value)
                          }
                        />
                        <p className="hint">{slide.citations.join(" · ")}</p>
                      </details>
                    </div>
                    <div className="slide-actions">
                      <button
                        aria-label="上移"
                        disabled={i === 0}
                        onClick={() =>
                          setOutline((prev) => {
                            const slides = [...prev.slides];
                            [slides[i], slides[i - 1]] = [
                              slides[i - 1],
                              slides[i],
                            ];
                            return { slides };
                          })
                        }
                      >
                        ↑
                      </button>
                      <button
                        aria-label="下移"
                        disabled={i === outline.slides.length - 1}
                        onClick={() =>
                          setOutline((prev) => {
                            const slides = [...prev.slides];
                            [slides[i], slides[i + 1]] = [
                              slides[i + 1],
                              slides[i],
                            ];
                            return { slides };
                          })
                        }
                      >
                        ↓
                      </button>
                      <button
                        aria-label="删除幻灯片"
                        onClick={() =>
                          setOutline((prev) => ({
                            slides: prev.slides.filter((_, j) => j !== i),
                          }))
                        }
                      >
                        ×
                      </button>
                    </div>
                  </article>
                ))}
                <button
                  onClick={() =>
                    setOutline((prev) => ({
                      slides: [
                        ...prev.slides,
                        {
                          title: "新页面",
                          bullets: ["填写要点"],
                          notes: "填写讲稿",
                          citations: paper?.sources[0]
                            ? [paper.sources[0].id]
                            : [],
                        },
                      ],
                    }))
                  }
                  disabled={outline.slides.length >= 16}
                >
                  ＋ 添加页面
                </button>
              </section>
              <aside className="panel export-panel">
                <DeckVersionPanel
                  conversation={chat.state}
                  ensure={chat.ensure}
                  paperId={paperId}
                  runId={current?.deck ? current.id : undefined}
                  outline={outline}
                  onState={chat.setState}
                  onExport={setDeckUrl}
                  onVersion={(version, keepDraft) => {
                    setDeckVersionId(version.id);
                    setDeckUrl("");
                    setOutline((prev) =>
                      keepDraft && version.slideIndex !== undefined
                        ? {
                            slides: prev.slides.map((s, i) =>
                              i === version.slideIndex
                                ? version.outline.slides[i]
                                : s,
                            ),
                          }
                        : version.outline,
                    );
                  }}
                />
                <div className="eyebrow">汇报输出</div>
                <h2>讲清每一页</h2>
                <p>导出可编辑 PPT，附每页讲稿。</p>
                <button
                  onClick={() =>
                    mode === "example"
                      ? loadExample()
                      : execute(
                          "依据所选论文资料，生成八页中文入门汇报与讲稿。",
                        )
                  }
                  disabled={busy || isRunning}
                >
                  {mode === "example" ? "载入示例大纲" : "生成大纲"}
                </button>
                <button
                  className="primary"
                  onClick={makeDeck}
                  disabled={busy || !outline.slides.length}
                >
                  生成 PPTX
                </button>
                {deckUrl && (
                  <a className="download" href={deckUrl}>
                    下载汇报 PPTX ↓
                  </a>
                )}
                {current && (
                  <p className="hint">{statusNames[current.status]}</p>
                )}
              </aside>
            </div>
          ) : (
            <div
              className="reading-layout"
              style={{ "--reader-ratio": ratio + "%" } as React.CSSProperties}
            >
              <section className="reader panel">
                <div className="reader-heading">
                  <div>
                    <span className="eyebrow">原文与依据</span>
                    <h2>{paper?.pdfUrl ? "PDF 阅读器" : "论文证据摘要"}</h2>
                  </div>
                  <span className="badge">
                    {paper?.pdfUrl
                      ? `${page} / ${paper.pageCount || "?"}`
                      : "阅读材料"}
                  </span>
                </div>
                {paper?.pdfUrl && (
                  <>
                    <div className="reader-tools">
                      <button
                        disabled={page <= 1}
                        onClick={() => setPage((p) => p - 1)}
                      >
                        上一页
                      </button>
                      <input
                        aria-label="PDF 页码"
                        type="number"
                        min={1}
                        max={paper.pageCount || 100}
                        value={page}
                        onChange={(e) =>
                          setPage(
                            Math.max(
                              1,
                              Math.min(
                                paper.pageCount || 100,
                                Number(e.target.value),
                              ),
                            ),
                          )
                        }
                      />
                      <button
                        disabled={page >= (paper.pageCount || 1)}
                        onClick={() => setPage((p) => p + 1)}
                      >
                        下一页
                      </button>
                      <select
                        aria-label="缩放"
                        value={zoom}
                        onChange={(e) => setZoom(Number(e.target.value))}
                      >
                        <option value={0.8}>80%</option>
                        <option value={1}>100%</option>
                        <option value={1.3}>130%</option>
                        <option value={1.6}>160%</option>
                      </select>
                    </div>
                    <PdfReader
                      paper={paper}
                      page={page}
                      zoom={zoom}
                      onImage={(url) => {
                        setImage(url);
                        setNotice("圈选已加入下一次提问，可补充相应图注。");
                      }}
                      onError={setError}
                    />
                  </>
                )}
                <details ref={sourceDetails} open={!paper?.pdfUrl}>
                  <summary>
                    {paper?.pdfUrl
                      ? "按页提取的文字与本次材料"
                      : "可定位的教学依据"}
                  </summary>
                  <div className="sources">
                    {sources
                      .filter((s) => !s.page || s.page === page)
                      .map((s) => (
                        <article
                          key={s.id}
                          ref={(node) => {
                            sourceRefs.current[s.id] = node;
                          }}
                          className={
                            "source-block " +
                            (activeSource === s.id ? "focused" : "")
                          }
                        >
                          <label className="source-label">
                            <input
                              type="checkbox"
                              checked={selectedSources.includes(s.id)}
                              onChange={(e) =>
                                setSelectedSources((prev) =>
                                  e.target.checked
                                    ? [...prev, s.id]
                                    : prev.filter((id) => id !== s.id),
                                )
                              }
                            />
                            <strong>{s.title}</strong>
                            <span>
                              {s.kind === "foundation"
                                ? "基础知识"
                                : s.page && paper?.pdfUrl
                                  ? "论文原文"
                                  : "论文资料"}
                            </span>
                          </label>
                          <p>{s.text || "未提取到文字，请补充原文或图注。"}</p>
                          <small>{s.locator}</small>
                          {s.image && (
                            <img
                              className="source-image"
                              src={s.image}
                              alt={
                                s.figure && s.page
                                  ? "论文图件所在原页"
                                  : "保存的论文原图圈选"
                              }
                            />
                          )}
                          {s.url && (
                            <a href={s.url} target="_blank" rel="noreferrer">
                              打开原始来源 ↗
                            </a>
                          )}
                        </article>
                      ))}
                  </div>
                </details>
                {paper?.pdfUrl && (
                  <details>
                    <summary>补充原文 / 图注</summary>
                    <textarea
                      aria-label="补充原文"
                      value={manualText}
                      onChange={(e) => setManualText(e.target.value)}
                      placeholder="粘贴这一页的原文或完整图注"
                      rows={5}
                    />
                    <button
                      onClick={() =>
                        void api<PaperBundle>(
                          "/api/papers/" + paper.id + "/text",
                          json({
                            text: manualText,
                            page,
                            title: "手动补充原文 / 图注",
                          }),
                        )
                          .then((p) => {
                            setPapers((prev) =>
                              prev.map((x) => (x.id === p.id ? p : x)),
                            );
                            setManualText("");
                            setSelectedSources((prev) => [
                              ...prev,
                              p.sources.at(-1)!.id,
                            ]);
                          })
                          .catch((e) => setError(e.message))
                      }
                      disabled={!manualText}
                    >
                      保存补充材料
                    </button>
                  </details>
                )}
                {image && (
                  <div className="crop-preview">
                    <img src={image} alt="手动圈选的论文图件" />
                    <button onClick={() => setImage(undefined)}>
                      移除圈选
                    </button>
                    {paper?.pdfUrl && (
                      <>
                        <textarea
                          aria-label="圈选图件图注"
                          value={manualText}
                          onChange={(e) => setManualText(e.target.value)}
                          placeholder="填写完整图注后保存图件，可用于 PPT 原图嵌入"
                        />
                        <button
                          disabled={!manualText.trim()}
                          onClick={() =>
                            void api<PaperBundle>(
                              "/api/papers/" + paper.id + "/figure",
                              json({ image, page, caption: manualText }),
                            )
                              .then((p) => {
                                setPapers((prev) =>
                                  prev.map((x) => (x.id === p.id ? p : x)),
                                );
                                setSelectedSources((prev) => [
                                  ...prev,
                                  p.sources.at(-1)!.id,
                                ]);
                                setManualText("");
                                setNotice(
                                  "图件与图注已保存，生成汇报时可引用原图。",
                                );
                              })
                              .catch((e) => setError(e.message))
                          }
                        >
                          保存图件与图注
                        </button>
                      </>
                    )}
                  </div>
                )}
              </section>
              <div className="splitter">
                <input
                  type="range"
                  aria-label="调整两栏宽度"
                  min={30}
                  max={65}
                  value={ratio}
                  onChange={(e) => setRatio(Number(e.target.value))}
                />
              </div>
              <section className="tutor panel">
                <ConversationPanel
                  chat={chat}
                  options={{ mode, paperId, profileId }}
                  disabled={busy || isRunning}
                />
                <div className="tutor-heading">
                  <span className="tutor-symbol">研</span>
                  <div>
                    <h2>一起把这一步读懂</h2>
                    <p>解释概念，展开推理，保留依据</p>
                  </div>
                  <span className="badge">
                    {mode === "example" ? "示例" : "实时"}
                  </span>
                </div>
                {module === "method" && (
                  <div className="segmented">
                    <button
                      className={method === "qpcr" ? "active" : ""}
                      onClick={() => {
                        setMethod("qpcr");
                        setCurrent(null);
                      }}
                    >
                      PCR / qPCR
                    </button>
                    <button
                      className={method === "flow" ? "active" : ""}
                      onClick={() => {
                        setMethod("flow");
                        setCurrent(null);
                      }}
                    >
                      流式细胞术
                    </button>
                  </div>
                )}
                {current ? (
                  <>
                    <div className={"run-status " + current.status}>
                      <span className={isRunning ? "spinner" : ""} />
                      {statusNames[current.status]}
                      {isRunning && (
                        <button
                          onClick={() =>
                            void (
                              chat.active
                                ? chat.cancel()
                                : api(
                                    "/api/tasks/" + current.id + "/cancel",
                                    json({}),
                                  )
                            )
                              .then(() =>
                                api<TaskRun>("/api/tasks/" + current.id),
                              )
                              .then(setCurrent)
                              .catch((e) => setError(e.message))
                          }
                        >
                          取消任务
                        </button>
                      )}
                    </div>
                    {current.result ? (
                      <>
                        <div className="unit-heading">
                          <div className="eyebrow">
                            {current.input.mode === "example"
                              ? "示例讲解"
                              : "导师讲解"}
                          </div>
                          <h2>{current.result.title}</h2>
                          <p>{current.result.question}</p>
                        </div>
                        <div className="term-list">
                          {current.result.terms.map((t) => (
                            <details key={t.name}>
                              <summary>{t.name}</summary>
                              <p>{t.explanation}</p>
                              <button
                                onClick={() =>
                                  setBookmarks((prev) =>
                                    prev.includes(t.name)
                                      ? prev.filter((x) => x !== t.name)
                                      : [...prev, t.name],
                                  )
                                }
                              >
                                {bookmarks.includes(t.name)
                                  ? "已收藏 · 取消"
                                  : "收藏术语"}
                              </button>
                            </details>
                          ))}
                        </div>
                        {current.result.sections.map((s, sectionIndex) => (
                          <article className="learning-section" key={s.title}>
                            <div className="section-title">
                              <h3>{s.title}</h3>
                              <small>
                                {s.kind === "paper"
                                  ? "论文事实"
                                  : s.kind === "foundation"
                                    ? "基础知识"
                                    : s.kind === "background"
                                      ? "背景解释 · 未核验"
                                      : "解释与推理"}
                              </small>
                            </div>
                            <p>{s.text}</p>
                            <button
                              disabled={isRunning}
                              onClick={() =>
                                void savePersonal(
                                  "favorite",
                                  undefined,
                                  sectionIndex,
                                ).catch((err) => setError(err.message))
                              }
                            >
                              收藏这段解释
                            </button>
                            <button
                              disabled={
                                isRunning ||
                                !chat.state ||
                                !current.input.conversationId ||
                                current.input.conversationId !== chat.state.id
                              }
                              onClick={() => {
                                const selected = window
                                  .getSelection()
                                  ?.toString()
                                  .trim();
                                chat.setFocus({
                                  runId: current.id,
                                  sectionIndex,
                                  excerpt:
                                    selected && s.text.includes(selected)
                                      ? selected.slice(0, 2000)
                                      : s.text.slice(0, 2000),
                                });
                                document
                                  .querySelector('[aria-label="统一对话问题"]')
                                  ?.scrollIntoView({
                                    behavior: "smooth",
                                    block: "center",
                                  });
                              }}
                            >
                              针对这句话追问
                            </button>
                            <div className="citations">
                              {s.citations.map((id) => (
                                <button key={id} onClick={() => locate(id)}>
                                  ↗{" "}
                                  {sources.find((s) => s.id === id)?.title ||
                                    id}
                                </button>
                              ))}
                            </div>
                          </article>
                        ))}
                        <p className="next-question">
                          下一步可以问：{current.result.nextQuestion}
                        </p>
                        <button
                          disabled={isRunning || busy}
                          onClick={() =>
                            mode === "live"
                              ? execute(current.result!.nextQuestion)
                              : (setModule(
                                  module === "paper" ? "figure" : "method",
                                ),
                                setCurrent(null))
                          }
                        >
                          下一步 →
                        </button>
                        <div className="action-row progress-buttons">
                          <button onClick={() => mark("read")}>读过</button>
                          <button
                            onClick={() => {
                              mark("confused");
                              if (mode === "live")
                                setQuestion(
                                  "还是不懂，请定位当前讲解的断点，拆成一个更小的步骤。",
                                );
                              else
                                setNotice("已记录，切换实时对话后可继续追问。");
                            }}
                          >
                            仍不理解
                          </button>
                          <button onClick={() => mark("understood")}>
                            主动标记已理解
                          </button>
                          <a href={"/api/tasks/" + current.id + "/notes"}>
                            导出笔记 ↓
                          </a>
                        </div>
                        <p className="hint">
                          你的记录：
                          {(
                            {
                              read: "读过",
                              confused: "表示不懂",
                              understood: "主动标记已理解",
                            } as any
                          )[
                            (chat.state &&
                            chat.state.id === current.input.conversationId
                              ? chat.state.userProgress
                              : progress
                            ).find((p) => p.unitId === current.id)?.state || ""
                          ] || "尚未标记"}
                        </p>
                      </>
                    ) : (
                      !isRunning && (
                        <p className="empty-message">
                          {current.error || "讲解未完成，请查看任务记录。"}
                        </p>
                      )
                    )}
                    <details className="review-details">
                      <summary>讲解检查</summary>
                      {current.novice && (
                        <>
                          <h4>模拟新手试读</h4>
                          {current.novice.breakpoints.length ? (
                            current.novice.breakpoints.map((b) => (
                              <p key={b.id}>
                                「{b.sentence}」<br />
                                {b.question} ·{" "}
                                {b.status === "resolved"
                                  ? "已补足"
                                  : b.status === "insufficient"
                                    ? "材料不足"
                                    : "仍未解决"}
                              </p>
                            ))
                          ) : (
                            <p>当前画像未报告具体断点。</p>
                          )}
                        </>
                      )}
                      {current.review && (
                        <>
                          <h4>核对结果</h4>
                          {current.review.issues.map((i) => (
                            <p key={i.id}>
                              {i.location}：{i.suggestion}（
                              {i.resolved ? "已解决" : "待核验"}）
                            </p>
                          ))}
                        </>
                      )}
                      <details>
                        <summary>技术记录</summary>
                        <pre>
                          {JSON.stringify(
                            {
                              skills: current.skillVersions,
                              model: current.model,
                              sourceVersion: current.sourceVersion,
                              limitations: current.review?.limitations,
                              calls: current.calls,
                              profile: current.profileVersion,
                              events: current.events,
                              roles: current.roles.map((r) => ({
                                role: r.role,
                                inputKeys: r.inputKeys,
                                durationMs: r.durationMs,
                              })),
                            },
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    </details>
                  </>
                ) : (
                  <div className="tutor-empty">
                    <div className="lesson-icon">
                      {module === "method"
                        ? "术"
                        : module === "figure"
                          ? "图"
                          : "文"}
                    </div>
                    <h3>
                      {module === "method"
                        ? "先弄清“到底测了什么”"
                        : module === "figure"
                          ? "按顺序，把图读清楚"
                          : "先读懂这个实验为什么做"}
                    </h3>
                    <p>
                      {module === "method"
                        ? "从原理、测量对象到结果含义。"
                        : module === "figure"
                          ? "认坐标、分组和图注，再比较结果与结论。"
                          : "从研究问题开始，逐步连接概念、对照与结果。"}
                    </p>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        mode === "example"
                          ? loadExample()
                          : execute(
                              module === "method"
                                ? method === "qpcr"
                                  ? "从基础讲解 PCR/qPCR 的原理、测量对象、对照与边界。"
                                  : "从基础讲解流式细胞术、门控、对照与结果边界。"
                                : module === "figure"
                                  ? "解释当前所选图件与图注，缺材料时请说明。"
                                  : "从研究问题开始，解释所选材料的实验与证据链。",
                            )
                      }
                    >
                      {mode === "example" ? "打开教学示例" : "开始实时讲解"}{" "}
                      <span>→</span>
                    </button>
                  </div>
                )}
                <div className="question-area">
                  <div className="quick-questions">
                    {["从基础讲起", "换个例子", "为什么能推出结论"].map((q) => (
                      <button
                        key={q}
                        disabled={mode === "example" || isRunning}
                        onClick={() =>
                          setQuestion(
                            q + "：" + (current?.result?.question || ""),
                          )
                        }
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (mode === "live" && question.trim())
                        void execute(question);
                    }}
                  >
                    <textarea
                      aria-label="向导师提问"
                      placeholder={
                        mode === "example"
                          ? "切换实时对话，向导师提问…"
                          : "把不懂的句子或步骤告诉导师…"
                      }
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      rows={2}
                      disabled={mode === "example" || isRunning}
                    />
                    <button
                      className="primary"
                      disabled={
                        mode === "example" ||
                        isRunning ||
                        busy ||
                        !question.trim()
                      }
                    >
                      发送 ↑
                    </button>
                  </form>
                  {mode === "example" && (
                    <button
                      className="text-button"
                      onClick={() => setMode("live")}
                    >
                      切换实时对话
                    </button>
                  )}
                  <p className="hint">
                    本次选择 {selectedSources.length} 条资料
                    {image ? " · 含圈选图像" : ""}
                  </p>
                </div>
              </section>
            </div>
          )}
        </main>
      )}
      <input
        ref={file}
        type="file"
        accept="application/pdf,.pdf"
        onChange={uploadPdf}
        hidden
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
