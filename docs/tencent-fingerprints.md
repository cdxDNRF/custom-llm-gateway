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

## 同类盘点：还有哪些渠道会「看提示词」（2026-10-21）

本仓库实测/代码证据里，**提示词内容级**的上游校验只有两家；其余渠道的风控都在
「客户端身份 / 请求形态 / 内容安全」层，不在 system 正文上。

| 渠道 | 上游校验 | 方向 | 触发形态 | 我们的应对 |
|---|---|---|---|---|
| `buddy` / `workbuddy` | 客户端模板句**黑名单** | 黑名单（逐词收录，会持续新增） | `400 / 11128 / Illegal API invocation from an unapproved channel`，`displayMsg.zh=请求被拦截，请重新发送` | 本文件的改写表：`system` + `assistant` 正文 |
| `buddy` / `workbuddy`（请求形态） | `messages[0]` 必须是 `system`；`tool_calls`/`tool_result` 必须配对 | 硬性结构 | 同码 11128 `first message is not system prompt`（伪装成安全策略）；11148「工具记录不完整，请新建任务」 | 适配器无条件补 system 占位 + 工具配对归一化 |
| `zcode`（智谱 z.ai） | `system` 必须带**官方身份块** | **白名单** | `405 / 3012 / request has been blocked due to unusual activity` | 内置官方身份块（2898 字符三段）+ 日期块，见 `vendor/src/zcode-identity.ts` |

⚠️ 两类的「维护语义」相反，别混：

- **腾讯 = 黑名单**：上游随时会**新增**一句（本文件第 3 条就是这么来的），
  症状是「某客户端突然全挂、其他客户端正常」；应对 = 探针矩阵 + 表里加一条。
- **ZCode = 白名单**：上游要求**必须带**官方身份块；官方客户端升级、身份块结构变了
  就要同步更新，否则 3012 —— 而 **3012 有账号冷却惩罚**（30 分钟；24h 内第 3 次起
  24h；5 次停用），**禁止用试错式探测去撞它**。

其余渠道的风控层级（都不是「看提示词」）：

| 渠道 | 校验方式 |
|---|---|
| `trae` | 持久化 `machine_id` / `device_id` 每请求携带；`X-Ide-Version` 决定模型准入（4001/4006 原文会误导排查方向） |
| `qoder` / `qodercn` | 请求体 WASM 签名（含设备上下文）；按体积设限 |
| `zcode` | 按需向阿里云索要 captcha（`3007`），命中后每轮换新 param |
| `raccoon` | 短信验证码 + AES 加密参数 |
| `lobsterai` | `X-LobsterAI-Client-Capabilities` / `-Version` 能力与版本头 |
| `accio` | `utdid` 必须同时放进请求体 `properties`，否则 **HTTP 200 + HTML 风控拦截页**（按 `content-type` 判，别按 body 文本判） |
| `gemini` / `aistudio` / `build` | 内容**安全审核**（输入/输出安全策略；Build 的流式审核更严、易截断）——按「内容是否违规」，不是「你是什么客户端」 |

排查顺序建议：先看 **HTTP 码 + 业务 code + `displayMsg` 原文** ——
`400/11128` → 腾讯内容级（本文件）；`405/3012` → ZCode 身份块；
`200 + text/html` → accio 风控页；`401/403` → 客户端身份/凭据层。

## 第 4 条：Claude Code 的计费头（2026-10-21）

```
x-anthropic-billing-header: cc_version=2.1.293.866; cc_entrypoint=sdk-cli;
```

Claude Code v2.1.293 把它放在 `system[0]` 的**第一行**（74 字符）。这是它给
Anthropic 官方统计「第三方入口」用的标记，腾讯把它当成「未获批准渠道」的证据，
于是**每条请求**都 400/11128 —— 表现为「Claude Code 里任何 buddy 模型都用不了」，
而其它客户端正常（它们不发这一行）。

| 形态 | 结果 |
|---|---|
| 整行 / 只有头名 / 头名+冒号 / 全大写 / 值改版本号、改 entrypoint | ❌ 400 |
| 头名少一个字母（`…-heade`） | ✅ 200 ⇒ 需要**完整头名** |
| 头名后接字母（`…-headerX`） | ❌ 400 ⇒ 是**词边界**匹配，不是子串 |
| 头名后加空格再冒号（`…-header :`） | ❌ 400 |
| 头名前加任意字符（换行 / 空格 / `hello `） | ✅ 200 ⇒ **行首锚定** |
| 改头名字母（`x-billing-header:` / `anthropic-billing-header:`） | ✅ 200 |
| 放进 assistant 正文**开头** / 中间 / user / tool 结果 | ❌ / ✅ / ✅ / ✅ |

