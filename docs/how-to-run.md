# 怎么运行

## 最简单：用桌面快捷方式

在桌面建 3 个快捷方式（指向 scripts/windows/ 下的 .bat），效果是（<你的桌面>）：

| 快捷方式 | 作用 |
|---|---|
| **dsh-llm-gateway** | 启动网关 **并打开控制台页面**（双击即可，日常用这个） |
| dsh-llm-gateway 状态 | 查看是否在跑、各供应商端口与账号数 |
| dsh-llm-gateway 停止 | 停掉网关与守护进程 |

双击第一个 → 浏览器自动打开 http://127.0.0.1:8790/ 。

> 首次双击可能弹出 Windows 防火墙提示？**不会** —— 网关只绑 `127.0.0.1`，不监听对外网卡。

---

## 关于 WSL：不需要你手动开，双击就会自己拉起来

**先纠正一个常见误解：WSL 不会随电脑自动启动。**

本机实测证据（2026-10-01）：

| 事件 | 时间 |
|---|---|
| Windows 开机 | **09-28 12:02:23** |
| WSL 虚拟机创建（`vmmemWSL`） | **10-01 12:16:47** |
| Ubuntu 发行版 init | 10-01 12:16:50 |
| 该时刻发生了什么 | 你自己打开终端跑 `npx @deepseek-ai/dsh web` |

Windows 开机后 **3 天**里 WSL 一直是停的，直到有东西调用它才起来。
也没有任何自动机制：启动文件夹里只有 `ChatGPT (Codex).lnk` / `QQ.lnk`，
WSL 相关计划任务 **0 个**，Docker Desktop 未运行。

### 但这不影响你使用 —— `wsl.exe -d <发行版>` 会自动启动它

**实测确认**：拿另一个处于 `Stopped` 状态的发行版（`docker-desktop`）做对照实验：

```
启动前:  docker-desktop    Stopped
执行:    wsl.exe -d docker-desktop -- echo "AUTOSTART_OK"
输出:    AUTOSTART_OK
启动后:  docker-desktop    Running     ← 自动被拉起来了
```

所以流程是：

```
你双击「dsh-llm-gateway」
        │
        ├─ Windows 执行 scripts/windows/Start-Gateway.bat
        │
        ├─ wsl.exe -d Ubuntu-22.04 --cd ~/dsh-llm-gateway -- bash -lc "...ensure.sh"
        │       │
        │       └─ ★ WSL 若未运行 → 此刻自动启动（等十几秒）
        │
        ├─ ensure.sh 拉起守护进程 + 网关
        │
        └─ 浏览器打开 http://127.0.0.1:8790/
```

**结论：WSL 没启动时，双击快捷方式依然能用**，只是首次会多等十几秒（WSL 冷启动）。
不需要你先开一个 WSL 终端窗口。

> 我无法用 `wsl --shutdown` 做完整的端到端验证 —— 因为**我自己就跑在这个 WSL 里**，
> 执行它会把当前会话连同验证过程一起杀掉。所以上面用的是「另一个 Stopped 发行版」
> 的等价实验 + 时间线证据。这一条属于**推断而非直接实测**，如果你重启电脑后双击
> 快捷方式发现起不来，把现象告诉我。

### 关于开机自启（你已关闭）

你把自启关掉是对的 —— 反正 `wsl.exe` 会按需拉起 WSL，自启的收益只是"开机后立刻可用"，
代价是每次开机都占内存（WSL 虚拟机 + Node 进程，本机 `.wslconfig` 里 `memory=8GB` 是上限，
实际按需占用）。按需启动更划算。

想恢复的话，把 `scripts/windows/Autostart-Gateway.bat` 复制回启动文件夹即可：

```bash
cp ~/dsh-llm-gateway/scripts/windows/Autostart-Gateway.bat \
   ""$APPDATA/Microsoft/Windows/Start Menu/Programs/Startup/"dsh-llm-gateway-autostart.bat"
```

---

## 关于"需要常驻"：是的，做了两层保障

网关是一个**后台 HTTP 服务**，客户端（OpenCode / Cline / Cherry Studio…）连的是它，所以它必须一直活着。

### 第一层：守护进程（崩溃自动重启）

`dsh-llm-gateway` 快捷方式启动时，会同时拉起一个**守护进程**（`scripts/daemon.sh`）。
它不是直接跑网关，而是在一个循环里看护它：

```
守护进程 ──启动──▶ 网关（tsx src/main.ts）
   ▲                    │
   └──── 退出/崩溃 ──────┘  ← 5 秒后自动重启
```

杀掉网关本体后实测 **约 4–6 秒自动恢复**。

守护还会识别"秒退"（连续 5 次跑不到 10 秒就挂，通常是端口占用或配置错误），
这时会暂停 60 秒再重试，避免疯狂重启刷爆日志。

### 第二层：开机自动启动（可选，你已关闭）

原本已放入 Windows 启动文件夹（**你已删除，当前不生效**）：

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
  └─ dsh-llm-gateway-autostart.bat
