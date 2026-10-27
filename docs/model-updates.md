# 模型更新：会不会自动跟上？

> 你在 ZCode 里配的模型 ID 会用很久，真正的问题是这个网关能不能跟上上游的目录变化。
> 下面是实测结论（2026-10-01）。

## 一句话

**远端目录会「半自动」跟上，静态兜底表需要 `sync-vendor.sh`。**

| 模型来源 | 谁负责 | 上游更新后 |
|---|---|---|
| **远端目录**（登录后向官方拉） | 网关每次启动拉一次 | ⚠️ 需**重启网关**或点「↻ 重拉模型目录」 |
| **静态兜底表**（`vendor/src/*-product.ts`） | 插件作者在仓库里更新 | ❌ 不会自动，跑 `bash scripts/sync-vendor.sh` |

---

## 一、远端目录：主体来源

登录后，网关向官方拉真实模型目录。**这部分永远是最新的** —— 上游新增模型，
只要重新拉一次就能看到。

### 但默认只拉一次（真实缺陷）

vendor 的适配器把远端目录缓存在实例字段里，判据是「只要不是 undefined 就不再拉」：

```ts
// vendor/src/trae-adapter.ts:619（buddy-adapter.ts:860 同款）
if (this.remoteModels !== undefined || this.options.fetchRemoteModels === undefined) return
```

于是**进程生命周期内只拉一次**。对常驻服务来说，上游加了模型要**重启**才看得见。

### 修法：两个「重拉」入口（已实现）

| 入口 | 位置 | 作用 |
|---|---|---|
| **↻ 重拉模型目录** | 顶栏按钮 | 重拉全部供应商 |
| **↻ 重拉** | 每个供应商的「模型管理」里 | 只重拉这一个 |
| `POST /api/p/<id>/models/refresh` | API | 同上，供脚本调用 |
| `POST /api/models/refresh-all` | API | 全部 |

实现是**清掉适配器的缓存字段**再调一次 `listModels()`：

```ts
delete target.remoteModels   // TS 的 private 只是编译期约束
delete target.remoteMeta     // ⚠️ 必须一起清，见下
delete target.modelsCache
```

**不改 vendor 代码**，所以日后仍能从上游同步。

> ⚠️ `remoteMeta` 必须一起清：它是 `id → 模型` 的映射，供能力判定（图片/推理/上下文窗口）使用。
> 只清 `remoteModels` 会出现「模型列表是新的、能力查的是旧的」这种不一致
> （trae 的 `inputModalitiesFor` / `reasoningConfigFor` 都读它）。

---

## 二、静态兜底表：需要同步 vendor

`vendor/src/product.ts`、`qoder-product.ts`、`trae-product.ts` 里各有一张
**编译期快照**的模型表。它有两个用途：

1. **远端拉不到时兜底**（未登录、网络故障）——保证选择器不变空；
2. **白名单校正**（buddy/workbuddy）—— 见下。

### 为什么 buddy 需要白名单校正

vendor 的注释记录得很清楚：服务端按**认证上下文**决定返回哪些模型，
CLI token 拿到的集合可能是残缺甚至错的。

实测（本机，2026-10-01）：

```
上游 /v3/config 下发 19 个模型
网关呈现 17 个
```

差异拆开看：

| 类别 | 模型 | 说明 |
|---|---|---|
| 上游有、网关没有（**正确过滤**） | `auto`、`codewise-completions`、`codewise-rewrite`、`codewise-jump`、`codewise-default-model-v2`、`nes-gf`、`hunyuan-image-alpha` | 非对话用途（代码补全/跳转/生图/NES），不该出现在对话模型列表 |
| 网关有、上游这次没下发 | `glm-5v-turbo`、`hy4-preview`、`kimi-k2.6`、`kimi-k2.7`、`kimi-k2.8-preview` | 来自静态表 |

**关键实测**：那 5 个「上游没下发」的模型**仍然可以正常调用** ——
说明静态表是**超集**而非过期数据，过滤是安全的。

### 什么时候静态表会真的过时

- 上游**下线**某模型 → 静态表仍列出它 → 调用会报错（用户能看到明确错误）
- 上游**新增**某模型且**不在**静态表 → 被白名单过滤掉 → **看不到也调不到**
  （vendor 有个例外：被 agent 引用的模型会保留，缓解了这个问题）

第二种是真正需要注意的。**这就是要同步 vendor 的原因。**

---

## 三、怎么同步（一条命令）

