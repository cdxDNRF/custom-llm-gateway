/**
 * 全部供应商的目录：id / 展示名 / 默认端口 / 默认开关 / 能力说明。
 *
 * 设计（用户要求）：**像 DSH 插件一样提供"供应商启动开关"** ——
 * 12 家全部在目录里登记，但新接入的默认 `enabled:false`（未登录也没必要占端口），
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
]

export function catalogEntry(id: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((e) => e.id === id)
}
