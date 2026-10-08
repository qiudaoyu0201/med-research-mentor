# 医学科研导师

面向医学科研初学者的本地桌面网页：以论文带读为主，提供独立的论文 PPT 和研究方案生成专区。React 19／Vite 前端、Express 5／TypeScript 后端，本地保存论文、讨论、阅读进度和生成记录。

## 当前版本（2026-10-09）

以[需求访谈基线](docs/医学科研导师_需求访谈基线_2026-10-09.md)、[优化实施方案](docs/医学科研导师_优化实施方案_2026-10-09.md)和[54 项需求落实清单](docs/医学科研导师_需求落实清单_2026-10-09.md)为准。旧方案、产物与训练账本继续保留；旧文档中的笔记入口、在线 PPT 编辑和默认长讲稿不代表当前首页。

原来的三类 Agent 保留：导师生成 → 模拟小白试读与来源校验 → 汇总理解断点和证据问题 → 导师有界修订 → 小白复读与来源复核。它们共用同一学习目标和实际材料；关键问题未解决不能推进阅读。产品主流程按任务启用必要角色，内部迭代可完整运行闭环，不把每次点击都变成六次模型调用。

本轮加入清晰 Markdown 排版、回答选句追问、按需原文中英对照、当前／下一步阅读范围、新论文默认偏好、轻量术语记忆和有界文献补查。PPT 与研究方案集中在独立生成专区，下载后自行修改；讲述提示与 PPT 分开，讲稿不写入幻灯片及备注。首页默认空白，用户选定历史论文才恢复。笔记不再作为新功能入口，保留历史数据兼容。

工程检查 249 项通过；真实带读、翻译、研究方案和 6 页 PPT 已运行。PPT 经 PowerPoint 逐页渲染，参赛设计说明经 Word 渲染。实测仍发现观察性研究时间顺序和术语译法问题，最后一批迭代有一次传输中断状态未知，均记录在[迭代报告](docs/导师迭代_2026-10-09.md)。工程通过不代表所有论文、真人教学效果或国内模型已验证。

## 启动与中转

需要 Node.js 22.13 或更新版本。本机已验证 klapi 中转，使用中转 API 额度，**不要求原生 Codex 订阅有额度**；此路径仍复用本机 Codex CLI。独立兼容 API 适配器也已存在，目标服务需另验。

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
npm.cmd ci
npm.cmd run dev:relay
```

通常访问 <http://127.0.0.1:4317/>；终端显示实际端口。中转入口显式使用本机已有配置，不复制密钥，不静默切换模型。普通 `npm run dev` 和旧双击启动入口保留原生默认；详见[中转运行说明](docs/中转运行说明.md)。生产启动先 `npm.cmd run build`，再 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-configured.ps1 -Production`。

## 怎样使用

1. **论文带读：** 导入 PDF，从背景、研究问题和意义起步，再沿论文展开。可以随时说“详细一点”、引用回答中的一句追问或要求继续。练习可选，不以点击继续判断掌握。
2. **对照原文：** 从回答附近的来源入口看 PDF／图件，需要时翻译对应原文段落。翻译按需触发、保存与复用；复杂版式和扫描 PDF 仍有提取限制。
3. **设置：** 当前聊天可调整讲解程度和重点；新论文默认设置单独保存。通用详细程度要求后续沿用，局部选句追问只影响当前问题。
4. **PPT 汇报：** 选择或导入论文，选填页数和要求，生成后预览并分别下载 PPTX 与简洁讲述提示。不要求先完成带读，不提供复杂在线编辑器。
5. **研究方案：** 填研究问题，按需补研究条件、自由建议和参考论文；生成可与老师讨论的完整草案，下载 Word／Markdown。未知参数保持未知。

[参赛准备文件](交付/参赛准备_2026-10-09/)包含设计说明 Word／PDF、演示脚本与支撑材料清单；真实视频和报名仍待完成。国内模型适配列入后续验收，尚未宣称完成。

## 验证

```powershell
npm.cmd run check  # 类型、生产构建和自动测试
```

浏览器验证需先启动独立服务，使用独立数据目录，避免测试记录加入个人论文库；`TUTOR_READING_GUIDES=manual` 关闭自动整理调用。当前脚本使用本机安装的 Microsoft Edge。

```powershell
$env:TUTOR_DATA_DIR = 'D:\智能体\runs\validation-data'
$env:TUTOR_READING_GUIDES = 'manual'
$env:PORT = '4334'
npm.cmd start
```

以下为旧版浏览器检查脚本，部分仍依赖旧笔记和在线编辑入口，不能直接作为新版界面验收；新版实际走查见需求落实清单。需要复查历史行为时可配置：

```powershell
$env:TUTOR_BASE_URL = 'http://127.0.0.1:4334'
npx tsx checks/browser-core-generation.ts
npx tsx checks/browser-research-plan.ts
npx tsx checks/browser-reading-focus.ts
npx tsx checks/browser-ppt-reading-notes.ts
npx tsx checks/browser-stability.ts
npx tsx checks/browser-short-loop.ts
npx tsx checks/browser-workflow-v16.ts
```

