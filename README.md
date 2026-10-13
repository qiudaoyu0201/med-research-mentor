# 医研导师 · Med Research Mentor

面向医学科研初学者的本地科研学习工作台。它把论文带读、医学论文汇报 PPT 和研究方案草案放在同一个工作流里，用三个协作 Agent 帮助用户从“看不懂论文”逐步走向“能解释证据、设计实验并和老师讨论”。

Med Research Mentor is a local-first research learning workbench for medical science beginners. It combines guided paper reading, journal-club slide generation, and research-plan drafting through a scheduler and three cooperating agents.

## 能做什么

- **论文带读**：按论文逻辑从背景、问题、方法、证据到结论逐步讲解；支持中英文术语、图表定位、原文对照、选句追问和当前/下一步阅读范围。
- **医学 PPT**：从论文生成适合组会或向导师汇报的幻灯片，绑定原文图件，独立生成讲述提示，支持 PPTX 导出。
- **研究方案**：从研究问题、已有线索、限制条件和参考论文生成可与导师讨论的方案草案，支持 DOCX 和 Markdown 导出。
- **协作闭环**：导师 Agent 负责教学与生成，新手模拟 Agent 暴露理解断点，来源核验 Agent 检查证据；导师根据两者反馈修订，再由新手和核验角色复验。
- **11 个模块化 Skill + 共享规则**：学习主助手、论文带读、证据链、方法讲解、图表教学、术语解释、PPT 汇报、来源核验，以及两类新手模拟模块按任务组合。Skill 不与 Agent 一一对应；研究方案 Skill 已接入后端生成与核验流程，并参与跨功能闭环。

## 架构

前端是 React/Vite，后端是 Express/TypeScript。调度器根据任务启用必要的 Agent 和 Skill，并让三条主线共享论文证据、用户关注点和反馈。系统默认按需调用角色，避免每个操作都产生完整多 Agent 链路。

```text
用户 / PDF / 研究想法
          │
          ▼
      调度器 Scheduler
       ┌────┼────┐
       ▼    ▼    ▼
    导师    新手    来源核验
       └────┼────┘
            ▼
  带读 / PPT / 研究方案
            │
            ▼
    证据、反馈与下一步
```

更完整的公开架构说明见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 快速开始

要求 Node.js 22.13 或更新版本。

```powershell
npm.cmd ci
npm.cmd run dev
```

然后打开 <http://127.0.0.1:4317/>。首次启动时论文库为空，从左侧导入自己的 PDF 即可开始。生产构建：

```powershell
npm.cmd run check
npm.cmd run build
npm.cmd start
```

程序默认使用本机已配置的模型运行时，也支持兼容 Chat Completions 服务。默认路径需要安装并登录 Codex CLI；独立兼容 API 路径不依赖 Codex 订阅。程序不会自动加载 `.env`。可复制 `.env.example` 为 `.env`，填写本地配置，然后运行 `node --env-file=.env --import tsx server/index.ts`。生产启动追加 `--production`，并先运行构建。图表理解应选择支持图像输入的模型并设置 `TUTOR_MODEL_IMAGES=true`。详细配置与模型检查见 [运行说明](docs/SETUP.md)。

## Skill 包

每个 Skill 都位于 `skills/<name>/`，包含 `SKILL.md` 和 `manifest.json`。Skill 描述输入、输出、证据要求和与调度器的关系；其中部分 Skill 依赖本项目的 TypeScript 服务和共享类型，不能被描述为脱离宿主即可独立运行。详见 [`SKILLS.md`](SKILLS.md)。

## 数据与隐私边界

论文、聊天、导出文件和运行数据保存在本机的 `data/`、`exports/` 或 `runs/` 目录，这些目录被 Git 忽略。实时模型调用会把当前任务所需材料发送给你选择的模型服务。仓库不包含真实论文、聊天记录、个人实验数据、API Key、Token 或 Cookie。

这是面向科研学习和方案讨论的工具，不替代医学诊疗、伦理审查或导师的专业判断。

## 开发检查

```powershell
npm.cmd run check
```

该命令执行 TypeScript 检查、Vite 生产构建和自动化测试。

内置论文摘录仅保留为开发测试素材，不会自动加入论文库。需要使用该素材的浏览器回归检查，可在启动服务前显式设置 `TUTOR_EXAMPLE_PAPER=true`。

## 许可证

本项目使用 [MIT License](LICENSE)。

## English summary

Med Research Mentor is a local-first medical research learning workbench. It guides beginners through papers, creates evidence-grounded journal-club slides, drafts research plans, and coordinates three specialized agents through reusable skills.

作者：秋刀鱼 / [qiudaoyu0201](https://github.com/qiudaoyu0201)。第三方字体和 PDF 样式保留各自许可证，见 [第三方说明](docs/THIRD_PARTY.md)。
