# dsh-model-probe

给 **DeepSeek Harness（DSH）** 里配置的模型做一次"体检"：**通不通、多快、会不会**。

- 不需要第二个模型当裁判 → **可复现**
- 每次体检几千 token → **便宜**
- 精确匹配判分 → **客观**

## 两层探针

| 层 | 测什么 | 每次成本 | 判据 |
|---|---|---|---|
| L1 ping | 可用性 + 首字节延迟 | ~24 token | HTTP 成功 + 毫秒 |
| L2 客观题 | 基础能力 | ~100–200 token/题 | 单字母精确匹配 |

## 安装

这是一个 **DSH Skill**：把整个目录放进 DSH 的 skills 目录即可（例如 `$DSH_HOME/skills/`，或通过 profile 的 `skill-filesystem` 的 `customSkillDirs` 指向它）。

## 用法

```bash
# 读 DSH profile 里所有 provider/model（凭据取 $DSH_HOME/.credentials.yaml）
node probe.mjs --ping 3 --quiz 20

# 只测几个
node probe.mjs --ping 2 --quiz 10 --models gpt-6.1-sol,glm-5.3-flash

# 不发请求，只看解析出哪些目标
node probe.mjs --list

# 脱离 DSH：自带 targets.json
node probe.mjs --config my-targets.json --quiz 20
```

`my-targets.json`：

```json
{ "targets": [
  { "provider": "relay", "api": "openai-completions", "baseURL": "https://example.com/v1", "apiKeyEnv": "RELAY_KEY", "model": "gpt-x" },
  { "provider": "claude", "api": "anthropic-messages", "baseURL": "https://example.com", "apiKeyEnv": "CLAUDE_KEY", "model": "claude-y" }
] }
```

支持两种 API 形态：`openai-completions`、`anthropic-messages`。

## 输出

终端表格 + `report.json`：

```
目标                                     ping    中位      客观题    tokens
pixelstarrysky-claude/claude-opus-5-5   2/2     2332ms   8/8       469
glm-kimi/glm-5.3-flash                  2/2     2914ms   8/8       804
hkbu-genai/kimi-k3                      1/1     3249ms   6/8       1697
```

## 三个必须知道的坑

1. **推理模型要留思考空间**：`max_tokens` 太小（比如 8）会被 reasoning tokens 吃光，正文为空 → 被误判为答错。实测 kimi-k3 因此从 6/8 掉到 1/8。脚本默认给 96。
2. **题量决定信噪比**：8 题只能发现"明显坏了"，20 题能看 10% 级差异；**不要用它给模型排名**。
3. **免费额度会骗你**：某些中转/校园网关对高价模型有"每天 N 次"限制，失败长得像网络问题。跑之前先 `--list`，对免费模型用 `--quiz 3 --ping 1`。

## 题库

`questions.json`，20 道单选：算术、代数、逻辑、计数、进制、JS/Python/SQL/正则/Git、复杂度、概率、位运算、递归、语义歧义。全部答案唯一、无时效性；顺带测了指令遵循（"只回答一个字母"）。

加题只需往数组里加 `{"id","prompt","answer"}`，别加有争议的题。

## 何时不该用它

- 要判断"哪个模型更聪明" → 用大样本基准（如 Artificial Analysis 的 Intelligence Index）
- 要测长上下文、工具调用、多轮记忆 → 这个探针不覆盖
- 要看成本 → 它只报 token 消耗，价格取决于你的中转分组倍率

## License

MIT