```bash
bash ~/dsh-llm-gateway/scripts/sync-vendor.sh            # 同步 + 类型检查 + 重启
bash ~/dsh-llm-gateway/scripts/sync-vendor.sh --check    # 只看有没有更新
```

脚本做的事：

```
① git clone 上游（gitee.com/iJetLi/deepseek-harness-codearts）
② 对比 vendor/src 的差异，打印摘要
③ 备份当前 vendor/src → vendor/.backup-<时间戳>
④ rsync 覆盖
⑤ 跑类型检查（自有代码）——失败会提示怎么回滚
⑥ 重启网关
⑦ 记录上游 commit 到 vendor/.upstream-revision
```

### 实测（本机，2026-10-01）

我克隆的时间是 12:25，之后上游在 **13:31** 有新提交：

```
上游 HEAD: 778b862  2026-10-01 13:31
  refactor(jet-hub): 供应商开关从左侧行尾搬进页头弹窗…
与本地差异文件数: 13
```

**但三张静态模型表都没有变化**（`product.ts` 30 条 / `qoder-product.ts` 19 条 /
`trae-product.ts` 33 条，逐条比对一致）—— 那次提交是 UI 重构。

这正好说明：**上游改动绝大多数与模型无关**，模型表变动是低频事件。
不必频繁同步，`--check` 看差异即可。

同步后回归：四端口正常、真实对话返回 `OK`、积分读数正常。

### 出问题怎么回滚

```bash
cd ~/dsh-llm-gateway
rm -rf vendor/src
mv vendor/.backup-<时间戳> vendor/src
bash scripts/stop.sh && bash scripts/start.sh
```

---

## 四、我在这一轮修掉的两个真实缺陷

### 1. `listAllModels()` 不触发远端拉取 → 管理界面少显示模型

**症状**：重启网关后打开控制台，trae 显示 **28** 个模型；但同一个 `trae`
的 OpenAI 端点 `/v1/models` 返回 **38** 个。

**复现**：

```
① 先查 /api/p/trae/models  → 28 个（静态表）
② 再查 /v1/models          → 38 个（这次触发了远端拉取）
③ 重查 /api/p/trae/models  → 38 个（缓存已有）
```

**根因**：我的管理 API 用 `listAllModels()`，那是**纯读缓存**的同步方法，
只看 `this.remoteModels`，**不会触发拉取**（拉取在 `listModels()` 里）。
网关刚启动、还没人调用过 OpenAI 端点时，缓存是空的 → 回退静态表。

**修法**：`listModelsWithState()` 改为先 `await adapter.listModels(provider)` 预热，
再读 `listAllModels()`。修复后 ①=②=38。

### 2. `refreshModels` 只清一半缓存

见上文的 `remoteMeta` 说明。

---

## 五、给你的建议

| 场景 | 做法 |
|---|---|
| 日常 | 什么都不用做，网关自己跑 |
| 怀疑上游加了新模型 | 点顶栏 **↻ 重拉模型目录** |
| 隔一两周 | `bash scripts/sync-vendor.sh --check` 看有没有更新 |
| 有更新 | `bash scripts/sync-vendor.sh`（自动备份+类型检查+重启） |
| 出问题 | 用 `.backup-<时间戳>` 回滚 |

**关于 ZCode 里的模型 ID**：你填的 `qmodel`、`kmodel_latest` 这些是**上游的
模型标识**，由服务端定义，不会因为网关更新而变。只有上游真的下线某个模型时才会失效——
那时对话会返回明确错误，而不是静默失败。

## 同步上游时，本机自有修复会不会被覆盖？（2026-10-27 核对）

这是本项目最容易出**静默回归**的地方，故把结论与守卫写成可执行的。

### 结论：只有落在 `vendor/src/` 的修复会被覆盖，共 5 个提交

`rsync -a --delete` 只覆盖 `vendor/src`，**不碰 `src/`**。所以先按位置分类：

| 位置 | 修复数 | 是否受同步影响 |
|---|---|---|
| `src/`（我们自有的网关代码） | 约 40 个提交 | **不受影响** |
| `vendor/src/`（复用的上游代码） | **5 个提交** | ⚠️ 会被 `rsync --delete` 冲掉，靠补丁重放 |

那 5 个提交收敛到 **3 个文件**：

