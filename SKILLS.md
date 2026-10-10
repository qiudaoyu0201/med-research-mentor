# Medical research Skill modules

These modules are the reusable instruction layer used by Med Research Mentor. Each directory contains:

- `SKILL.md`: role, workflow, evidence rules, and expected result shape;
- `manifest.json`: module name, version, and integration metadata.

## Modules

| Module | Responsibility |
| --- | --- |
| `medical-paper-guide` | Guide a beginner through a paper in a paced, source-linked sequence. |
| `medical-evidence-chain` | Keep claims, evidence, figures, and limitations connected. |
| `medical-figure-tutor` | Explain figures, axes, comparisons, statistics, and visual evidence. |
| `medical-method-tutor` | Explain study design, methods, controls, and experimental reasoning. |
| `medical-term-explainer` | Explain medical and research terminology with English/Chinese pairing. |
| `medical-journal-club-ppt` | Structure an evidence-grounded journal-club presentation and speaking guide. |
| `medical-research-assistant` | Route research learning goals into explanation, reading, figure and presentation workflows. |
| `medical-grounding-check` | Check source coverage, unsupported claims, and evidence bindings. |
| `medical-learner-simulation` / `medical-novice-simulator` | Simulate beginner questions and expose comprehension gaps. |

The modules are designed for this repository's scheduler and shared TypeScript contracts. A general AI host can reuse the instruction text, but full multi-agent orchestration, PDF handling, figure extraction, and exports require the main application.

## 单独复用与完整应用

下载仓库 ZIP 后可单独保留 `skills/`，同时保留共享 `skills/shared/rules.md`、本说明和 LICENSE。每个模块的 YAML 提供触发描述，manifest 提供依赖和版本；输出可能是 LearningUnit、AssistantPlan 或核验 JSON，需要宿主按对应合同处理。

`medical-research-assistant` 是学习任务路由与直接解释入口，不能等同于研究方案生成器。研究方案的输入、检索、生成、核验与导出由 `server/research-plans.ts` 等服务组织。完整三功能闭环需要应用调度器。

将 Skill 用于其他 AI 宿主时，提供论文材料、明确当前任务、加载共享规则及相关模块，再将结果交由核验角色检查。只复制提示词不会自动获得 PDF 解析、联网检索、文件导出、持久化或多 Agent 调度。
