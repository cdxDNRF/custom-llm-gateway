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
  /**
   * **上游已不可用 ⇒ 从界面上隐藏**（2026-11-13）。
   *
   * ⚠️ 与 `defaultEnabled: false` 不同：那个是「还没开」，这个是「开了也没用」。
   *    对这类渠道**保留全部代码**（上游恢复时改一个布尔即可回来），
   *    只是不在 UI 上出现 —— 免得用户点了开关、配了 App 链接、最后只拿到 400。
   */
  hidden?: boolean
  /** 隐藏原因（仅开发/诊断用，不进界面）。 */
  hiddenReason?: string
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
  /**
   * ⚠️⚠️ **渠道身份是「Gemini Code Assist」，不是 Antigravity**（2026-11-14 订正）。
   *
   * 之前的注释与内部叫法写成「反重力 / antigravity / agy」—— 那是**错的**：
   *
   * | 依据 | 事实 |
   * |---|---|
   * | 上游端点 | `daily-cloudcode-pa.googleapis.com` = **Cloud Code Assist** |
   * | 账号规格 | `loadCodeAssist` 返回 `currentTier`（本账号 = Pro） |
   * | 配额池 | `Gemini Models` / `Claude and GPT models`（Code Assist 的分组） |
   * | vendor 源码 | `vendor/src/gemini-adapter.ts` 首行即写「Gemini（Cloud Code Assist）」 |
   *
   * `antigravity` **只是我们伪装用的 header/UA 值**（`x-client-name` 等），
   * 不是这个渠道的身份。把两者混为一谈会让人误以为这里有 Antigravity 的额度，
   * 进而误判「为什么没有 gemini-4-* 模型」。
   *
   * 这也解释了此前的疑问：`gemini-4-hydrogen` 在本渠道**没有**，因为它属于
   * **Vertex 后端**的模型表（我们的 `vertex` 渠道有）；Code Assist 的
   * `fetchAvailableModels` 只返回 12 个基础族。
   */
  { id: 'gemini',     displayName: 'Gemini Code Assist',   defaultPort: 3913, defaultEnabled: false, note: 'OAuth 登录（Google 账号）；Cloud Code Assist 后端；需设 CMDC_PAK_GOOGLE_CLIENT_ID/SECRET' },
  { id: 'opencode',   displayName: 'OpenCode (Zen)',         defaultPort: 3914, defaultEnabled: true,  note: '匿名通道免登录；有 7 个免费模型，按账号可配代理出口' },
  { id: 'accio',      displayName: 'Accio (阿里)',           defaultPort: 3915, defaultEnabled: false, note: 'PKCE 登录 + 免签名推理（未测试稳定性）' },
  { id: 'officeace',  displayName: 'OfficeAce (果办)',       defaultPort: 3916, defaultEnabled: false, note: '多模态 + 自动领每日签到福利（未测试稳定性）' },
  // ⚠️ build 是**唯一需要浏览器参与**的渠道：它的上游是跑在 Google Cloud Run 上的
  //    AI Studio App，由你浏览器里的页面主动连回本网关。故默认关闭，且连接/断开是
  //    显式动作（见 Web UI 的「Build 渠道」页）。
  // ⚠️ aistudio 与 gemini 是**两条独立额度**的渠道：
  //    gemini = OAuth 登录（Gemini Code Assist 额度）
  //    aistudio = 普通 API Key（API Key 免费层额度）—— 门槛最低，一个 AIza 密钥即可
  { id: 'aistudio',   displayName: 'AI Studio (API Key)',   defaultPort: 3918, defaultEnabled: false, note: '填 AIza… 开头的 API Key 即可；额度与「Gemini (Google)」独立；需 Clash 代理' },
  /**
   * ⚠️⚠️ **Build 渠道已被上游关停**（2026-11-13 实测确认）。
   *
   * 全部模型（3.1/3.5/3.8-flash、gemma-4-31b）调用都返回：
   * ```
   * HTTP 400 PROXY_GENERATION_DISABLED: generateContent is not supported
   * ```
   * 这是 Google 在服务端关掉了「经 AI Studio App 代理生成」的能力，
   * 不是我们的接线问题 —— 连上了（connected=true）也转发不出去（relays=0）。
   *
   * 故从界面隐藏：代码全部保留，上游若恢复把 `hidden` 去掉即可。
   */
  {
    id: 'build', displayName: 'Build (AI Studio)', defaultPort: 3917, defaultEnabled: false,
    note: '需浏览器常开 AI Studio App 页面（上游已停用该能力）',
    hidden: true,
    hiddenReason: 'PROXY_GENERATION_DISABLED: generateContent is not supported（2026-11-13 实测，全部模型）',
  },
  // ⚠️ vertex 是**第三条 Google 渠道**，与前两条的差别是「协议 + 认证」：
  //    gemini   = OAuth + `/v1internal:*`（Code Assist 私有协议）
  //    aistudio = API Key        + `generativelanguage`
  //    vertex   = 服务账号 OAuth + **OpenAI 兼容端点** `/endpoints/openapi`
  //    ⇒ 三者额度池互不相同；vertex 的模型表也最宽（含 gemini-4-argon/carbon）
  { id: 'vertex',     displayName: 'Vertex AI (GCP)',       defaultPort: 3919, defaultEnabled: false, note: '粘贴 GCP Service Account JSON；走 OpenAI 兼容端点；含 gemini-4-argon；需 Clash 代理' },
]

export function catalogEntry(id: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((e) => e.id === id)
}