| 提交 | 文件 | 内容 |
|---|---|---|
| `eca0b0c` / `e348519` / `757ed70` / `92dd6ef` / `678ebf7` | `vendor/src/openai-gateway/tencent-fingerprint.ts` | 腾讯风控指纹（6 条） |
| `c4bcbf1` | `vendor/src/gemini{,-adapter,-messages}.ts` | gemini 动态模型目录（3 处） |
| `7c78109` | `vendor/src/qoder-wasm.ts` | qoder `prepareRequest` |

### 现在为什么不会丢：补丁 + 重建验证

两个补丁（`vendor-patches/*.patch`）承载全部本地改动，`sync-vendor.sh` 的 ④d/④f
会自动重放，**失败即 `exit 1` 硬失败**（2026-10-24 之前只 `echo ⚠️` 就继续，
那会导致「同步完 gemini 只剩 1 个模型 / Claude Code 又全 400」而日志看不出原因）。

**最强验证**（可复跑）——拿干净上游 + 我们的补丁重建，应与本机逐字节一致：

```bash
git clone --depth 1 https://gitee.com/iJetLi/deepseek-harness-codearts.git /tmp/up
mkdir -p /tmp/sim/vendor && cp -a /tmp/up/src /tmp/sim/vendor/src
cd /tmp/sim && git init -q . && git add -A && git commit -qm base
for p in ~/dsh-llm-gateway/vendor-patches/*.patch; do git apply "$p"; done
cmp vendor/src/gemini-adapter.ts  ~/dsh-llm-gateway/vendor/src/gemini-adapter.ts
```

2026-10-27 实测：4 个目标文件**全部一致**。这说明「本地改动 = 上游 + 补丁」这条等式
成立，同步不会丢东西。

### ⚠️ 更正：上游那 5 条**不是**我们贡献的（2026-10-27 查证）

本文件上一版写过「上游陆续把我们登记的指纹收进了它自己的表」——**那是错的**，
当时只是看到「内容相同」就推断成因果。查了上游 git 作者与时间后：

| # | 指纹 | 上游提交者 | 上游时间 | 我们时间 | 结论 |
|---|---|---|---|---|---|
| 1 | ZCode `Main branch…` | Jet | `b57178b` 10-04 20:39 | `eca0b0c` 10-20 22:50 | 上游早 **16 天** |
| 2 | Claude 身份句 | Jet | `2249dd9` 10-14 22:20 | `e348519` 10-20 23:09 | 上游早 **6 天** |
| 3 | Claude 反馈句 | Jet | `22cc4f8` 10-18 03:45 | `92dd6ef` 10-24 00:42 | 上游早 **6 天** |
| 4 | DSH 身份句 | **YYYX_LXY** | `76d3306` 10-21 00:08 | `757ed70` 10-20 23:55 | 我们早 13 分钟，但**无因果关系** |
| 5 | DSH Web 运行面 | Jet | `6b437fd` 10-21 19:55 | `92dd6ef` 10-24 00:42 | 上游早 **3 天** |
| 6 | `x-anthropic-billing-header` | — | — | `678ebf7` 10-21 11:59 | **我们独有** |

- 上游作者集合里**没有我们的邮箱**（`cdxDNRF <1622304382@qq.com>`）：本项目
  **没有向上游提过 PR**，也没提过 issue。上游修复全部来自其自有贡献者
  （Jet / YYYX_LXY / Betsy 等）。
- 前 5 条是**各自独立实测**出来的（两边都踩到同一个腾讯风控名单，这是必然的 ——
  名单是腾讯侧的，谁用 buddy 谁都会撞），**不是我们报上去的**。
- 第 4 条时间只差 13 分钟，但作者是第三人 `YYYX_LXY`；同一条指纹被两个人独立
  在几乎同一时刻发现，最可能就是「腾讯当天 22:42–23:25 部署了新指纹」——
  我们自己的提交里当时就记了这个部署窗口。**时间接近 ≠ 因果**。

⇒ 真正要记住的结论只有一条：**第 6 条是我们独有的，补丁必须一直保留**。
⚠️ 别因为「前 5 条上游有了」就删补丁：补丁是**整文件 diff**，删了会连第 6 条一起丢。

### 守卫：`bash scripts/selfcheck.sh` 第 ⑦ 项（2026-10-27 新增）

把上面这张表变成**可执行断言**：14 项标记逐个检查「是否仍以**代码行**存在」
（不是只判 `includes` —— 指纹串在文档注释里也出现，只判 includes 对「规则被删」是瞎的，
这个坑本轮实际踩过并修掉了）。

