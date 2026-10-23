---
name: "model-probe"
description: "给 DSH 里配置的模型做「可用性 + 客观题」两层探针：ping 量成功率和延迟，单字母多选题量客观正确率，精确匹配判分、不用 LLM 当裁判。用户说测一下模型、跑个探针、比较延迟/稳定性/正确率、换模型前评估时加载。"
whenToUse: "新增 provider/模型要先验；怀疑某条线路在掉；要对比几个模型的延迟与正确率；要给团队/帖子出一份可复现的模型体检报告时。"
---

# model-probe · 便宜且客观的模型探针

## 为什么这么设计

大多数"评测"要么贵（LLM 当裁判）、要么不可复现（主观打分）。这里只用两条**零判断成本**的信号：

| 层 | 测什么 | 成本 | 判据 |
|---|---|---|---|
| **L1 ping** | 通不通、多快 | ~24 token/次 | HTTP 成功 + 首字节延迟 |
| **L2 客观题** | 会不会 | ~100–200 token/题 | 单字母精确匹配，错了就是错了 |

判分不需要第二个模型，**换机器跑结果一致**。

## 用法

```bash
# 全量（读 DSH profile 里所有 provider/model + 凭据）
node probe.mjs --ping 3 --quiz 20

# 只测几个
node probe.mjs --ping 2 --quiz 10 --models gpt-6.1-sol,glm-5.3-flash

# 看解析出来的目标（不发请求）
node probe.mjs --list

# 自定义目标（脱离 DSH 用）
node probe.mjs --config my-targets.json
```

`my-targets.json` 结构：

```json
{ "targets": [
  { "provider": "relay", "api": "openai-completions", "baseURL": "https://x/v1", "apiKeyEnv": "X_KEY", "model": "gpt-x" },
  { "provider": "claude", "api": "anthropic-messages", "baseURL": "https://x", "apiKeyEnv": "Y_KEY", "model": "claude-y" }
] }
```

输出 `report.json`，含每个目标的 ping 成功率、中位延迟、正确率、消耗 token、错题清单。

## 三条硬注意事项

### 1. 推理模型必须给足 `max_tokens`

这是最容易踩的坑：`max_tokens: 8` 时，推理模型把 8 个 token 全花在思考上，**正文是空的** → 被判错 → 假阴性（实测 kimi-k3 从 1/8 变成 6/8，就因为改成 96）。

脚本现在会先取 `message.content`，空则退回 `reasoning_content`。

### 2. 题量决定信噪比

- **8 题**：只够发现"明显坏了"（差距 > 25%）
- **20 题**：能看 10% 级差异，但**不能用来排名**
- 想排 5% 级差异需要 > 200 题，那就不便宜了

**不要**把 8 题的结果写成"模型 A 比 B 强"。

### 3. 免费额度会骗你

实测 HKBU 的 `gpt-6-astra` 是 **每天 3 条**（`429 · Your 3 daily GPT-6 Astra prompts have been used`）。跑探针会瞬间烧光当日额度，且失败长得像"网络问题"。

跑之前先 `--list` 确认目标，对免费模型 `--quiz 3 --ping 1`。

## 题库

`questions.json`：20 道单选，覆盖算术、代数、逻辑、计数、进制、JS/Python/SQL/正则/Git、复杂度、概率、位运算、递归、语义歧义。

- 全部**答案唯一、无时效性**（不考"最新版本""今天价格"这类会过期的东西）
- 每题要求"只回答一个字母"，同时顺带测了**指令遵循**
- 判分：取响应里第一个独立的 A/B/C/D；空或越界算错

加题就改这个文件，`{"id","prompt","answer"}` 三元组，别考有争议的题。

## 怎么读结果

| 现象 | 结论 |
|---|---|
| ping < 100% 且错误是 429 | 配额/限流，不是模型差 |
| ping 100% 但延迟 > 10s | 能用但别做交互 |
| ping 100% 但正确率 < 60% | 模型被降级/截断，或 max_tokens 不够 |
| 正确率高但延迟高 | 适合批处理，不适合聊天 |

## 和其他评测的关系

- 别人（如 Artificial Analysis）的 Intelligence Index 是**大样本 + 多基准加权**，适合看整体水平；
- 本探针只做**线路体检**：这条 key 通不通、这个模型有没有被降级、大概什么水平；
- 两者不冲突，**但别把探针分数当作模型排名**。
