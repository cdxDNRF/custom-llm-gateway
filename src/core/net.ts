/**
 * 网络地址探测：实时列出本机可被局域网访问的 IPv4 地址。
 *
 * ## 为什么要单独一个模块
 *
 * 校园网 / 公司网的 IP 会变（DHCP 续租、换楼层、换热点都会变）。因此
 * **不能把地址算一次就缓存**——必须每次请求实时计算，否则用户看到的
 * 是个已经失效的地址，照着填进手机只会连不上（而且是"静默失效"：
 * 地址格式完全正常，只是没人应答，很难排查）。
 *
 * 启动日志（main.ts）与控制台接口（server.ts 的 /api/overview）共用
 * 这里的实现，保证两处显示的地址**永远一致**。
 */
import { networkInterfaces } from 'node:os'

/** 一个可用的局域网地址及其所属网卡。 */
export interface LanAddress {
  /** IPv4 地址，如 `10.198.81.112`。 */
  address: string
  /** 网卡名，如 `WLAN`。便于用户判断是不是自己要的那张网卡。 */
  iface: string
}

/**
 * 列出可用于局域网访问的 IPv4 地址。
 *
 * 过滤规则（每条都对应一类"看起来正常但连不上"的地址）：
 *   - `internal`（回环 127.0.0.1）—— 手机填了必然连不上
 *   - `169.254.*`（Link-local / APIPA）—— 没拿到 DHCP 时的自赋值地址，
 *     同网段其它设备通常无法路由到它
 *   - IPv6 与非 IPv4 家族 —— 手机端手填 IPv6 字面量体验太差，且多数
 *     客户端不认；这里只给 IPv4，避免用户困惑
 *
 * ⚠️ **不缓存**：每次调用都重新读 `networkInterfaces()`。校园网 IP 变化
 * 时，下一次轮询（前端 20 秒一次）就会自动显示新地址。
 *
 * ⚠️ 虚拟网卡（VMware / VirtualBox / Hyper-V / WSL 的 vEthernet）也会
 * 出现在结果里。这些地址填到手机上通常不通。这里**不主动过滤**：
 * 判断"哪个虚拟网卡是废的"没有可靠通用规则，宁可多列几个并显示网卡名，
 * 让用户自己挑（启动日志与控制台都带网卡名）。
 */
export function lanAddresses(): LanAddress[] {
  const result: LanAddress[] = []
  const seen = new Set<string>()
  for (const [iface, list] of Object.entries(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      if (info.address.startsWith('169.254.')) continue
      if (seen.has(info.address)) continue
      seen.add(info.address)
      result.push({ address: info.address, iface })
    }
  }
  return result
}

/** 只取地址字符串（启动日志打印用）。 */
export function lanAddressStrings(): string[] {
  return lanAddresses().map((entry) => entry.address)
}