同步 vendor / 升级插件之后跑一次：

```bash
bash scripts/selfcheck.sh     # 或 npm run selfcheck
```

期望看到 `⑦ 14 项全部在位`。失败时会直接点名哪一项丢了、以及是否「只剩注释里的提及」。

## 现在每家供应商的模型列表是动态还是静态？（2026-10-27 逐个查证）

结论：**不是全都动态**。分三类，只有第一类会「上游变了我们自动跟着变」。

### 判定方法：适配器里有没有接 `fetchRemoteModels`

vendor 的适配器统一走这一行决定目录来源：

```ts
return this.remoteModels ?? this.product.fallbackModels
```

- 接了 `fetchRemoteModels` → `remoteModels` 有值，**远端优先**
- 没接 → `remoteModels` 永远是 `undefined`，**永远用产品里写死的 `fallbackModels`**

### 第一类：真动态（远端目录，上游变我们跟着变）

| 渠道 | 接线位置 | 实测目录 | 静态兜底 |
|---|---|---|---|
| `buddy` | `src/providers/buddy.ts:128` `auth.fetchModels(pool)` | 32 | 16 |
| `trae` | `src/providers/trae.ts:101` `auth.fetchModels(pool)` | 40 | 32 |
| `lobsterai` / `loomy` / `raccoon` / `minimax` | `src/providers/extended.ts` | — | — |
| `codearts` | `src/providers/codearts.ts` | — | — |
| `gemini` | `src/providers/extended.ts:1003` 从 `fetchAvailableModels` 拉 + **逐个探测** | 4（受账号限） | 1 |

刷新机制：**后台每 20 分钟**（`catalog-refresher.ts` 的 `DEFAULT_INTERVAL_MS`），
外加手动「↻ 重拉」（`POST /api/p/<id>/models/refresh`）。实测 buddy 重拉返回
`{"ok":true,"count":16}`。

⚠️ `gemini` 特殊：它不只是「拉列表」，还会**逐个发请求探测可用性**（`looksDeprecated`
+ 探测），所以它的目录反映的是「你这个账号真能用哪些」，而不只是「上游有哪些」。

### 第二类：静态表（上游变了，我们**不会**自动变）

| 渠道 | 目录来源 |
|---|---|
| `qoder` | `qoder-adapter` 的 `fallbackModels`（写死在 `qoder-product.ts`，23 个） |
| `zcode` | `ZCODE_FALLBACK_MODELS`（写死在 `zcode-product.ts`，2 个） |
| `aistudio` | `src/providers/aistudio-adapter.ts:41` 的 `AISTUDIO_MODELS` 常量 |
| `build` | `src/providers/build-adapter.ts:154` 的 `BUILD_MODELS` 常量 |

这几家上游新增模型时，**必须改代码**（qoder/zcode 改 vendor 后要进补丁；
aistudio/build 是我们自己的 `src/`，直接改）。

⚠️ 别被「qoder 有 17 个模型」误导成动态：那 17 个是过滤掉停用项后剩下的，
源头仍是写死的 23 个静态表。

### 第三类：聚合端点

`aggregate` 不自己维护目录，它把**已启用渠道的目录实时汇总**。所以它的模型数
= 各渠道之和（当前 96），第一类渠道一变，聚合端点立刻跟着变。

### 一句话回答「上游变我们会不会变」

| 你关心的 | 结论 |
|---|---|
| buddy / trae / gemini（+ lobsterai/loomy/raccoon/minimax/codearts） | **会**，20 分钟内自动生效 |
| qoder / zcode / aistudio / build | **不会**，要改代码/等上游补丁 |
| 模型能力（上下文窗口、是否支持图片） | 第一类跟远端；第二类跟静态表，**可能过期** |

### 想让它变（排查用）

```bash
# 1) 看某家现在暴露了什么
curl -s http://127.0.0.1:3901/v1/models        # 单家
curl -s http://127.0.0.1:8790/v1/models        # 聚合（provider/model）

# 2) 立即重拉（仅对第一类有效；第二类会返回相同数量）
curl -X POST http://127.0.0.1:8790/api/p/buddy/models/refresh

# 3) 看保鲜器上一轮结果（哪家成功、哪家失败、失败原因）
curl -s http://127.0.0.1:8790/api/catalog-status
```

⚠️ 重拉对**第二类是无操作**（返回同样数量）—— 若你重拉后发现数量没变，
先确认这家是不是静态表，别误判成「拉取失败」。