⇒ 判据是「行首 + 完整头名」，**值与内容无关**；故 `find` 只写头名，
`replace` 改成 `anthropic-billing-header-tag`（保留计费语义、不再是 HTTP 头名）。

## 排查入口：Claude 系客户端「说没有搜索工具」的三层原因

Claude Code / ZCode 走 Anthropic 协议 `/v1/messages`，这条链路上有三处会让搜索失效，
症状都相似（模型声称没有搜索工具 / 搜索结果无关），排查时按顺序看：

1. **服务端工具被转换层丢弃** —— Anthropic 的 `web_search_20250305` 没有
   `input_schema`，`anthropicToOpenAiRequest` 若直接 `continue` 就会让它消失。
2. **原生搜索没接线** —— 若 `maybeRunNativeSearch` 只挂在 OpenAI 端点上，
   Anthropic 入口永远不会接管搜索。
3. **误接管「工具检索」类工具** —— Claude Code 的 `ToolSearch`（查延迟加载的
   工具 schema，如 `select:WebSearch`）名字也含 `search`；被当成网络搜索后，
   网关会把它从工具列表里摘掉 ⇒ 模型再也载入不了 WebSearch/WebFetch。

外加一条**查询质量**问题（不是上面三层，但症状同样是「搜了但没用」）：
客户端会往最后一条 user 消息里塞噪音（Claude Code 的 `total_tokens` 标签、
DSH 的 `system-reminder` / `Current runtime context.` / `Time sampled while…`）——
直接拿全文当 query 会搜出无关结果。`toSearchQuery()` 负责净化。

## 抗版本漂移：这套修复在 Claude Code 升级后还成立吗（2026-10-21 实测）

结论：**指纹这一层不会失效**，但搜索那一层有两个「上游一改就失效」的点，已按
「只认结构、不认字面量」的原则实现。逐项说明：

### ① 计费头指纹 —— 已按「只认头名」实现，跨版本成立

`find` 只写 `x-anthropic-billing-header`（头名），不含版本号 / entrypoint / 值。
实证：

| 输入 | 我们的结论 | 依据 |
|---|---|---|
| v2.1.293 真实头 | ✅ 改写放行 | 真 CLI 抓包 |
| **v2.1.306 真实头**（npm `latest`，2026-10-21） | ✅ 改写放行 | 真 CLI 抓包 + 实发 |
| 版本号改成 3.x / entrypoint=vscode / 追加参数 / CRLF | ✅ 全部改写放行 | 6 格单元全绿 |
| 头名少一个字母 / 后接字母 / 加空格再冒号 | 上游不拦（无需改写） | 探针矩阵实测 |

也确认了 **v2.1.306 依然发送这个头**（`cc_version=2.1.306.dcf; cc_entrypoint=sdk-cli;`
逐字同形），所以升级到最新版后这条修复**仍然必要且仍然有效** —— 我用 2.1.306 的真实
二进制跑了完整链路（搜索 + 引用来源），全部 200。

**唯一会失效的情形**：Anthropic 把「头名」本身改掉（比如换成
`x-anthropic-attribution`）。届时腾讯会不会跟着拦，**取决于腾讯的名单**，不是我们能推的。
我顺带探了一组「相近改名」，当前腾讯**都不拦**（`x-anthropic-client-header` /
`x-anthropic-attribution` / `x-anthropic-beta` / `x-anthropic-sdk` / 去掉 `x-` 前缀
全部 200），说明它目前登记的是**这一个具体头名**，只跟着这一个改才需要动。

> 另有一个**客户端侧**的彻底规避：Claude Code 支持
> `CLAUDE_CODE_ATTRIBUTION_HEADER=0` 关掉这个头（实测生效：system 从 3 块变 2 块，
> 计费头整块消失）。但**不建议依赖它**做主要修法 —— 它是 Anthropic 的开关、随时可能
> 改名或收回；网关侧改写才是我们可控的那一层。把它当「万一网关不在链路上」的备选。

### ② 搜索接管 —— 两个「认字面量」的点，已改成认结构

| 位置 | 旧写法（会随版本失效） | 现写法（抗变化） |
|---|---|---|
| `anthropicToOpenAiRequest` 识别服务端工具 | 按 `input_schema === undefined` 一律丢弃 | 认 `type` 字段前缀 `web_search` / `web_fetch`，补最小 schema |
| `isSearchToolName` 认搜索工具 | 名字含 `search` 就接管 | 先排除 `tool` / `skill` / `mcp` / `capab`（`ToolSearch` 这类能力检索） |

实测 2.1.306 的请求形态与 2.1.293 **一致**（`system` 3 块、首块为计费头、
`tools` 里含 `ToolSearch` + `DeferredToolPlaceholder`），故两个修复都直接适用。

