# 腾讯系渠道的内容级风控指纹（HTTP 400 / code 11128）

适用渠道：`buddy`（CodeBuddy 中国版）、`workbuddy`（WorkBuddy 国际版）。
两份实现：

| 位置 | 用途 |
|---|---|
| `vendor/src/openai-gateway/tencent-fingerprint.ts` | 改写表本体（`CONTENT_FINGERPRINTS`） |
| `src/core/protocol.ts`（`toGenerateOptions` / `rewriteAssistantTextFingerprints`） | 唯一接线点：**OpenAI 与 Anthropic 两条入口都汇合到这里** |

> 腾讯侧随时会**新增**指纹。本文件是「怎么判断 + 怎么补一条」的手册，
> 不是一次性修复记录。

## 症状长什么样

```
HTTP 400
{"code":11128,"msg":"Illegal API invocation from an unapproved channel",
 "displayMsg":{"en":"blocked by security policy","zh":"请求被拦截，请重新发送"}}
```

客户端看到的可能只有 `请求被拦截，请重新发送 Illegal API invocation from an unapproved channel`。
关键判据：**同账号换掉出问题的那句就 200** ⇒ 这是**内容级**拦截，
**换号无效、写账号冷却纯属误伤**（会白烧整个账号池）。别把它并进 `isContentRejection`。

⚠️ 同一个业务码 `11128` 还有另一族 `msg:"request illegal"`（**渠道校验**，
按账号要求三枚 Conv 头）—— 两者 `code` 相同、成因与处置完全不同，判据要按 `msg` 分开。

## 已登记的三条指纹

三条都是**整句精确匹配**（逐字符，非正则/关键词）、**大小写不敏感**；
但**位置语义不同**，新增一条时必须两侧都探（否则会得出「这条不触发」的假阴性）。

| # | 指纹（`find`） | 客户端来源 | 位置语义 | 登记日期 |
|---|---|---|---|---|
| 1 | `Main branch (you will usually use this for PRs)` | ZCode 内建常量 | **位置无关**（句中/段中被夹住也拦） | 2026-10-05 |
| 2 | `You are Claude Code, Anthropic's official CLI for Claude` | Claude Code system 首句 | **行首锚定**（前接任意字符即放行） | 2026-10-20 |
| 3 | `You are an AI agent powered by DeepSeek Harness` | **DSH 自己的 system 首句** | **行首锚定** | 2026-10-20 深夜 |

第 3 条的事故形态特别值得记住：

```
同一份 DSH system 提示词
  · 2026-10-20 14:10  → 200（DSH 里 buddy 正常）
  · 2026-10-20 22:42  → 200（最后一次成功）
  · 2026-10-20 23:25  → 400/11128（此后每轮都挂）
```

⇒ 与 DSH 升级、账号、本网关**都无关**，是腾讯侧当天新收录的一句。
用户侧观感：「buddy 在 DSH 里用不了，但其他客户端都正常」。

## 改写范围（实测结论，别扩大也别缩小）

| 位置 | 改不改 | 依据 |
|---|---|---|
| `system`（**所有** system 消息，不只第一条） | ✅ 必须改 | 非首位 system 同样被拦 |
| `assistant` 正文 | ✅ 必须改 | 会话历史里模型复述过指纹 ⇒ 每轮原样重放 ⇒ **跟会话走，不跟模型走** |
| `user` | ❌ 不改 | 实测放行；改了篡改用户原话 |
| `tool` 结果 | ❌ 不改 | 实测放行；改了破坏证据 |
| `reasoning_content` | ❌ 不改 | 实测放行 |
| `tool_calls[].arguments` | ❌ 不改 | 实测放行 |

「跟会话走」这一条是**最容易误判**的：会话历史里的 assistant 正文一旦含指纹，
该会话从此每轮 400，换任何腾讯系模型都一样 —— 排查风控 bug 的会话本身会被风控拦死。

## 判定「是不是又来了新指纹」（实发探针法）

不要靠猜，也不要只测一种位置。最小成本矩阵（`max_tokens` 取小值；被拦不耗额度）：

1. 中性对照：`system: "You are a helpful assistant."` → 应 200
2. 把**可疑客户端**的 system 原文整份塞进 `system` → 若 400，缩小到首句/首段
3. 定位到句子后逐格测：原句 / 去句号 / 全小写 / 句首加 `Note: ` / 改一个词 /
   只留品牌词 ⇒ 得到「锚点 + 最小充分串」
4. 角色两侧测：句子放 `assistant` 正文**开头**、`user`、`tool` 结果
5. 换一个**已知干净的账号**再跑一遍第 3、4 步（排除 `request illegal` 那族干扰）

真实探针示例（经本网关 → buddy）：

```bash
curl -s http://127.0.0.1:8790/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"buddy/deepseek-v4.1-flash","max_tokens":16,
       "messages":[{"role":"system","content":"<可疑句子>"},{"role":"user","content":"hi"}]}'
```

## 新增一条指纹

1. 用上面的矩阵拿到**实发证据**（被拦 + 改写后放行，两条都要）；
2. 往 `vendor/src/openai-gateway/tencent-fingerprint.ts` 的 `CONTENT_FINGERPRINTS`
   加一条：`find` 写**最小充分串且不带尾句点**，`replace` **必须保持原意**（模型要读懂），
   `note` 写清日期/来源/证据；
3. 重新生成补丁（上游同步会覆盖 vendor/src，不更新补丁下次同步就丢）：
   `vendor-patches/tencent-content-fingerprints.patch`，注册在 `scripts/sync-vendor.sh` ④f；
4. 跑一遍 `bash scripts/typecheck.sh`，再实发一次 E2E（先跑一次**能复现 400** 的请求集合，
   改完必须全部 200）。

## DSH 直连插件侧（不经过本网关）

DSH 的 `buddy` 提供商由 `dsh-providers-hub` 插件直连，它有一份**同样的**改写表
（本网关的 vendor 就是从中同步来的）。插件表若没登记新指纹，DSH 直连同样 400 ——
此时本网关改了也**帮不到插件路径**，只有 `local/buddy/*`（走本网关）能用。

插件是 npm 包、不能提交进本仓库；本地热修与重打步骤见
`~/.dsh/profiles/web/.hotfix-backup/README.md`（改完需重启 DSH 生效）。
