# Med Research Mentor architecture

## Product model

The application has three connected workstreams:

1. **Paper guide** turns a PDF into a paced learning conversation. It keeps the paper's order, expands important figures and methods, and links explanations back to source ranges.
2. **Journal-club deck** turns the same evidence model into a visual presentation and a separate speaking guide. Source figures remain traceable to the paper.
3. **Research-plan draft** turns a question and constraints into a discussion-ready proposal while marking unknowns instead of inventing parameters.

The workstreams share source ranges, paper metadata, user intent, and review feedback. A reading question can improve a deck or plan; a plan constraint can focus the next reading step.

## Three-agent loop

- **Mentor agent** explains, structures, and drafts. It adapts depth to the learner and keeps the next action visible.
- **Novice/source agent** simulates a beginner reading the result and checks whether claims, figures, methods, and source ranges are understandable and grounded.
- **Revision/verification agent** repairs the highest-impact gaps, checks evidence bindings and output contracts, and returns a publishable result with unresolved uncertainty stated plainly.

The scheduler chooses the smallest useful set of roles for each task. Internal review can be stricter than the user-facing delivery gate: major factual, evidence, privacy, or structural errors block delivery; minor wording or formatting issues may be left for later refinement.

## Runtime boundaries

The browser talks to the local Express server. The server owns storage, PDF extraction, figure assets, model calls, exports, and orchestration. Model credentials are read only from process environment variables. The browser never receives provider keys.

The repository publishes reusable source and Skill instructions. It does not publish user data, real papers, generated exports, evaluation ledgers, or provider credentials.
