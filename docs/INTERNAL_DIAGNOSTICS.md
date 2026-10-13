# 独立模型诊断

此入口用于已停止历史周期之后的小批内部检查。它不恢复旧 workflow、不修改旧账本，不把诊断通过当作候选发布或真人学习效果证据。产物、论文与原始回答只保存在被 Git 忽略的 runs/internal-training/model-diagnostics 中。

在正常配置好提供方与认证后，显式选择 gpt-6.1-sol，运行：

```powershell
npm run training:diagnostic -- prepare 本地清单.json
npm run training:diagnostic -- run 实验ID
npm run training:diagnostic -- status 实验ID
npm run training:diagnostic -- pause 实验ID
```

prepare 不调用模型。每个实验最多八次调用，run 只接受从未开始的 prepared 实验；失败、取消、unknown 或已经结束的实验不能自动续跑。后续清单应通过 previousDiagnostic 绑定前批报告，继承累计尝试数；未用完的单批额度不抵消历史消耗。派发有全局锁与在线空闲准入。

清单固定 id、model、parentReport、paperPath、module、question、sourceIds、criteria、onlineUrl。可选 sharedAddition 只附加到本批冻结规则；structuredDelivery=json-string 是单字符串封装并按原 Schema 验证的内部试验，不补造字段、不修复坏 JSON、不改变在线通道。准备后不能改变冻结输入、规则或执行引擎；需要改动时创建新实验。

paper 和 ppt 使用真实导师、新手检查、来源核验及最多一次修订，再做独立评价；ppt 的独立评价也接收实际图件。调用成功、流程完成、新手通过或独立评价通过都不能单独代表总通过：必须同时满足严格开发验收和有效的独立评价。slideCount 支持 3–6 页。

research-plan 必须额外提供 plan：

```json
{
  "conditions": "初始实际资源和未知条件",
  "studyTypes": ["basic-translational"],
  "revision": {
    "conditions": "资源核实后的新条件",
    "instruction": "根据新条件修订，保留研究目标、正确解释和未知"
  }
}
```

方案最多绑定十二个可见来源。使用真实 ResearchPlans 服务执行初次生成与核验，再改变条件、修订与核验，最后独立评价两个版本；通常为四次产物调用和一次独立评价。任一阶段失败就停止，不自动补生成或重发。两版均需完成、核验绑定正确版本、历史版本完整保留；严格验收要求没有未解决核验问题。这里没有模拟新手复读，也没有新增文献搜索，不声称与带读有完全相同的教学覆盖。

本批的软目标只产生诊断事件；保护上限才取消请求。方案使用同一组临时内部时限，退出后恢复进程设置；不修改在线环境或默认门槛。成功耗时、被截断的观察下限与未知请求分别记录，不能混为正常速度样本。费用仅记录已知用量，无账单不估现金金额。
