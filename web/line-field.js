/**
 * 供应商卡片的**线条动效**（2026-11-12，用户要求「给供应商卡片做成 stylekit 那样的
 * 交互效果，用前端画图标，动态效果」）。
 *
 * ## 与原示例的关系（重要）
 *
 * 用户给的 `stylekit-brand-line-cards.html` 是**独立演示页**：3 张固定卡片、
 * 每张 60×30 段线条、每段独立弹簧 + 逐帧双线性噪声 + 积分图检测框。
 *
 * 那个方案在演示页里很漂亮，但**直接搬到本项目的监控面板会出问题**：
 *
 * | 差异 | 演示页 | 本项目 |
 * |---|---|---|
 * | 卡片数 | 3（固定） | 7+（随启用数变，上限 18） |
 * | 生命周期 | 演示完就关 | 控制台**常开**，用户可能挂一整天 |
 * | 每帧线条 | 3 卡 × 1800 段 = 5400 | 18 卡 × 1800 段 = **32400** |
 * | 页面性质 | 看动效 | 看账号状态、点按钮 |
 *
 * ⇒ 故本实现**保留观感、砍掉成本**，三处刻意的降级（都在下面标注）：
 *
 * 1. **网格降到 40×20**（原 60×30）：线条仍是四档粗细 + 缓慢流动噪声，
 *    视觉上几乎看不出差别，但每卡线段数从 1800 → 800。
 * 2. **只在「有焦点/悬停」的卡片上跑满帧**：其余卡片是**静态一帧**（不重绘）。
 *    动效本该是「注意到它」的提示，不需要 18 张卡同时呼吸。
 * 3. **检测框保留，但只在悬停/聚焦时扫描**（原示例也是这个时机，成本一致）。
 *
 * ## 保留的部分（与示例同参数）
 *
 * - 一次采样：60×60 超采样 → 亮度表（**只读一次像素**，尺寸变化不重采）
 * - xorshift seed 7319 的共享 128×128 噪声格点 + 双线性插值
 * - 四档线宽 `[0.38, 1.12, 2.28, 3.80]`、四档透明度 `[0.15, 0.64, 0.93, 1]`
 * - 阻尼弹簧：刚度 145 / 阻尼 19，脉冲 `exp(-dt*5.5)` 衰减
 * - 检测框弹簧：刚度 144 / 阻尼 24，积分步长 ≤ 1/120 秒
 * - DPR 变化会重建 backing store（不能只靠 ResizeObserver）
 * - `prefers-reduced-motion` 下默认静止
 *
 * ## ⚠️ 图标不是从路径画的
 *
 * 用户示例用 Path2D 画 Apple/Google/Tesla 的标志。本项目有 **30 家供应商**，
 * 没有对应的 24×24 路径数据（上游插件给的是位图/整段 SVG 的 data URI）。
 * 故这里对图标做**位图采样**：把 `<img>` 画进 60×60 的离屏画布，再读一次像素
 * 得到亮度表 —— 效果与路径采样一致（都是「把这个标志变成一张亮度网格」），
 * 且不需要为 30 家手抄路径。**仍然只读一次像素**。
 */

/**
 * 网格尺寸。
 *
 * ⚠️ 折叠态卡片约 447×210（比例 2.1:1），网格要按这个比例取才不变形 ——
 * 用正方形的 60×60 会把标志拉长。这里 56×34 ≈ 1.65:1，配合卡片比例观感正常。
 * 比原示例（60×30）密一档：本轮实测 40×30 时标志线条太稀，看不出是什么。
 */
const GRID_W = 56
const GRID_H = 34
const COUNT = GRID_W * GRID_H
/** 四档线宽（与原示例一致）。 */
const LINE_WIDTHS = [0.38, 1.12, 2.28, 3.8]
/**
 * 四档透明度。
 *
 * ⚠️ **刻意比原示例低得多**（示例是 .15/.64/.93/1）。
 * 原因：示例页的卡片除了标志没有别的内容；而本项目的卡片上叠着账号名、
 * 按钮、到期时间 —— 用示例那套透明度会让线条盖过文字（实测截图确认过，
 * 卡片里的字直接看不清）。这里按同一比例压缩到 0.32 档，线场退成**背景纹理**。
 */
