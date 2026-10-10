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
| `medical-research-assistant` | Draft a research proposal from a question, constraints, and references. |
| `medical-grounding-check` | Check source coverage, unsupported claims, and evidence bindings. |
| `medical-learner-simulation` / `medical-novice-simulator` | Simulate beginner questions and expose comprehension gaps. |

The modules are designed for this repository's scheduler and shared TypeScript contracts. A general AI host can reuse the instruction text, but full multi-agent orchestration, PDF handling, figure extraction, and exports require the main application.
