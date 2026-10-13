# 安装与模型配置

安装 Node.js 22.13+，克隆仓库并进入目录，执行 `npm ci`。Windows 可使用 `npm.cmd`。

## 独立兼容 API

复制 `.env.example` 到 `.env`，填写 HTTPS 基础地址、模型和密钥。支持 Chat Completions 及结构化 JSON 输出。图像输入须由目标模型支持，再开启 `TUTOR_MODEL_IMAGES=true`。

```powershell
node --env-file=.env --import tsx server/index.ts
```

程序本身不自动读取 `.env`，上面的 Node 参数负责加载。生产运行先 `npm.cmd run build`，再在启动命令末尾加 `--production`。此路径不需要 Codex CLI 或原生订阅额度，计费由所选提供方决定。

## Codex CLI

默认 `npm.cmd run dev` 使用已安装并登录的 Codex CLI。CLI 不在 PATH 时设置 `CODEX_BIN`。若使用 CLI 已配置的 API 提供方，须显式指定 `TUTOR_PROVIDER=codex-configured`、`TUTOR_CODEX_PROVIDER`、`TUTOR_MODEL` 和 `TUTOR_CODEX_AUTH=apiKey`。不同路径不自动互相回退。

## 检查与访问

默认地址 http://127.0.0.1:4317/ ，以终端实际输出为准。`npm.cmd run check` 执行类型、构建和测试。`npm.cmd run model:check` 检查进程配置；加载 .env 时可用 `node --env-file=.env --import tsx scripts/model-check.ts`。只有显式加 `--generate` 才进行该诊断的模型生成请求。

数据目录可通过 `TUTOR_DATA_DIR` 指定。备份本地数据与原论文，导出文件另存。不要将此单用户服务直接作为多用户公网服务部署。

## 慢模型与等待时间

在线带读及局部修订允许等待首段正文 5 分钟，输出中断后允许等待 5 分钟；单次模型请求最多 15 分钟，整轮任务最多 45 分钟。完整 PPT 和研究方案允许首段及中途等待 10 分钟、单次请求 20 分钟，整轮上限随产物大小增加，最多 90 分钟。这些是保护上限，不是固定等待时间；生成完成后立即交付，用户可随时取消。

持续新增正文会重新计时空闲等待，但不会延长单次或整轮上限。连接确认、Token 统计及重复空白不算正文进展。超时不会自动重发已经有部分输出的请求；审核与调用次数预算不因延长等待而放宽。修改时限后需重启服务，新请求才使用新配置。

内部实验使用独立的时限，默认值保持不变。实验脚本可按目标设置自己的 `budget.timing` 和总期限；速度用于评估和优化 Skill，不将内部速度目标直接用作在线中断条件。

## Windows 双击启动

运行 `启动导师.cmd`，脚本会检查 Node 版本、在依赖缺失时安装依赖，并重新构建当前源码。若项目目录存在 `.env`，启动时自动加载；否则使用默认 Codex CLI 路径。更新源码后先停止旧服务再启动，避免仍访问旧进程。首次启动没有个人论文、聊天或生成成果，仅提供内置的局部论文摘要示例。