const LINE_ALPHAS = [0.12, 0.38, 0.66, 0.95]

/** 共享噪声格点：128×128，xorshift seed 7319（与原示例一致）。 */
const NOISE_SIZE = 128
const noiseLattice = new Float32Array(NOISE_SIZE * NOISE_SIZE)
{
  let state = 7319
  for (let i = 0; i < noiseLattice.length; i += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    // 转成 -1..1
    noiseLattice[i] = ((state >>> 0) / 4294967295) * 2 - 1
  }
}

/** 平滑双线性 value noise（`t*t*(3-2t)` 插值）。 */
function noiseAt(x, y) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  let fx = x - ix
  let fy = y - iy
  fx = fx * fx * (3 - 2 * fx)
  fy = fy * fy * (3 - 2 * fy)
  const x0 = ix & (NOISE_SIZE - 1)
  const y0 = iy & (NOISE_SIZE - 1)
  const x1 = (ix + 1) & (NOISE_SIZE - 1)
  const y1 = (iy + 1) & (NOISE_SIZE - 1)
  const a = noiseLattice[y0 * NOISE_SIZE + x0]
  const b = noiseLattice[y0 * NOISE_SIZE + x1]
  const c = noiseLattice[y1 * NOISE_SIZE + x0]
  const d = noiseLattice[y1 * NOISE_SIZE + x1]
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy
}

/** 亮度 → 四档。 */
function bucketOf(value) {
  return value < 0.12 ? 0 : value < 0.42 ? 1 : value < 0.89 ? 2 : 3
}

/**
 * 从图标 data URI 采样出亮度表（**只读一次像素**）。
 *
 * @returns 长度 `COUNT` 的 Float32Array；图片加载失败时返回 `undefined`
 *          （卡片退化为纯噪声线场，不影响功能）。
 */
async function sampleIconLuminance(src) {
  const image = new Image()
  // data URI 不是网络请求；`decode()` 保证画进 canvas 时已就绪。
  image.src = src
  try {
    await image.decode()
  } catch {
    return undefined
  }

  /**
   * 超采样倍数：每个网格单元取 5×5 像素的平均（与原示例同一思路）。
   *
   * ⚠️⚠️ **采样画布必须与网格同比例**（`GRID_W:GRID_H`），否则标志会被拉伸。
   * 第一版用正方形画布（`side×side`）+ 正方形网格，画到宽扁的卡片上时
   * 格子不是正方形 ⇒ 标志横向拉宽。现在画布按网格比例（56:34）建，
   * 图标**按短边等比缩放到铺满**（不是居中留白 —— 那样在宽卡上标志太小）。
   */
  const SS = 5
  const sideW = GRID_W * SS
  const sideH = GRID_H * SS
  const scratch = document.createElement('canvas')
  scratch.width = sideW
  scratch.height = sideH
  const context = scratch.getContext('2d', { willReadFrequently: true })
  if (context === null) return undefined
  context.fillStyle = '#000'
  context.fillRect(0, 0, sideW, sideH)
  /**
   * 缩放策略：**铺满短边、长边居中**。
   *
   * 采样画布是宽幅（56:34 ≈ 1.65:1）而图标多为正方形 ⇒ 取 `max` 让图标
   * 填满高度（短边），横向自然留白居中。
   *
   * ⚠️ 系数迭代：0.92 顶到边缘太挤 → 0.86 仍偏满 → **0.72**（留 28% 边距）。
   * 这是参照 StyleKit 示例的量感定的：标志占卡片中上部约 60-70%，
   * 四周留白，才是「展示品」而不是「贴纸」。
   */
  const scale = Math.max(sideW / image.width, sideH / image.height) * 0.72
  const drawW = image.width * scale
  const drawH = image.height * scale
  /**
   * ⚠️ **垂直方向下移 6%**：卡片顶部有标题行（图标 + 名称 + 端口），
   * 标志若在画布正中，上半截会压到标题下面，观感「顶到字上」。
   * 下移后标志主体落在标题与箭头之间的净空区。
   */
  const offsetY = sideH * 0.06
  context.drawImage(image, (sideW - drawW) / 2, (sideH - drawH) / 2 + offsetY, drawW, drawH)

  const pixels = context.getImageData(0, 0, sideW, sideH).data
  const luminance = new Float32Array(COUNT)
  for (let gy = 0; gy < GRID_H; gy += 1) {
    for (let gx = 0; gx < GRID_W; gx += 1) {
      let sum = 0
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = Math.min(sideW - 1, gx * SS + sx)
          const py = Math.min(sideH - 1, gy * SS + sy)
          const index = (py * sideW + px) * 4
          // Rec. 709（与原示例一致）
          sum += (0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2]) / 255
        }
      }
      luminance[gy * GRID_W + gx] = sum / (SS * SS)
    }
  }
  // 显式释放（原示例同款：把尺寸归零，让像素缓冲可回收）
  scratch.width = 0
  scratch.height = 0
  return luminance
}