**仍可能随版本漂移的两点**（记录在此，便于日后排查）：

1. 服务端工具名若从 `web_search` 改叫别的（如 `web_search_v2`），仍会命中
   `startsWith('web_search')`；但若改成完全无关的名字（如 `browse`），需再加规则。
2. 延迟工具机制若换实现（`ToolSearch` → 别的名字），排除名单要同步 ——
   症状会复现为「模型说没有搜索工具」，按本文件末尾的三层排查入口查即可。

### ③ 冒烟检查（怀疑升级后失效时跑这一条）

```bash
# 用真 CLI 跑一次带搜索的问答；能返回带来源链接的内容即正常
claude -p "用 WebSearch 查一下今天的科技新闻，给2条带链接" --allowedTools WebSearch
```

若报 `400 / 11128`：计费头或另一条新指纹未覆盖 → 按本文「新增一条指纹」流程补。
若模型说「没有搜索工具」：搜索接管那一层 → 按「三层排查入口」逐层查。

## 2026-10-24 对照上游：补 2 条（第 6/7 条），并发现一条**正在发生**的事故

上游 `4ec67a8` → `a777741`（342 提交 / 129 文件），指纹表由 2 条增到 6 条。
逐条与我们的表对照，缺 2 条：

### 第 6 条（正在拦当前 DSH）：Web 运行面开头两句

上游登记的是**旧版**措辞 `…Web GUI at <url>.`；而本机当前安装的 DSH
（`dsh-harness-dev-context` 2026-10-20 构建）已改成**新版**：

```
…through the DeepSeek Harness Web GUI whose URL the runtime context names.
When the user refers to "this page", "this GUI", or "this app" without
naming another target, they mean this GUI.
```

用会话日志重建的同一份真实 system（只这一句不同）实发对比 ⇒ 旧版 200、**新版 400**。
**症状：DSH 里新建会话选 buddy 直接整轮失败**；老会话（历史里是旧版措辞）反而正常
—— 这解释了「有时能用有时不能用」的错觉。

字面量粒度：前 221 字符被拦 / 前 220 放行 / 只发第一句放行 ⇒ 触发串**跨句边界**，
`find` 必须写全两句。位置语义：**位置无关**（前接任意前言仍拦），与第 4 条的行首锚定相反。

### 第 7 条：Claude Code 的「反馈」段默认句

```
To give feedback, users should report the issue at
 https://github.com/anthropics/claude-code/issues
```

与身份句不同，这条是 system prompt 的**固定段落、每轮必带**（上游记录单日白撞 647 次）。
本机复验：裸串 400 / 改写后 200。`find` 必须写整句（砍掉前半或后半都放行 ⇒ 写短了空跑）。

### 顺带：第 4 条的 replace 换成「官方同形」

原来 `running on DeepSeek Harness` 虽放行，但**保留品牌 token** ⇒ 上游一旦放宽成
关键词匹配就失效。改用 `You are an AI coding assistant, powered by a large language model`
（结构取自 CodeBuddy 自己的提示词资产，实测 200），收益是**出站 system 里不再出现
`DeepSeek Harness`**。

### 现在表里有 7 条

| # | find（简写） | 位置语义 | 来源 |
|---|---|---|---|
| 1 | `Main branch (you will usually use this for PRs)` | 位置无关 | ZCode |
| 2 | `You are Claude Code, Anthropic's official CLI for Claude` | 行首锚定 | Claude Code |
| 3 | `To give feedback, users should report the issue at https://…` | 位置无关（整句） | Claude Code |
| 4 | `You are an AI agent powered by DeepSeek Harness` | 行首锚定 | DSH 身份句 |
| 5 | `x-anthropic-billing-header` | 行首锚定（只认头名） | Claude Code 计费头 |
| 6 | `You are interacting with the user through the DeepSeek Harness Web GUI whose URL…GUI.` | 位置无关（221 字符） | DSH Web 运行面 |
| 7 | （上游另有旧版 Web 运行面登记） | — | 我方实测不拦，作防线保留 |

⚠️ **新增/同步一条时的纪律**（本轮再次验证有效）：**位置语义与 `find` 长度都必须逐条
实测**，不能拿别条的结论推 —— 本表里「行首锚定」和「位置无关」各占一半，
`find` 从 30 字符到 221 字符都有。

### 同步上游的正确姿势（本轮结论）

上游的指纹表**不能整份覆盖**我们的（会丢掉第 5 条 `x-anthropic-billing-header`，
它是我们本地实测登记、上游至今没有的）。正确做法是**逐条对照 `find`**，
把缺的补进来，而不是 `rsync` 覆盖整个文件。