```

开启后开机会**静默拉起服务**（不弹窗、不开浏览器）。想打开界面时再双击桌面那个快捷方式。

**不开也没关系**：双击桌面快捷方式时 `wsl.exe` 会按需把 WSL 和网关一起拉起来，
只是首次多等十几秒。见上文「关于 WSL」一节。

---

## 「停止」会关掉 WSL 吗？—— 不会，也不需要

你的两个判断都对：

**① `stop.sh` 不会关 WSL。** 它只结束属于本项目的两个进程（守护 + 网关本体），
完全不碰 WSL 虚拟机，也不碰任何其它程序。

**② 也不该关 WSL。** 同一个 WSL 里可能跑着别的东西（比如你现在这个 DSH 会话、
其它开发任务），`wsl --shutdown` 会把它们**全部**杀掉。所以本项目**任何脚本都不包含**
`wsl --shutdown`。

### WSL 什么时候会自己关？

WSL2 的虚拟机在所有发行版都空闲一段时间后由 Windows 回收。
这是**正常且安全**的 —— 下次双击快捷方式时 `wsl.exe` 会把它重新拉起来，网关随之启动。

所以：**不需要为了网关而维持 WSL 常驻**，也不需要手动管 WSL 的开关。

### 实测：停止后 WSL 与其它程序是否受影响

| 时刻 | 观察 |
|---|---|
| 停止前 | `distro init`（pid 1）启动于 **10-01 12:16:50** |
| 执行 | `bash scripts/stop.sh` |
| 停止后 | `distro init` **仍是 12:16:50** ← 没重启，WSL 没被关 |
| | 别的东西（DSH 会话）**仍在运行** |
| | 网关进程 **0 个**，`http=000`（已停） |

---

## ⚠️ 修过的两个真实缺陷（都与"停止"有关）

### 1. `stop.sh` 曾会误杀无关程序

**早期实现**：按「谁在监听 8790/3901-3904 就杀谁」。

**实测复现**（2026-10-01）：起一个 python 进程占住 `:3901`，再跑 `stop.sh` ——
**那个 python 进程被杀了**。这在别人机器上是灾难：同一端口完全可能被别的服务用着。

**已修**：改为**按进程身份识别** —— 只有命令行里出现本项目的绝对路径
（`<项目>/src/main.ts` 或 `<项目>/scripts/daemon.sh`）才会被停止。
复测同一场景：python 进程**存活**，脚本如实报告"网关未在运行"。

### 2. 守护进程收到 TERM 后不停

**早期实现**：`trap 'rm -f "$PIDFILE"; exit 0' TERM`。

**问题**：bash 在**前台等待子进程**时收到 TERM，trap 要等子进程结束后才执行；
而子进程（网关）不会自己结束 —— 于是 `stop.sh` 报「仍有进程未退出」、网关也没停。

**已修**：`trap` 改为先杀子进程（给 5 秒优雅退出，再 `-9` 兜底），
并用 `"$NODE_BIN" ... &` + `wait` 取代前台等待，使信号即时生效。
复测：`stop.sh` 一次干净停掉，无残留。

---

## 命令行方式（等价，喜欢终端就用这个）

```bash
bash ~/dsh-llm-gateway/scripts/start.sh    # 启动（幂等，已在跑就提示）
bash ~/dsh-llm-gateway/scripts/status.sh   # 查看状态
bash ~/dsh-llm-gateway/scripts/stop.sh     # 停止
```

`start.sh` 是幂等的：已经在跑时不会重复启动。

---

## 两个容易踩的坑（我已经在脚本里绕过了）

### 1. 从 Windows 启动时 Node 版本会错

**真实缺陷**（2026-10-01 实测并修复）：从 Windows 侧（快捷方式 / 开机启动项）
调用 WSL 时，interop 会注入 Windows 的 `PATH`，而 `bash -l` 又不一定加载 nvm ——
结果 `node` 解析到 **Windows 的 Node v22**，报：

```
Error: Cannot find module 'esbuild'
Require stack: \\wsl.localhost\Ubuntu-22.04\...\tsx\dist\register-*.cjs
```

（Windows Node 用 UNC 路径读 Linux 的 `node_modules`，必然失败。）

**修法**：`scripts/ensure.sh` 与 `scripts/daemon.sh` 顶部会**显式挑选 nvm 下
版本最高的 node** 并固定给子进程，同时用 `$NODE_BIN ./node_modules/tsx/dist/cli.mjs`
显式执行 tsx（不依赖 `.bin/tsx` 的 shebang）。可用 `DSH_GATEWAY_NODE` 覆盖。

### 2. 数据与日志在哪

| 内容 | 路径 |
|---|---|
| 配置 / 凭据 / 账号池 | `~/.dsh-llm-gateway/`（凭据文件权限 `0600`） |
| 运行日志 | `/tmp/dsh-llm-gateway.log` |
| 守护 pid | `/tmp/dsh-llm-gateway-daemon.pid` |

日志在 `/tmp` 下，**关机或 `wsl --shutdown` 后会清空**。想长期留存就把
`daemon.sh` 里的 `LOG=` 改成项目内路径。

---

## 客户端怎么接

| 方式 | baseURL | 模型 id |
|---|---|---|
| 单供应商 | `http://127.0.0.1:3901/v1`（buddy） | 裸名，如 `glm-5.3` |
| 聚合 | `http://127.0.0.1:8790/v1` | `供应商/模型`，如 `buddy/glm-5.3` |

要不要填 API Key？**默认不校验**，随便填一个即可（很多客户端必填）。
想加校验就在 `~/.dsh-llm-gateway/config.json` 给对应供应商加 `"accessToken": "你的令牌"`。

---

## 卸载／关闭自启

> 卸载本项目的任何操作都**不会**关掉 WSL，也不会影响 WSL 里的其它程序。

```bash
# 关掉开机自启（删掉启动文件夹里那个 bat）
rm ""$APPDATA/Microsoft/Windows/Start Menu/Programs/Startup/"dsh-llm-gateway-autostart.bat"

# 删除桌面快捷方式
rm "<你的桌面>"/dsh-llm-gateway*.lnk
```