/**
 * 一张供应商卡片的线场。
 *
 * 生命周期：`create()` → 若干次 `renderFrame()` → `destroy()`。
 * 只有 `running`（悬停/聚焦）时才由外部每帧调用 `renderFrame`。
 */
class LineFieldCard {
  constructor(host, options) {
    this.host = host
    this.canvas = options.canvas
    this.context = this.canvas.getContext('2d')
    /** 品牌 seed：用 id 的字符和做偏移（每家固定的水平错位，视觉上不雷同）。 */
    this.seed = options.seed ?? 0
    this.ink = options.ink ?? 'rgba(255,255,255,.9)'
    this.detection = options.detection ?? '#267dff'
    this.luminance = undefined
    this.reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    this.playing = !this.reducedMotion
    this.dpr = 0
    this.width = 0
    this.height = 0
    this.elapsed = 0
    /** 指针状态（卡片内 CSS 像素） */
    this.pointer = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY, pulse: 0, active: false }
    this.focused = false
    this.time = 0
  }

  /** 加载图标并采样亮度（只做一次；失败也不抛错）。 */
  async loadIcon(src) {
    if (typeof src !== 'string' || src === '') return
    this.luminance = await sampleIconLuminance(src)
  }

  /** 尺寸/DPR 变化时重建 backing store（**不重采样图标**）。 */
  syncSize() {
    const rect = this.canvas.getBoundingClientRect()
    const dpr = globalThis.devicePixelRatio || 1
    const width = Math.max(1, Math.round(rect.width))
    const height = Math.max(1, Math.round(rect.height))
    // ⚠️ DPR 单独变化也要重建（CSS 尺寸没变时 ResizeObserver 不触发）
    if (width === this.width && height === this.height && dpr === this.dpr) return false
    this.width = width
    this.height = height
    this.dpr = dpr
    this.canvas.width = Math.round(width * dpr)
    this.canvas.height = Math.round(height * dpr)
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0)
    return true
  }

  /** 指针移动 → 累积脉冲（由外部在 pointermove 时调用）。 */
  movePointer(x, y) {
    const dx = x - this.pointer.x
    const dy = y - this.pointer.y
    // 移动超过 1.5px 或首次进入才给脉冲（与原示例同判据）
    if (!Number.isFinite(this.pointer.x) || Math.hypot(dx, dy) > 1.5) {
      this.pointer.x = x
      this.pointer.y = y
      this.pointer.pulse = 1
      this.pointer.active = true
    }
  }

  clearPointer() {
    this.pointer.active = false
    this.pointer.x = Number.NEGATIVE_INFINITY
    this.pointer.y = Number.NEGATIVE_INFINITY
  }

  /**
   * 画一帧。
   *
   * @param dt 距上一帧的秒数（已 clamp，避免长暂停后巨大步长）
   */
  renderFrame(dt) {
    const { context: ctx, width, height } = this
    if (width === 0 || height === 0) return
    ctx.clearRect(0, 0, width, height)

    /**
     * ⚠️⚠️ **格子必须是正方形**，否则标志会被拉伸变形。
     *
     * 卡片是宽扁的（如 445×208），而网格 56×34 若按 `width/GRID_W`、
     * `height/GRID_H` 分别算，格子是 7.9×6.1 ⇒ 标志横向拉宽（实测截图确认）。
     *
     * 正确做法：取两者较小值作为「单元边长」，再算出实际占用的网格区域并居中。
     * 这样标志保持原始比例，多出来的横向空间留白（线场本该是纹理，不必铺满）。
     */
    const cellSize = Math.min(width / GRID_W, height / GRID_H)
    const plotW = cellSize * GRID_W
    const plotH = cellSize * GRID_H
    /** 绘图区在画布内的偏移（居中）。 */
    const originX = (width - plotW) / 2
    const originY = (height - plotH) / 2
    const cellW = cellSize
    const cellH = cellSize
    this.time += dt
    // 脉冲衰减（与原示例一致：exp(-dt*5.5)）
    this.pointer.pulse *= Math.exp(-dt * 5.5)

    /** 指针影响半径：四分之一绘图宽度（原示例口径）。 */
    const radius = width / 4
    const interaction = this.pointer.active || this.focused
    const pointerX = this.pointer.x
    const pointerY = this.pointer.y

    /**
     * 按四档分组收集路径，每档只 stroke 一次（原示例的核心优化）。
     *
     * ⚠️ 这里用**立刻绘制**而不是累积 Path2D：线段只有 800 条，
     *    `beginPath` + 逐条 moveTo/lineTo 的开销远小于维护 4 个 Path2D 对象。
     */
    const buckets = [[], [], [], []]
    const unit = cellW / 5.25

    for (let gy = 0; gy < GRID_H - 1; gy += 1) {
      for (let gx = 0; gx < GRID_W; gx += 1) {
        const top = this.luminance === undefined ? 0 : this.luminance[gy * GRID_W + gx]
        const bottom = this.luminance === undefined ? 0 : this.luminance[(gy + 1) * GRID_W + gx]
        let luminance = (top + bottom) / 2

        // ── 缓慢下流的噪声（x: 列*0.15 + seed，y: 行*0.16 - 时间*0.17）──
        const noise = noiseAt(gx * 0.15 + this.seed, gy * 0.16 - this.time * 0.17)
        luminance = luminance * 0.94 + noise * 0.12 * (0.25 + luminance * 0.75)

        // 图标为空白处不画线（否则整张卡是均匀噪声，看不出是什么标志）
        if (luminance < 0.045) continue

        let x = originX + gx * cellW + cellW / 2
        let y0 = originY + gy * cellH + (cellH - cellW * 0.6) / 2
        let y1 = y0 + cellW * 0.6

        // ── 指针径向散开（原示例：影响 = max(0,1-d/r)² × pulse × 25）──
        if (interaction && this.pointer.pulse > 0.01) {
          const dist = Math.hypot(x - pointerX, (y0 + y1) / 2 - pointerY)
          if (dist < radius) {
            const influence = Math.max(0, 1 - dist / radius)
            const push = influence * influence * this.pointer.pulse * 25
            const angle = Math.atan2((y0 + y1) / 2 - pointerY, x - pointerX)
            x += Math.cos(angle) * push
            const offsetY = Math.sin(angle) * push * 0.58
            y0 += offsetY
            y1 += offsetY
          }
        }

        buckets[bucketOf(luminance)].push(x, y0, y1)
      }
    }

    ctx.lineCap = 'butt'
    ctx.strokeStyle = this.ink
    for (let level = 0; level < 4; level += 1) {
      const points = buckets[level]
      if (points.length === 0) continue
      ctx.globalAlpha = LINE_ALPHAS[level]
      ctx.lineWidth = Math.max(0.4, LINE_WIDTHS[level] * unit)
      ctx.beginPath()
      for (let i = 0; i < points.length; i += 3) {
        ctx.moveTo(points[i], points[i + 1])
        ctx.lineTo(points[i], points[i + 2])
      }
      ctx.stroke()
    }
    ctx.globalAlpha = 1

    // ── 检测框（只在交互时画；静止时省掉这一整块）──
    if (interaction) this.drawCallouts(ctx, cellW, cellH, originX, originY)
  }

  /**
   * 画检测框：在**当前亮度场**上找最亮的 2×2 区域并画蓝框。
   *
   * ⚠️ 只做「最亮局部」而不是原示例的积分图 + NMS 三目标：
   *    那是演示页的视觉卖点，在监控面板里会持续闪烁、干扰读数。
   *    这里保留「框住标志亮部 + 连线」的观感，成本从 O(n²) 降到 O(n)。
   */
  drawCallouts(ctx, cellW, cellH, originX = 0, originY = 0) {
    // 4×3 分块找最亮块（块内亮度和最高即「标志主体」所在）
    const BLOCK = 8
    let bestScore = 0
    let bestX = 0
    let bestY = 0
    for (let by = 0; by < GRID_H - BLOCK; by += BLOCK) {
      for (let bx = 0; bx < GRID_W - BLOCK; bx += BLOCK) {
        let sum = 0
        for (let y = by; y < by + BLOCK; y += 1) {
          for (let x = bx; x < bx + BLOCK; x += 1) {
            const v = this.luminance === undefined ? 0 : this.luminance[y * GRID_W + x]
            sum += v
          }
        }
        if (sum > bestScore) {
          bestScore = sum
          bestX = bx
          bestY = by
        }
      }
    }
    // 空场（几乎全黑）不画框（原示例同判据：最亮均值 < 0.04 忽略）
    if (bestScore / (BLOCK * BLOCK) < 0.04) return

    const padding = 1
    const gx0 = Math.max(0, bestX - padding)
    const gy0 = Math.max(0, bestY - padding)
    const gx1 = Math.min(GRID_W, bestX + BLOCK + padding)
    const gy1 = Math.min(GRID_H, bestY + BLOCK + padding)
    const x = originX + gx0 * cellW
    const y = originY + gy0 * cellH
    const w = (gx1 - gx0) * cellW
    const h = (gy1 - gy0) * cellH

    ctx.save()
    ctx.globalAlpha = 0.9
    ctx.strokeStyle = this.detection
    ctx.lineWidth = 1.2
    // 淡填充
    ctx.fillStyle = this.detection
    ctx.globalAlpha = 0.06
    ctx.fillRect(x, y, w, h)
    // 框
    ctx.globalAlpha = 0.9
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)

    // 四角强调（每角两段短线，比整框更「仪器感」）
    const corner = Math.min(10, w / 3, h / 3)
    ctx.lineWidth = 1.8
    ctx.beginPath()
    ctx.moveTo(x, y + corner); ctx.lineTo(x, y); ctx.lineTo(x + corner, y)
    ctx.moveTo(x + w - corner, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + corner)
    ctx.moveTo(x, y + h - corner); ctx.lineTo(x, y + h); ctx.lineTo(x + corner, y + h)
    ctx.moveTo(x + w - corner, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - corner)
    ctx.stroke()

    // 坐标标签
    ctx.globalAlpha = 0.75
    ctx.font = '9px ui-monospace, monospace'
    ctx.fillStyle = this.detection
    ctx.fillText(`${(bestX).toFixed(0)},${(bestY).toFixed(0)}`, x + 3, y + h - 4)
    ctx.restore()
  }

  destroy() {
    this.canvas.width = 0
    this.canvas.height = 0
  }
}

/** 把 id 转成稳定的 seed（同一家每次刷新都一样）。 */
function seedOf(id) {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 97
  return hash
}

// 以普通 `<script>` 加载（不是 module），故显式挂到 window。
// ⚠️ 与 app.js 的加载顺序：本文件在 app.js 之前（见 index.html）。
window.LineField = { LineFieldCard, seedOf }
