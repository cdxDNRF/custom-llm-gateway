# 来源与维护约定

## 这里是什么

本目录 `src/` 复制自 **[gitee.com/iJetLi/deepseek-harness-codearts](https://gitee.com/iJetLi/deepseek-harness-codearts)**
（MIT，作者 Jet），即 DSH 插件 `dsh-codearts-auth` 的源码。

它包含了 CodeBuddy / WorkBuddy / TRAE / Qoder / LobsterAI / Loomy / Raccoon /
MiniMax / Cline / CodeArts / ZCode 等十余家上游的**认证、协议、加解密、积分**实现，
共约 58,000 行。本项目复用其中的认证与协议层。

## 维护约定

**能不改就不改。** 需要定制时改 `../src/`（本项目自有代码），
**不要改这里** —— 这样日后可以用一条命令从上游同步：

```bash
bash ../scripts/sync-vendor.sh          # 同步 + 类型检查 + 重启
bash ../scripts/sync-vendor.sh --check  # 只看有没有更新
```

同步脚本会自动备份到 `vendor/.backup-<时间戳>/`，出问题可回滚。

## 解耦方式（为什么能一行不改）

上游插件靠 Cordis 的依赖注入取宿主能力（`ctx.credentials` / `ctx.logger`）。
本项目在 `../src/core/context.ts` 里**自己构造一个真实的 Cordis Context**
并提供这两项服务，于是这里的代码全部按原样工作。

另外，适配器**类**本身不持有 `ctx`（只有 `registerXxxLlm` 包装函数用到 `ctx.llm`），
所以可以直接 `new BuddyAdapter({...})` 拿到实例，无需注册到任何注册表。

详见 [../docs/architecture.md](../docs/architecture.md)。

## 已知情况

- `minimax-adapter.ts` / `minimax-messages.ts` 与 `@deepseek-ai/dsh-llm@0.2.0-rc.2`
  有类型漂移（上游代码针对更早的版本）。本项目**不使用 MiniMax**，
  故在 `tsconfig.json` 里排除了这两个文件。
- 同步后若类型检查报错，用备份回滚即可（`sync-vendor.sh` 会打印回滚命令）。

## 许可

上游为 MIT，见本目录 [LICENSE](./LICENSE)。再分发需保留该许可与版权声明。
