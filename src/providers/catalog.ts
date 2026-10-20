/**
 * 全部供应商的目录：id / 展示名 / 默认端口 / 默认开关 / 能力说明。
 *
 * 设计（用户要求）：**像 DSH 插件一样提供"供应商启动开关"** ——
 * 14 家全部在目录里登记，但新接入的默认 `enabled:false`（未登录也没必要占端口），
 * 用户在 Web 控制台点开关即可启用（写入 config.json 后下次启动生效）。
 *
 * 端口规划：3901 起连续分配，与既有四家保持不变。
 */
export interface ProviderCatalogEntry {
  id: string
  displayName: string
  defaultPort: number
  /** 默认是否启用（既有四家 true；新接入的 false，等用户开开关）。 */
  defaultEnabled: boolean
  /** 一句话说明（控制台显示）。 */
  note: string
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  { id: 'buddy',      displayName: 'CodeBuddy (腾讯)',      defaultPort: 3901, defaultEnabled: true,  note: '每日签到领积分，支持锁定永久积分' },
  { id: 'workbuddy',  displayName: 'WorkBuddy (国际版)',    defaultPort: 3902, defaultEnabled: true,  note: '余额可查；国际版无签到' },
  { id: 'trae',       displayName: 'TRAE (字节)',           defaultPort: 3903, defaultEnabled: true,  note: 'SOLO 免费额度通道' },
  { id: 'qoder',      displayName: 'Qoder',                 defaultPort: 3904, defaultEnabled: true,  note: '加密推理端点；每日 100 Credits' },
  { id: 'qodercn',    displayName: 'Qoder (中国版)',        defaultPort: 3905, defaultEnabled: false, note: '与 Qoder 同协议族，模型表不同' },
  { id: 'codearts',   displayName: 'CodeArts (华为云)',     defaultPort: 3906, defaultEnabled: false, note: 'IAM OAuth 登录；每日签到得积分' },
  { id: 'lobsterai',  displayName: 'LobsterAI (有道)',      defaultPort: 3907, defaultEnabled: false, note: '每日签到领积分' },
  { id: 'cline',      displayName: 'Cline',                 defaultPort: 3908, defaultEnabled: false, note: 'WorkOS 设备码登录；无签到' },
  { id: 'loomy',      displayName: 'Loomy (讯飞)',          defaultPort: 3909, defaultEnabled: false, note: '微信扫码登录；无自动续期' },
  { id: 'raccoon',    displayName: 'Raccoon (商汤)',        defaultPort: 3910, defaultEnabled: false, note: '本地页承载微信/短信登录' },
  { id: 'minimax',    displayName: 'MiniMax Code',          defaultPort: 3911, defaultEnabled: false, note: 'Anthropic Messages 协议；不支持图片输入' },
  { id: 'zcode',      displayName: 'ZCode (智谱)',          defaultPort: 3912, defaultEnabled: false, note: '每次请求需浏览器产 captcha；需设 ZCODE_CHROME_PATH' },
  { id: 'gemini',     displayName: 'Gemini (Google)',       defaultPort: 3913, defaultEnabled: false, note: 'OAuth 登录；需设 CMDC_PAK_GOOGLE_CLIENT_ID/SECRET' },
  { id: 'opencode',   displayName: 'OpenCode (Zen)',         defaultPort: 3914, defaultEnabled: true,  note: '匿名通道免登录；有 7 个免费模型，按账号可配代理出口' },
  { id: 'accio',      displayName: 'Accio (阿里)',           defaultPort: 3915, defaultEnabled: false, note: 'PKCE 登录 + 免签名推理（未测试稳定性）' },
  { id: 'officeace',  displayName: 'OfficeAce (果办)',       defaultPort: 3916, defaultEnabled: false, note: '多模态 + 自动领每日签到福利（未测试稳定性）' },
  // ⚠️ build 是**唯一需要浏览器参与**的渠道：它的上游是跑在 Google Cloud Run 上的
  //    AI Studio App，由你浏览器里的页面主动连回本网关。故默认关闭，且连接/断开是
  //    显式动作（见 Web UI 的「Build 渠道」页）。
  // ⚠️ aistudio 与 gemini 是**两条独立额度**的渠道：
  //    gemini = 反重力 OAuth（Antigravity 额度）
  //    aistudio = 普通 API Key（API Key 免费层额度）—— 门槛最低，一个 AIza 密钥即可
  { id: 'aistudio',   displayName: 'AI Studio (API Key)',   defaultPort: 3918, defaultEnabled: false, note: '填 AIza… 开头的 API Key 即可；额度与「Gemini (Google)」独立；需 Clash 代理' },
  { id: 'build',      displayName: 'Build (AI Studio)',     defaultPort: 3917, defaultEnabled: false, note: '【已被 aistudio2api 取代】需浏览器常开 App 页面；aistudio2api 同时覆盖 Playground+Build 且无需开页面' },
  // ⚠️ aistudio2api = **把 AIStudio2API 项目当作内部上游**（默认 127.0.0.1:2048）。
  //
  //    它把 AI Studio 的 **Playground 与 Build 两条独立额度通道**封装成标准
  //    OpenAI 兼容端点。那两条通道都需要 Cookie + SAPISID 签名 + **WAA/BotGuard
  //    proof**（要执行 Google 混淆过的 VM，上游项目为此写了 849 行文档并 fork
  //    goja）—— 自己重写不现实，故**融合而非重造**。
  //
  //    与其它 Gemini 系渠道的额度互相独立：
  //      gemini     = 反重力 OAuth（Antigravity 额度）
  //      aistudio   = 官方 API Key（API Key 免费层）
  //      build      = 自建 App 反代（Build 额度，需开页面）
  //      aistudio2api = **Playground + Build 双额度**（无需开页面）
  { id: 'aistudio2api', displayName: 'AI Studio (Web) Playground+Build', defaultPort: 3919, defaultEnabled: false, note: '融合 AIStudio2API：Playground+Build 两条独立额度、无需浏览器常开；需先自行启动 AIStudio2API（默认 127.0.0.1:2048）' },
]

export function catalogEntry(id: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((e) => e.id === id)
}
