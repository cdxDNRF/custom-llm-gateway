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
