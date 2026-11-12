# Gemini Decisions API（决策模型）接入说明

> `gemini-decision-1` 是 Google 2026-11-11 发布的**决策专用模型**：不生成文字，
> 而是对给定候选选项**打分**，返回概率与置信度（零输出 token）。
> 本网关通过 `POST /v1/decisions` 把它暴露给 agent / 脚本调用。

## ⚠️ 为什么它不是模型列表里的一个模型

它是**打分接口**，不是聊天模型。实测对照（2026-11-12，AI Studio API Key）：

| 端点 | 结果 |
|---|---|
| `POST /v1beta/decisions` | ✅ 200（**唯一**可用） |
| `/v1beta/models/gemini-decision-1:decisions` | ❌ 404 |
| `/v1beta/models/gemini-decision-1:generateContent` | ❌ 400（不接受 `input`/`questions`） |
| `/v1beta/models` 模型列表 | ❌ 50 个里**没有** decision-1 |

⇒ 若塞进 `/v1/models`，客户端选中后发 `messages` 必然 400。故做成**独立端点**。

## 前置条件

- 该模型**只能通过 AI Studio 的 API Key** 使用（Google Cloud 上的支持标注
  「coming soon」，即**Pro OAuth 的 gemini 渠道用不了**）
- 所以在 Web 控制台的 **AI Studio (API Key)** 渠道里要有至少一个启用账号
  （在 https://aistudio.google.com/apikey 创建）
- 需要代理（`generativelanguage.googleapis.com` 在墙外）—— 与 gemini 渠道共用
  同一个 `gemini.env` 的 `PROXY=`

## 用法

```bash
curl -X POST http://127.0.0.1:8790/v1/decisions \
  -H 'content-type: application/json' \
  -d '{
    "input": [{"type":"text","text":"茶水间台面上有一摊咖啡渍。"}],
    "questions": {
      "has_spill": {"type":"noul","instructions":"台面上有未清理的液体洒漏吗？"}
    }
  }'
```

响应：

```json
{"answers":{"has_spill":{"confidence":0.974,"noul":0.974,"type":"noul"}},
 "usage":{"total_input_tokens":102,"total_output_tokens":0}}
```

## 三种决策类型（全部实测通过）

### ① `noul` —— 是/否判断

```json
{"type":"noul","instructions":"Is there a spill?"}
```
```json
{"confidence":0.974, "noul":0.974, "type":"noul"}
```

### ② `choice` —— 多选（2–255 个选项）

```json
{"type":"choice","instructions":"Cleanup action?",
 "criteria":{"mop":"use a mop","vacuum":"use vacuum","ignore":"do nothing"}}
```
```json
{"choice":"mop","confidence":0.750,
 "probabilities":{"mop":0.750,"vacuum":0.031,"ignore":0.219},"type":"choice"}
```

⚠️⚠️ **`criteria` 必须是「选项名 → 描述」的对象**。传数组
（`["mop","vacuum"]`）会得到 `Invalid input at 'questions.<key>'`，
而错误信息**不提示正确形状** —— 这是本机逐格试出来的。

### ③ `score` —— 有序评分

```json
{"type":"score","instructions":"Rate severity","criteria":["none","minor","major"]}
```
```json
{"score":1.573,"confidence":0.586,
 "probabilities":{"0":0.014,"1":0.400,"2":0.586},
 "legend":{"0":"none","1":"minor","2":"major"},"type":"score"}
```

⚠️ 注意：这里的 `criteria` 是**字符串数组**（与 `choice` 相反）。
两种类型的 `criteria` 形状不同不是笔误，是实测结果。

## 一次请求多个问题（最多 1000 个）

`questions` 是对象，三种类型可**混用**，共用同一个 `input`
（材料只解析/计费一次）。实测三问一次请求：

```json
{
  "input": [{"type":"text","text":"台面有大摊咖啡渍需要清理。"}],
  "questions": {
    "has_spill": {"type":"noul","instructions":"有洒漏吗？"},
    "action":    {"type":"choice","instructions":"清理方式？",
                  "criteria":{"mop":"拖把","vacuum":"吸尘器"}},
    "severity":  {"type":"score","instructions":"严重度","criteria":["none","minor","major"]}
  }
}
```

返回三个答案，`usage.total_input_tokens` 只需计一次材料（194 tokens）。

## 多模态输入

`input` 数组支持 `text` / `image` / `audio` / `video` / `pdf`，上限 256K tokens。
形状与 Gemini Interactions API 的 Content block 一致，网关**原样透传**。

## 错误码

| 状态 | 含义 |
|---|---|
| 400 | 请求体骨架不对（文案会指明缺什么）；或上游参数错（原样透传） |
| 401 | 没有可用的 AI Studio API Key（去 Web 控制台添加账号） |
| 502 | 网络失败（检查 `gemini.env` 的 `PROXY=`） |
| 其它 4xx/5xx | 上游原样透传（决策参数错就是 4xx，**不会**被包成 502） |

## 给 agent 用的时候

决策请求的形状与 chat 完全不同，**不是一个 `messages` 数组**。调用方应该：

1. 把「要判断的材料」放进 `input`
2. 把「要问的几个问题」放进 `questions`（每个问题自己起个名字）
3. 读 `answers.<你起的名字>` 拿结论

一次请求问多个问题比多次单问更省（材料只计费一次），也更适合 agent
做「一次看全」的决策。
