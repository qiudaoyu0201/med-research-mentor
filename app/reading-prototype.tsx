import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { sample } from "../examples/bundle.ts";
import "./reading-prototype.css";

type IconName =
  | "book"
  | "chat"
  | "plus"
  | "chevron"
  | "arrow"
  | "file"
  | "close"
  | "panel"
  | "expand"
  | "link"
  | "check"
  | "settings"
  | "search"
  | "menu"
  | "spark";
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    book: (
      <>
        <path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4z" />
        <path d="M20 4h-4a3 3 0 0 0-3 3v14a4 4 0 0 1 4-2h3z" />
      </>
    ),
    chat: <path d="M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0Z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
    file: (
      <>
        <path d="M14 3H5v18h14V8zM14 3v6h5" />
        <path d="M8 13h8M8 17h5" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    panel: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M15 4v16" />
      </>
    ),
    expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
    link: (
      <>
        <path d="m10 13 4-4m-6 2-3 3a4 4 0 0 0 6 6l3-3m-4-10 3-3a4 4 0 0 1 6 6l-3 3" />
      </>
    ),
    check: <path d="m5 12 4 4 10-10" />,
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" />
        <circle cx="15" cy="17" r="3" />
      </>
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 5 5" />
      </>
    ),
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    spark: (
      <>
        <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" />
        <path d="M20 2v4m-2-2h4" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

type Topic = "question" | "control" | "figure";
type Tab = "reading" | "sources" | "notes";
type Message = {
  id: number;
  role: "user" | "assistant";
  topic: Topic;
  text?: string;
};
type Task = { id: string; title: string; topic: Topic; messages: Message[] };
const sources = sample.sources.filter((source) => source.kind === "paper");
const topics: Record<
  Topic,
  { title: string; question: string; summary: string; source: string }
> = {
  question: {
    title: "读懂研究问题",
    question: "我刚开始做科研，能带我读懂这篇论文的研究问题吗？",
    summary:
      "这篇论文想知道：衰老细胞只是伴随衰老出现，还是能够参与引起身体功能下降？",
    source: "xu-question",
  },
  control: {
    title: "理解实验对照",
    question: "为什么既要移植非衰老细胞，又要设置 PBS 对照？",
    summary:
      "两种对照回答不同的问题：影响来自细胞的衰老状态，还是注射与移植过程本身？",
    source: "xu-design",
  },
  figure: {
    title: "解读 Figure 1",
    question: "Figure 1 应该从哪里开始读？",
    summary:
      "先看比较了哪些组，再认身体功能指标，最后把每个观察与论文的结论对应起来。",
    source: "xu-fig1",
  },
};
const initialTasks: Task[] = (Object.keys(topics) as Topic[]).map(
  (topic, index) => ({
    id: topic,
    title: topics[topic].title,
    topic,
    messages: [
      { id: index * 10, role: "user", topic, text: topics[topic].question },
      { id: index * 10 + 1, role: "assistant", topic },
    ],
  }),
);

export function ReadingPrototype() {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [taskId, setTaskId] = useState("question");
  const [tab, setTab] = useState<Tab>("reading");
  const [activeSource, setActiveSource] = useState("xu-question");
  const [viewerOpen, setViewerOpen] = useState(
    () => window.matchMedia("(min-width: 701px)").matches,
  );
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width: 1000px)").matches,
  );
  const [expanded, setExpanded] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [question, setQuestion] = useState("");
  const [notes, setNotes] = useState(() => {
    try {
      return localStorage.getItem("reading-prototype-notes-v1") || "";
    } catch {
      return "";
    }
  });
  const [noteSaved, setNoteSaved] = useState(true);
  const [toast, setToast] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [upload, setUpload] = useState<{
    name: string;
    size: number;
    url: string;
  } | null>(null);
  const [pdfOpen, setPdfOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const messageEnd = useRef<HTMLDivElement>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const sourceRefs = useRef<Record<string, HTMLElement | null>>({});
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pdfDialogRef = useRef<HTMLDialogElement>(null);
  const settingsRef = useRef<HTMLButtonElement>(null);
  const task = tasks.find((item) => item.id === taskId)!;
  const topic = topics[task.topic];

  useEffect(() => {
    document.title = "研习 · 论文阅读工作台";
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1000px)");
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    messageEnd.current?.scrollIntoView({ block: "nearest" });
  }, [taskId, task.messages.length]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (settingsOpen) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [settingsOpen]);
  useEffect(() => {
    if (pdfOpen && upload) pdfDialogRef.current?.showModal();
    else pdfDialogRef.current?.close();
  }, [pdfOpen, upload]);
  useEffect(
    () => () => {
      if (upload) URL.revokeObjectURL(upload.url);
    },
    [upload],
  );
  useEffect(() => {
    if (tab === "sources" && viewerOpen)
      sourceRefs.current[activeSource]?.scrollIntoView({ block: "nearest" });
  }, [activeSource, tab, viewerOpen]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
        setSidebarOpen(false);
        setPdfOpen(false);
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, []);

  function selectTask(item: Task) {
    setTaskId(item.id);
    setQuestion("");
    setSidebarOpen(false);
    setActiveSource(topics[item.topic].source);
  }
  function showSource(id: string) {
    setActiveSource(id);
    setTab("sources");
    setViewerOpen(true);
  }
  function ask(text: string, explicitTopic?: Topic) {
    const value = text.trim();
    if (!value) return;
    const nextTopic =
      explicitTopic ||
      (/对照|PBS/.test(value)
        ? "control"
        : /图|figure/i.test(value)
          ? "figure"
          : "question");
    const known =
      explicitTopic || /研究|问题|对照|PBS|图|figure|通俗|简单/i.test(value);
    const id = Date.now();
    setTasks((prev) =>
      prev.map((item) =>
        item.id !== taskId
          ? item
          : {
              ...item,
              topic: nextTopic,
              messages: [
                ...item.messages,
                { id, role: "user", topic: nextTopic, text: value },
                {
                  id: id + 1,
                  role: "assistant",
                  topic: nextTopic,
                  text: /通俗|简单/.test(value)
                    ? nextTopic === "control"
                      ? "简单说：非衰老细胞组用来比较“细胞有没有衰老”；PBS 组用来比较“注射这件事有没有影响”。两个比较放在一起，才能更清楚地判断差异来自哪里。"
                      : nextTopic === "figure"
                        ? "把 Figure 1 当成几次小比较：先认每组小鼠接受了什么，再看测了哪种身体功能，最后判断哪些指标有差异。不要把一项指标的变化，当作所有功能都变化了。"
                        : "作者想知道：这些细胞只是跟着身体一起变老，还是也会影响身体功能？于是，他们把不同状态的细胞放进年轻小鼠，再比较小鼠的身体功能。"
                    : known
                      ? undefined
                      : "这条提问已加入当前阅读任务。这个交互预览展示固定示例解读；你可以继续查看研究问题、实验对照或 Figure 1 的示例。",
                },
              ],
            },
      ),
    );
    setQuestion("");
    setTab("reading");
    setActiveSource(topics[nextTopic].source);
  }
  function newTask() {
    const id = `reading-${Date.now()}`;
    setTasks((prev) => [
      ...prev,
      { id, title: "新的论文阅读", topic: "question", messages: [] },
    ]);
    setTaskId(id);
    setQuestion("");
    setSearch("");
    setSidebarOpen(false);
    setTab("reading");
    questionRef.current?.focus();
  }
  function saveNotes() {
    try {
      localStorage.setItem("reading-prototype-notes-v1", notes);
      setNoteSaved(true);
      setToast("阅读笔记已保存在此浏览器");
    } catch {
      setToast("浏览器暂时无法保存，请导出笔记");
    }
  }
  function exportNotes() {
    const url = URL.createObjectURL(
      new Blob(
        [
          `# ${sample.title}\n\n${notes || topic.summary}\n\n来源：${sample.doi}\n`,
        ],
        { type: "text/markdown;charset=utf-8" },
      ),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "论文阅读笔记.md";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function uploadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) {
      setToast("请选择 PDF 文件");
      return;
    }
    if (file.size > 30 * 1024 * 1024) {
      setToast("请选择 30 MB 以内的 PDF");
      return;
    }
    setUpload({
      name: file.name,
      size: file.size,
      url: URL.createObjectURL(new Blob([file], { type: "application/pdf" })),
    });
    setToast("PDF 已添加，可点击文件名预览");
  }
  const citation = (id: string, label: string) => (
    <button className="rp-citation" onClick={() => showSource(id)}>
      <Icon name="link" size={13} />
      {label}
    </button>
  );

  return (
    <div
      className={`rp ${compact ? "rp-compact" : ""} ${expanded ? "rp-expanded" : ""}`}
    >
      <nav className="rp-rail" aria-label="主导航">
        <div className="rp-mark" aria-label="研习">
          <Icon name="book" size={22} />
        </div>
        <button
          className="rp-rail-active"
          aria-label="论文阅读工作台"
          title="论文阅读"
          onClick={() => {
            setTab("reading");
            setViewerOpen(true);
          }}
        >
          <Icon name="book" size={21} />
        </button>
        <button
          aria-label="查看阅读笔记"
          title="阅读笔记"
          onClick={() => {
            setTab("notes");
            setViewerOpen(true);
          }}
        >
          <Icon name="file" size={21} />
        </button>
        <div className="rp-rail-spacer" />
        <button
          ref={settingsRef}
          aria-label="阅读设置"
          title="阅读设置"
          onClick={() => setSettingsOpen(true)}
        >
          <Icon name="settings" size={21} />
        </button>
        <div className="rp-avatar" title="医学科研初学者">
          医
        </div>
      </nav>

      {sidebarOpen && (
        <button
          className="rp-nav-backdrop"
          aria-label="关闭任务导航"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        className={`rp-sidebar ${sidebarOpen ? "rp-sidebar-open" : ""}`}
        aria-label="课题与任务"
        inert={narrow && !sidebarOpen}
      >
        <header className="rp-sidebar-brand">
          <div>
            <strong>
              研习<span> / </span>
            </strong>
            <small>医学科研，从读懂开始</small>
          </div>
          <button
            className="rp-mobile-close rp-icon-button"
            aria-label="关闭导航"
            onClick={() => setSidebarOpen(false)}
          >
            <Icon name="close" />
          </button>
        </header>
        <button className="rp-new-task" onClick={newTask}>
          <Icon name="plus" />
          新建阅读任务<span>＋</span>
        </button>
        <label className="rp-search">
          <Icon name="search" size={15} />
          <input
            aria-label="搜索阅读任务"
            placeholder="搜索任务"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <kbd>⌕</kbd>
        </label>
        <div className="rp-sidebar-scroll">
          <div className="rp-section-label">
            我的课题<span>01</span>
          </div>
          <div className="rp-project">
            <span className="rp-project-dot" />
            <span>细胞衰老与身体功能</span>
            <Icon name="chevron" size={13} />
          </div>
          <div className="rp-task-list">
            {tasks
              .filter((item) => item.title.includes(search))
              .map((item) => (
                <button
                  key={item.id}
                  className={`rp-task ${item.id === taskId ? "rp-task-active" : ""}`}
                  aria-current={item.id === taskId ? "page" : undefined}
                  onClick={() => selectTask(item)}
                >
                  <Icon name="chat" size={15} />
                  <span>{item.title}</span>
                  {item.id === taskId && <span className="rp-task-dot" />}
                </button>
              ))}
            {tasks.every((item) => !item.title.includes(search)) && (
              <p className="rp-search-empty">没有找到相关任务</p>
            )}
          </div>
          <div className="rp-section-label rp-materials-label">
            阅读材料<span>{upload ? "02" : "01"}</span>
          </div>
          <button
            className="rp-material"
            onClick={() => showSource("xu-question")}
          >
            <span className="rp-pdf-symbol">PDF</span>
            <span>
              <strong>Xu et al. · 2018</strong>
              <small>Nature Medicine · 内置示例</small>
            </span>
            <Icon name="chevron" size={13} />
          </button>
          {upload && (
            <button className="rp-material" onClick={() => setPdfOpen(true)}>
              <span className="rp-pdf-symbol">PDF</span>
              <span>
                <strong>{upload.name}</strong>
                <small>
                  本次添加 · {(upload.size / 1024 / 1024).toFixed(1)} MB
                </small>
              </span>
            </button>
          )}
          <button
            className="rp-add-material"
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="plus" size={15} />
            添加论文
          </button>
        </div>
        <footer className="rp-sidebar-footer">
          <span className="rp-small-orb">
            <Icon name="spark" size={16} />
          </span>
          <div>
            <strong>从一个问题开始</strong>
            <p>不熟悉的方法，可以随时追问。</p>
          </div>
        </footer>
      </aside>

      <main className="rp-workspace">
        <header className="rp-topbar">
          <button
            className="rp-mobile-menu rp-icon-button"
            aria-label="打开任务导航"
            onClick={() => setSidebarOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <div className="rp-breadcrumb">
            <span>细胞衰老</span>
            <Icon name="chevron" size={12} />
            <strong>{task.title}</strong>
          </div>
          <span className="rp-preview-label">
            <i />
            交互预览
          </span>
          <button
            className="rp-mobile-settings rp-icon-button"
            aria-label="阅读设置"
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="settings" size={16} />
          </button>
          <button
            className="rp-icon-button"
            aria-label={viewerOpen ? "收起成果面板" : "打开成果面板"}
            title={viewerOpen ? "收起成果" : "打开成果"}
            aria-expanded={viewerOpen}
            onClick={() => setViewerOpen((value) => !value)}
          >
            <Icon name="panel" />
          </button>
        </header>
        <div className={`rp-workarea ${viewerOpen ? "rp-with-viewer" : ""}`}>
          <section className="rp-chat" aria-label="论文阅读讨论">
            <div className="rp-chat-header">
              <div>
                <span className="rp-eyebrow">PAPER READING</span>
                <h1>{task.title}</h1>
                <p>
                  Xu et al. <span>·</span> Nature Medicine, 2018
                </p>
              </div>
              <span className="rp-level">科研入门</span>
            </div>
            <div className="rp-messages" role="log" aria-label="阅读对话">
              {task.messages.length === 0 && (
                <div className="rp-welcome">
                  <span className="rp-welcome-icon">
                    <Icon name="book" size={28} />
                  </span>
                  <h2>先选一个你想弄懂的问题</h2>
                  <p>可以从研究目的开始，也可以直接看方法或图表。</p>
                  {(Object.keys(topics) as Topic[]).map((key) => (
                    <button
                      key={key}
                      onClick={() => ask(topics[key].question, key)}
                    >
                      <Icon
                        name={
                          key === "question"
                            ? "search"
                            : key === "control"
                              ? "file"
                              : "panel"
                        }
                      />
                      <span>{topics[key].question}</span>
                      <Icon name="chevron" size={15} />
                    </button>
                  ))}
                </div>
              )}
              {task.messages.map((message) =>
                message.role === "user" ? (
                  <div key={message.id} className="rp-user-message">
                    <div>{message.text}</div>
                    <span>你</span>
                  </div>
                ) : (
                  <article className="rp-assistant-message" key={message.id}>
                    <div className="rp-assistant-heading">
                      <span className="rp-assistant-orb">
                        <Icon name="spark" size={17} />
                      </span>
                      <strong>研习助手</strong>
                      <small>示例解读</small>
                    </div>
                    <div className="rp-answer">
                      {message.text ? (
                        <p>{message.text}</p>
                      ) : (
                        <>
                          <p>
                            {message.topic === "question"
                              ? "可以。我们先抓住研究问题，再看作者怎样用实验回答它。"
                              : message.topic === "control"
                                ? "把两种对照分开看，会更容易理解这个实验。"
                                : "读 Figure 1 时，先看实验设计，再看具体的功能指标。"}
                          </p>
                          <h2>
                            {message.topic === "question"
                              ? "先记住这一个问题"
                              : message.topic === "control"
                                ? "两种对照，各排除什么？"
                                : "按这三步读图"}
                          </h2>
                          <div className="rp-takeaway">
                            <span className="rp-takeaway-bar" />
                            <p>{topics[message.topic].summary}</p>
                          </div>
                          {message.topic === "question" ? (
                            <>
                              <p>
                                只观察到“老年组织里衰老细胞更多”，还不能说明谁影响了谁。作者进一步向年轻小鼠移植不同状态的细胞，再比较身体功能。
                              </p>
                              <div className="rp-reasoning">
                                <span>改变细胞状态</span>
                                <Icon name="chevron" size={13} />
                                <span>测量身体功能</span>
                                <Icon name="chevron" size={13} />
                                <span>比较组间差异</span>
                              </div>
                            </>
                          ) : message.topic === "control" ? (
                            <div className="rp-mini-table">
                              <div>
                                <strong>非衰老细胞组</strong>
                                <span>
                                  帮助判断差异是否与细胞的衰老状态有关。
                                </span>
                              </div>
                              <div>
                                <strong>PBS 注射组</strong>
                                <span>帮助区分注射、移植过程本身的影响。</span>
                              </div>
                            </div>
                          ) : (
                            <ol className="rp-steps">
                              <li>
                                <strong>认比较组</strong>
                                <span>衰老细胞、非衰老细胞、PBS 对照。</span>
                              </li>
                              <li>
                                <strong>认测量指标</strong>
                                <span>步行速度、悬挂耐力、握力等。</span>
                              </li>
                              <li>
                                <strong>核对结论范围</strong>
                                <span>
                                  部分指标下降，不代表所有功能都下降。
                                </span>
                              </li>
                            </ol>
                          )}
                          <div className="rp-answer-bottom">
                            {citation(
                              topics[message.topic].source,
                              message.topic === "figure"
                                ? "Figure 1 图注"
                                : "查看论文依据",
                            )}
                            <button
                              className="rp-text-button"
                              onClick={() => {
                                setTab("reading");
                                setViewerOpen(true);
                              }}
                            >
                              <Icon name="panel" size={14} />
                              打开完整解读
                            </button>
                          </div>
                          <p className="rp-answer-next">
                            {message.topic === "question"
                              ? "接下来，可以看看为什么需要两种对照。"
                              : message.topic === "control"
                                ? "带着这个比较关系，再去看 Figure 1 的结果。"
                                : "读每个小图时，都可以问：这个比较支持了哪一句结论？"}
                          </p>
                        </>
                      )}
                    </div>
                  </article>
                ),
              )}
              <div ref={messageEnd} />
            </div>
            <div className="rp-composer-area">
              <div className="rp-suggestions">
                <button onClick={() => ask("为什么需要两种对照？", "control")}>
                  为什么需要两种对照？
                </button>
                <button onClick={() => ask("带我读 Figure 1", "figure")}>
                  带我读 Figure 1
                </button>
                <button onClick={() => ask("请讲得更通俗一些", task.topic)}>
                  讲得更通俗
                </button>
              </div>
              <form
                className="rp-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  ask(question);
                }}
              >
                {upload && (
                  <div className="rp-attachment">
                    <button type="button" onClick={() => setPdfOpen(true)}>
                      <Icon name="file" size={14} />
                      <span>{upload.name}</span>
                    </button>
                    <button
                      type="button"
                      aria-label="移除上传论文"
                      onClick={() => setUpload(null)}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </div>
                )}
                <textarea
                  ref={questionRef}
                  aria-label="向科研助手提问"
                  rows={2}
                  placeholder="哪里没读懂？可以用自己的话问。"
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      ask(question);
                    }
                  }}
                />
                <div className="rp-composer-tools">
                  <button
                    type="button"
                    className="rp-icon-button"
                    aria-label="添加 PDF 论文"
                    title="添加 PDF 论文"
                    onClick={() => fileRef.current?.click()}
                  >
                    <Icon name="plus" size={20} />
                  </button>
                  <span>
                    <Icon name="book" size={13} />
                    论文阅读<span className="rp-composer-divider">·</span>
                    内置示例
                  </span>
                  <button
                    type="submit"
                    className="rp-send"
                    aria-label="发送问题"
                    disabled={!question.trim()}
                  >
                    <Icon name="arrow" size={18} />
                  </button>
                </div>
              </form>
              <p className="rp-composer-note">
                示例解读基于已登记的论文摘要与图注；添加的 PDF 可本地预览。
              </p>
            </div>
          </section>

          {viewerOpen && (
            <aside className="rp-viewer" aria-label="阅读成果面板">
              <header className="rp-viewer-header">
                <span>
                  <Icon name="file" size={16} />
                  <strong>阅读成果</strong>
                </span>
                <div>
                  <button
                    className="rp-icon-button"
                    aria-label={expanded ? "退出放大阅读" : "放大阅读成果"}
                    title={expanded ? "退出放大" : "放大阅读"}
                    onClick={() => setExpanded((value) => !value)}
                  >
                    <Icon name="expand" size={16} />
                  </button>
                  <button
                    className="rp-icon-button"
                    aria-label="关闭成果面板"
                    onClick={() => {
                      setViewerOpen(false);
                      setExpanded(false);
                    }}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
              </header>
              <div className="rp-tabs" role="tablist" aria-label="成果内容">
                {(
                  [
                    ["reading", "论文解读"],
                    ["sources", "原文依据"],
                    ["notes", "我的笔记"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    id={`rp-tab-${id}`}
                    role="tab"
                    aria-selected={tab === id}
                    aria-controls={`rp-panel-${id}`}
                    tabIndex={tab === id ? 0 : -1}
                    onClick={() => setTab(id)}
                    onKeyDown={(event) => {
                      const ids: Tab[] = ["reading", "sources", "notes"];
                      if (
                        event.key === "ArrowRight" ||
                        event.key === "ArrowLeft"
                      ) {
                        event.preventDefault();
                        const next =
                          ids[
                            (ids.indexOf(id) +
                              (event.key === "ArrowRight" ? 1 : 2)) %
                              3
                          ];
                        setTab(next);
                        document.getElementById(`rp-tab-${next}`)?.focus();
                      }
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div
                className="rp-viewer-body"
                role="tabpanel"
                id={`rp-panel-${tab}`}
                aria-labelledby={`rp-tab-${tab}`}
              >
                {tab === "reading" && (
                  <article className="rp-document">
                    <div className="rp-document-meta">
                      <span>阅读手记 / 01</span>
                      <span className="rp-example-tag">内置示例</span>
                    </div>
                    <h2>
                      衰老细胞如何
                      <br />
                      影响身体功能？
                    </h2>
                    <p className="rp-document-subtitle">
                      从研究问题，到实验与证据
                    </p>
                    <div className="rp-paper-reference">
                      <Icon name="book" size={16} />
                      <div>
                        <strong>Xu et al. · Nature Medicine</strong>
                        <span>2018 · DOI: {sample.doi}</span>
                      </div>
                    </div>
                    <div className="rp-document-divider" />
                    <section>
                      <div className="rp-section-heading">
                        <span>01</span>
                        <h3>研究在问什么</h3>
                      </div>
                      <p>
                        衰老细胞是否能引起身体功能下降？减少这类细胞，是否能改善老年小鼠的功能？
                      </p>
                      {citation("xu-question", "Abstract / Introduction")}
                    </section>
                    <section>
                      <div className="rp-section-heading">
                        <span>02</span>
                        <h3>作者怎样回答</h3>
                      </div>
                      <p>
                        主动改变年轻小鼠接受的细胞状态，再用不同对照区分影响来源。
                      </p>
                      <div className="rp-experiment">
                        <div>
                          <span className="rp-group-dot rp-group-blue" />
                          <strong>衰老细胞组</strong>
                          <span>观察目标因素的影响</span>
                        </div>
                        <div>
                          <span className="rp-group-dot rp-group-gray" />
                          <strong>非衰老细胞组</strong>
                          <span>比较不同细胞状态</span>
                        </div>
                        <div>
                          <span className="rp-group-dot rp-group-green" />
                          <strong>PBS 注射组</strong>
                          <span>比较注射与移植过程</span>
                        </div>
                      </div>
                      {citation("xu-design", "实验设计 · Figure 1a")}
                    </section>
                    <section>
                      <div className="rp-section-heading">
                        <span>03</span>
                        <h3>结果支持什么</h3>
                      </div>
                      <p>
                        论文报告衰老细胞移植组的部分身体功能指标下降，支持衰老细胞参与功能损伤的推断。
                      </p>
                      <div className="rp-insight">
                        <Icon name="search" size={16} />
                        <p>
                          <strong>读图时留意</strong>
                          步行速度、握力、耐力是不同指标。每个结论都要回到对应小图核对。
                        </p>
                      </div>
                      {citation("xu-fig1", "Figure 1d–j 图注")}
                    </section>
                    <section>
                      <div className="rp-section-heading">
                        <span>04</span>
                        <h3>结论的边界</h3>
                      </div>
                      <p>
                        小鼠实验、人体离体组织实验和人体临床试验属于不同的证据层级。本研究中的小鼠结果不能直接证明人类治疗获益。
                      </p>
                      {citation("xu-fig6", "Figure 6 与结果范围")}
                    </section>
                    <details className="rp-term">
                      <summary>
                        术语小卡：什么是对照？
                        <Icon name="plus" size={14} />
                      </summary>
                      <p>
                        对照提供比较基准，帮助判断观察到的差异来自目标因素，还是其他实验步骤。不同对照可以排除不同解释。
                      </p>
                    </details>
                    <p className="rp-source-scope">
                      本页使用项目已登记的局部中文证据摘要。来源页提供定位与原文链接。
                    </p>
                  </article>
                )}
                {tab === "sources" && (
                  <div className="rp-sources">
                    <div className="rp-document-meta">
                      <span>回到证据</span>
                      <span className="rp-example-tag">中文证据摘要</span>
                    </div>
                    <h2>这句话的依据在哪里？</h2>
                    <p className="rp-source-intro">
                      核对研究问题、比较组和结论范围。
                    </p>
                    {sources.map((source, index) => (
                      <section
                        key={source.id}
                        ref={(element) => {
                          sourceRefs.current[source.id] = element;
                        }}
                        className={`rp-source-card ${activeSource === source.id ? "rp-source-active" : ""}`}
                      >
                        <div>
                          <span className="rp-source-number">0{index + 1}</span>
                          <h3>{source.title}</h3>
                        </div>
                        <small>{source.locator}</small>
                        <p>{source.text}</p>
                        <a href={source.url} target="_blank" rel="noreferrer">
                          打开对应原文
                          <Icon name="link" size={13} />
                        </a>
                      </section>
                    ))}
                  </div>
                )}
                {tab === "notes" && (
                  <div className="rp-notes">
                    <div className="rp-document-meta">
                      <span>我的阅读记录</span>
                      <span>{noteSaved ? "已保存" : "尚未保存"}</span>
                    </div>
                    <h2>用自己的话，记下来</h2>
                    <p>写下你的理解，也可以先记一个还没弄懂的问题。</p>
                    <div className="rp-note-prompts">
                      <button
                        onClick={() => {
                          setNotes(
                            (value) =>
                              value +
                              `${value ? "\n\n" : ""}研究问题：${topic.summary}\n我的理解：`,
                          );
                          setNoteSaved(false);
                        }}
                      >
                        ＋ 记下研究问题
                      </button>
                      <button
                        onClick={() => {
                          setNotes(
                            (value) =>
                              value +
                              `${value ? "\n\n" : ""}还没弄懂：为什么需要两种对照？\n`,
                          );
                          setNoteSaved(false);
                        }}
                      >
                        ＋ 留一个待解决问题
                      </button>
                    </div>
                    <textarea
                      aria-label="我的论文阅读笔记"
                      value={notes}
                      onChange={(event) => {
                        setNotes(event.target.value);
                        setNoteSaved(false);
                      }}
                      placeholder="这篇研究在问……\n作者用……来比较……\n我还想弄懂……"
                    />
                    <div className="rp-note-actions">
                      <button onClick={exportNotes}>导出 Markdown</button>
                      <button className="rp-primary" onClick={saveNotes}>
                        保存笔记
                      </button>
                    </div>
                    <small>笔记保存在当前浏览器，保存后刷新可继续阅读。</small>
                  </div>
                )}
              </div>
              <footer className="rp-viewer-footer">
                <span>
                  <Icon name="check" size={13} />
                  {tab === "notes" ? "个人阅读笔记" : "4 条论文依据"}
                </span>
                <button
                  onClick={() => {
                    setTab(tab === "notes" ? "reading" : "notes");
                  }}
                >
                  {tab === "notes" ? "返回解读" : "写下我的理解"}
                  <Icon name="chevron" size={12} />
                </button>
              </footer>
            </aside>
          )}
        </div>
      </main>
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,.pdf"
        onChange={uploadFile}
        hidden
      />
      <div className="rp-toast" role="status" aria-live="polite">
        {toast && (
          <span>
            <Icon name="check" size={16} />
            {toast}
          </span>
        )}
      </div>
      <dialog
        ref={dialogRef}
        className="rp-settings"
        onCancel={() => setSettingsOpen(false)}
        onClose={() => {
          setSettingsOpen(false);
          settingsRef.current?.focus();
        }}
      >
        <div className="rp-modal-heading">
          <h2>阅读设置</h2>
          <button
            className="rp-icon-button"
            aria-label="关闭阅读设置"
            onClick={() => setSettingsOpen(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        <p>选择适合你的内容间距。</p>
        <div className="rp-density">
          <button aria-pressed={!compact} onClick={() => setCompact(false)}>
            舒适阅读<small>留白更多，逐段理解</small>
          </button>
          <button aria-pressed={compact} onClick={() => setCompact(true)}>
            紧凑阅读<small>同屏查看更多内容</small>
          </button>
        </div>
      </dialog>
      <dialog
        ref={pdfDialogRef}
        className="rp-pdf-preview"
        aria-label="上传论文预览"
        onCancel={() => setPdfOpen(false)}
        onClose={() => {
          setPdfOpen(false);
          questionRef.current?.focus();
        }}
      >
        {upload && (
          <>
            <header>
              <div>
                <strong>{upload.name}</strong>
                <small>本地 PDF 预览 · 示例解读仍对应 Xu 2018</small>
              </div>
              <button
                className="rp-icon-button"
                autoFocus
                aria-label="关闭 PDF 预览"
                onClick={() => setPdfOpen(false)}
              >
                <Icon name="close" />
              </button>
            </header>
            <iframe src={upload.url} title={upload.name} />
            <a href={upload.url} target="_blank" rel="noreferrer">
              在新窗口打开 PDF
            </a>
          </>
        )}
      </dialog>
    </div>
  );
}