这些检查覆盖入口、固定响应流程和真实本地 API，不证明新模型内容有效。完整十组与实际 PPTX 渲染证据见[产品收尾验收](docs/产品收尾_配图裁剪与日常错误验收.md#工程验证)。此前产品收尾的真实模型脚本为 `scripts/product-acceptance.ts`；历史脚本还有 `scripts/workspace-live-check.ts`、`scripts/second-round-check.ts`、`scripts/research-plan-check.ts`。执行前查调用上限，不能把它们当零调用回归。

已有真实样本及分轮实现见[核心生成验收](docs/核心生成流程与完整演讲稿_实施验收.md)、[方案阶段验收](docs/科研能力培养第二轮_研究方案实施验收.md)。原真实产物保存在 `runs/core-generation/live/`，产品收尾独立探针与渲染在 `runs/full-audit-20261007/`，均为本机忽略目录。

## 模型和数据

默认实时推理使用本机已有的 Codex ChatGPT 登录。程序支持显式配置 HTTPS Chat Completions 兼容提供方：

| 环境变量                                                       | 用途                                             |
| -------------------------------------------------------------- | ------------------------------------------------ |
| `TUTOR_PROVIDER=compatible`                                    | 显式选择兼容接口                                 |
| `TUTOR_MODEL_BASE_URL`                                         | HTTPS 基础地址，含实际 `/v1` 等前缀              |
| `TUTOR_MODEL`、`TUTOR_MODEL_API_KEY`                           | 型号和服务端凭据                                 |
| `TUTOR_MODEL_IMAGES=true`                                      | 显式声明所选型号可用图像输入                     |
| `TUTOR_MODEL_OUTPUT_MODE`                                      | 默认 `json_object`；确认支持后可选 `json_schema` |
| `TUTOR_MODEL_MAX_INPUT_CHARS`、`TUTOR_MODEL_MAX_OUTPUT_TOKENS` | 输入／输出额度                                   |

程序读取进程环境，不自动加载 `.env`；重启生效。凭据不进入前端、Git 和普通日志。配置存在不等于目标模型已验收，失败不会静默换模型。`npm.cmd run model:check` 读取配置／登录及目录；加 `-- --generate` 才发起实际短文本请求。文本、图像、结构与取消能力须按目标型号单独实测。

本地界面不等于离线推理：实时材料会发送给所选模型服务。文件和记录保存在 `data/` 或 `TUTOR_DATA_DIR`，导出在 `exports/`，检查产物在 `runs/`，这些目录不提交 Git。服务只监听 127.0.0.1，并检查 Host／Origin。运行时模型没有任意 shell、网页、MCP 或应用工具权限。

示例使用本机 Xu 2018 PDF；缺该文件时回到标明范围的局部中文摘要。新任务优先采用定位好的图件，旧版本原页绑定保留。普通 PDF 也提供图注／绘图几何可定位的图件，无法定位时保留原 PDF 和手动裁剪。历史 Figure 1m 分母依据不足、早期汇报内容验收失败和真人效果未验继续保留。

### 保存与以后部署

已保存的论文、笔记、聊天、PPT／方案版本保存在服务端 `data/` 或 `TUTOR_DATA_DIR`；导出文件在 `exports/`。浏览器未保存草稿、偏好和选区属于当前浏览器，待发附件还使用 IndexedDB。需要保留已保存资料时备份数据目录与原 PDF／附件，导出文件另行备份；浏览器缓存不代替服务端备份。

当前为本机单用户服务，没有账号和用户数据隔离。若以后多人共用部署，需要账号、按用户隔离的记录／文件访问、持久化服务器存储与备份；已保存资料可登录后恢复，导出下载到各自设备。清浏览器缓存会丢未保存草稿。此处记录部署边界，本轮不新增账号后台。

## 文档怎么读

- [原三类 Agent 落地方案](docs/科研能力培养与三类Agent协作_整体落地方案.md)：有效范围、当前状态、剩余工作顺序和关闭条件。
- [累计要求与评价依据 v1.5](docs/用户使用质量与自主迭代_落地方案_v1.5.md)：累计约束、用户困难扫描、客观评价、模型限制、预算及停止条件。
- [历史执行细则 v1.6](docs/真实使用流程与前后端磨合_落地方案_v1.6.md)：真实小白流程、带读进度、汇报／稿、课题检索与 DOCX、桌面取舍、前后端合同及产品内部三角色配合。
- [历史整体复查](docs/科研能力培养与三类Agent协作_整体复查与优化记录.md)：完成度／效果评价、复现问题、代码和运行证据。
- [分轮核心生成验收](docs/核心生成流程与完整演讲稿_实施验收.md)：已实现操作及各轮实际检查。
- [v2.5 内部规格归档](docs/科研能力培养与三类Agent协作_整体落地方案_v2.5归档.md)：详细内部合同、历史 F／T 编号及设计来源。旧范围、旧状态和旧导出规则不再作为当前执行依据。
- [参考来源与复用记录](docs/参考来源与复用记录.md)：历史来源、复用和限制。

此前阶段内部入口为 `npm.cmd run training:workflow -- status|admit|run 冻结任务.json|checkpoint 复核.json|pause`，同账本扩展和运行证据见[v1.6 实施验收](docs/真实使用流程_v1.6_实施验收.md)。旧入口不能在扩展后派发新调用；旧未知记录和费用原样保留，已运行样本不自动重发。候选发布仍需正式冻结比较和留出，用户继续使用三个核心入口。

本轮内部迭代使用 `node --import tsx scripts/mentor-iteration.ts status` 只读查看已执行记录；真实派发遵守冻结合同和累计上限，不自动重试 unknown。详情见本轮迭代报告。
