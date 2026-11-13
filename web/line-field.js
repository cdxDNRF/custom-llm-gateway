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
 * ⚠️ 网格比例要接近卡片宽高比（现在卡片约 380×380 见方，网格 72:48 = 1.5:1，
 * 配合采样时按短边铺满 + 正方形格子，标志不会变形）。
 *
 * 密度迭代（用户要求「动态粒子紧凑一点」）：
 *   40×30 → 56×34 → 72×48 → **60×60**
 *
 * ⚠️⚠️ **72×48 是错的**：那是 1.5:1 的宽幅网格，而折叠态卡片现在接近正方形
 * （380×380）。绘制时格子按「较小边」取正方形并居中 ⇒ 横向留出大片空白，
 * 标志看起来偏左（实测截图确认）。**正方形网格 60×60 与正方形卡片匹配**，
 * 铺满且不变形 —— 这也是示例页选 60×60 的原因（它的卡片是 0.70 竖向，
 * 但标志区本身是方的）。
 */
const GRID_W = 60
const GRID_H = 60
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
/**
 * 覆盖率/强度 → 四档线宽索引。
 *
 * ⚠️ 阈值**比原示例（0.12 / 0.42 / 0.89）整体下移**（2026-11-13）。
 *
 * 原示例量的是「白色标志在黑色底上的亮度」，填充区接近 1；
 * 而我们量的是 **alpha 覆盖率经过缩放后的值** —— 图标缩到 0.72 又经过
 * 8×8 平均，实心区域往往只到 0.6~0.9，套用原阈值会让**大片实心区掉到第 2 档**，
 * 观感「该粗的地方不够粗」。
 *
 * 现在的档位：极细（轮廓/抗锯齿）→ 细 → 中 → 粗（实心填充）。
 */
function bucketOf(value) {
  return value < 0.10 ? 0 : value < 0.34 ? 1 : value < 0.68 ? 2 : 3
}

/**
 * 从图标 data URI 采样出亮度表（**只读一次像素**）。
 *
 * @returns 长度 `COUNT` 的 Float32Array；图片加载失败时返回 `undefined`
 *          （卡片退化为纯噪声线场，不影响功能）。
 */
/**
 * 从图标采样出「亮度表 + 品牌主色」。
 *
 * ## 为什么顺带算主色
 *
 * 用户要求「动态 UI 改成彩色的，跟图标一致」。手写一张 id→颜色表会有两个问题：
 * ① 30 家要手抄，必然有错；② 图标换了颜色表不会跟着变。
 * ⇒ **直接从图标像素里算主色**，永远一致。
 *
 * 算法：对**非黑**（有内容的）像素做**饱和度加权平均** ——
 * 纯白/纯灰的图标（如 OpenCode 的灰标）会退化成中性灰，这是正确的
 * （它本来就没品牌色）。
 */
async function sampleIcon(src) {
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
  /**
   * 超采样倍数：每格取 SS×SS 像素**双线性平均**。
   *
   * ⚠️ 从 5 提到 **8**（2026-11-13）：图标尺寸差异极大（ZCode 32×32、
   * magicrew 128×128），32×32 的图标放大到 60 格网格时，5×5 采样会明显
   * 出现「有的格子全有、有的格子全空」的棋盘跳变 —— 用户看到的「小图标碎成点」
   * 就是这个。8×8 让每个格子拿到的覆盖率更平滑。
   */
  const SS = 8
  const sideW = GRID_W * SS
  const sideH = GRID_H * SS
  const scratch = document.createElement('canvas')
  scratch.width = sideW
  scratch.height = sideH
  const context = scratch.getContext('2d', { willReadFrequently: true })
  if (context === null) return undefined
  /**
   * ⚠️⚠️ **采样画布要留透明底，不能涂黑**（真实缺陷，2026-11-13）。
   *
   * 旧代码先 `fillRect` 涂纯黑再画图标，于是：
   * - 透明区域读出来是 `rgb(0,0,0)`，**与「图标本身是深黑」无法区分**
   * - 我们被迫用亮度当判据，深色图标因此被判成空白（标志出现大块缺口）
   *
   * 正确做法：**不涂底色**（canvas 默认全透明），让 alpha 通道保留图标的
   * 真实覆盖率。透明处 alpha=0、图形处 alpha=255、抗锯齿边缘是中间值。
   * 这样 alpha 就成了干净的「有没有图形」信号，与颜色深浅完全解耦。
   */
  // （刻意不 fillRect —— 透明底是这里的关键）
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
  /**
   * 放大位图时开最高质量的平滑 —— 小图标（32×32）放大到 480×480 的采样画布
   * 若用最近邻会出现方块锯齿，进而让 alpha 边缘一格一格地跳。
   */
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, (sideW - drawW) / 2, (sideH - drawH) / 2 + offsetY, drawW, drawH)

  const pixels = context.getImageData(0, 0, sideW, sideH).data
  const luminance = new Float32Array(COUNT)

  /**
   * ⚠️⚠️ **必须单独提 alpha 通道，不能只看亮度**（真实缺陷，2026-11-13 用户截图）。
   *
   * 我们先把采样画布涂成**纯黑**再画图标，所以透明区域读出来是 `rgb(0,0,0)`、
   * 亮度 0 —— 与「图标本身是深黑色」无法区分。后果：
   *
   * - 深色图标（Qoder 深蓝、ZCode 深绿）的**内部**被判成空白 ⇒ 标志出现缺口
   * - 边缘半透明像素亮度低 ⇒ 轮廓咔嚓成锯齿
   *
   * 正解：把 `alpha` 当「有没有图形」的判据，把 `luminance` 只当「这条线画多粗」。
   * 两者分工后，深色填充不再丢失，半透明边缘也能按覆盖率正确分档。
   */
  const coverage = new Float32Array(COUNT)

  /**
   * 主色累计：按「饱和度 × 亮度」加权。
   *
   * ⚠️ 权重用饱和度而不是纯平均：图标里常有大片白底/透明区，
   *    纯平均会把品牌色冲淡成灰。
   */
  let colorR = 0
  let colorG = 0
  let colorB = 0
  let colorWeight = 0
  for (let gy = 0; gy < GRID_H; gy += 1) {
    for (let gx = 0; gx < GRID_W; gx += 1) {
      let sum = 0
      let alphaSum = 0
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = Math.min(sideW - 1, gx * SS + sx)
          const py = Math.min(sideH - 1, gy * SS + sy)
          const index = (py * sideW + px) * 4
          // Rec. 709（与原示例一致）
          sum += (0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2]) / 255
          // alpha 即「该像素有多少是图形」（画布底色黑、图标叠上去后 alpha 保留原值）
          alphaSum += pixels[index + 3] / 255
        }
      }
      luminance[gy * GRID_W + gx] = sum / (SS * SS)
      coverage[gy * GRID_W + gx] = alphaSum / (SS * SS)

      // 主色：用该格的中心像素（省掉再循环一遍 5×5）
      const cx = Math.min(sideW - 1, gx * SS + Math.floor(SS / 2))
      const cy = Math.min(sideH - 1, gy * SS + Math.floor(SS / 2))
      const ci = (cy * sideW + cx) * 4
      const pr = pixels[ci] / 255
      const pg = pixels[ci + 1] / 255
      const pb = pixels[ci + 2] / 255
      const max = Math.max(pr, pg, pb)
      const min = Math.min(pr, pg, pb)
      // 饱和度（HSV 的 S）；纯黑/纯白/纯灰的 S 都是 0 ⇒ 权重 0，不影响主色
      const sat = max === 0 ? 0 : (max - min) / max
      const weight = sat * max
      if (weight > 0.02) {
        colorR += pr * weight
        colorG += pg * weight
        colorB += pb * weight
        colorWeight += weight
      }
    }
  }
  // 显式释放（原示例同款：把尺寸归零，让像素缓冲可回收）
  /**
   * ⚠️⚠️ **剥离「整块不透明底图」**（2026-11-13 第二次修正）。
   *
   * 图标有两类，alpha 覆盖比例相差 30 倍：
   *
   * | 类型 | 例子 | alpha 覆盖率 |
   * |---|---|---|
   * | 图形本身透明、只有标志不透明 | buddy 3% / cline 6% | 低 |
   * | **整块圆角底 + 白/亮色标志** | zcode **95%** / workbuddy 63% / monkeycode 43% | 高 |
   *
   * 第二类若直接用 alpha，整张卡被涂成实心方块 —— 标志反而消失（实测翻车）。
   * 故：**底图是靠「大面积同色」识别的**，用「该格亮度 vs 全图亮度中位数」的
   * 偏离度来压掉。标志（白字/亮图案）偏离大 ⇒ 保留；底（占多数）⇒ 压到 0。
   *
   * 只在「覆盖率中位数偏高」（确实有底图）时才这么做，避免误伤第一类图标。
   */
  {
    const values = []
    for (let i = 0; i < COUNT; i += 1) {
      if (coverage[i] > 0.5) values.push(luminance[i])
    }
    if (values.length > COUNT * 0.35) {
      // 有底图：取亮度中位数作为「底色」
      values.sort((a, b) => a - b)
      const base = values[Math.floor(values.length / 2)]
      for (let i = 0; i < COUNT; i += 1) {
        if (coverage[i] <= 0.5) continue
        /**
         * ⚠️⚠️ **必须用 `abs(delta)`，不能用 `(light - base)`**（2026-11-13 实测）。
         *
         * 底图与标志的明暗关系有**两种，方向相反**：
         *
         * | 图标 | 底 | 标志 | 只取「更亮」会怎样 |
         * |---|---|---|---|
         * | ZCode | 深色块 | 亮色 Z | ✅ 正确 |
         * | CodeBuddy | **浅色**块 | 深色云 | ❌ **标志被整片削掉** ⇒ 云变镂空缺口 |
         *
         * 用户截图 1 里 CodeBuddy 那个「明显缺口」正是这个原因 ——
         * 云的主体比白底**暗**，被 `light - base < 0` 判成"与底同色"压掉了。
         *
         * 正解：`Math.abs(delta)` —— 只要与底色有明显差异就是图形，
         * 不论更亮还是更暗。这样两种配色方向都能完整保留。
         */
        const delta = Math.abs(luminance[i] - base) * 2.2
        coverage[i] = Math.max(0, Math.min(1, delta < 0.16 ? 0 : delta))
      }
    }
  }

  /**
   * ⚠️ **实心图标的「轮廓化」**（2026-11-13）。
   *
   * 有些图标本身就是**纯色实心块**（TRAE 是 `fill="#32F08C"` 的方框 +
   * 两个菱形，没有任何镂空）。直接把覆盖率画成线 ⇒ 一整块实心方块，
   * 完全看不出是什么标志（用户截图 1 里 TRAE 卡就是那样）。
   *
   * 做法：对**填充率很高**的图标，把 coverage 转成「边缘图」——
   * 只保留轮廓与内部边界，中间的大片实心区域压淡。这类似图像处理里的
   * 边缘检测：`|coverage - 邻域平均|` 大的地方就是边界。
   *
   * 判据：实心覆盖率 > 55% 才做（避免误伤本来就是线条的图标）。
   */
  {
    /**
     * ⚠️ 判据不是「填充率 > 55%」—— 实测 TRAE 的填充率只有 **17.5%**
     *    （它是细边框 + 两个小菱形的组合，不是整体实心块），
     *    却依然画成了实心方块。真正决定「是否实心观感」的是
     *    **覆盖率的平均值**：实心图标 avgCov 会明显偏高。
     *
     * 实测：TRAE avgCov=0.181、Gemini 那种纯线条 avgCov<0.08。
     * 故阈值取 **0.14**（在两者之间）。
     */
    let filled = 0
    let covSum = 0
    for (let i = 0; i < COUNT; i += 1) {
      if (coverage[i] > 0.6) filled += 1
      covSum += coverage[i]
    }
    const fillRatio = filled / COUNT
    const avgCoverage = covSum / COUNT
    if (avgCoverage > 0.14 || fillRatio > 0.45) {
      const edged = new Float32Array(COUNT)
      for (let y = 0; y < GRID_H; y += 1) {
        for (let x = 0; x < GRID_W; x += 1) {
          const self = coverage[y * GRID_W + x]
          // 邻域平均（含自身，3×3）
          let sum = 0
          let n = 0
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              const nx = x + dx
              const ny = y + dy
              if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue
              sum += coverage[ny * GRID_W + nx]
              n += 1
            }
          }
          const avg = sum / n
          // 与邻域差异越大越像边界；同时保留自身强度做底（避免内部全黑）
          const edge = Math.abs(self - avg) * 2.4
          edged[y * GRID_W + x] = Math.min(1, edge + self * 0.18)
        }
      }
      coverage.set(edged)
    }
  }

  /**
   * **剔除孤立噪点**（2026-11-13）。
   *
   * 有些图标（尤其带底图的）会在角落残留零星亮点 —— 单独一个格子亮着，
   * 视觉上就是「标志旁边撒了几粒芝麻」。做法：一个格子的 3×3 邻域里
   * 有覆盖的邻居少于 2 个，就当噪点清掉（真实的线条/填充不会这么孤）。
   */
  {
    const cleaned = new Float32Array(coverage)
    for (let y = 0; y < GRID_H; y += 1) {
      for (let x = 0; x < GRID_W; x += 1) {
        if (coverage[y * GRID_W + x] <= 0.08) continue
        let neighbours = 0
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue
            if (coverage[ny * GRID_W + nx] > 0.08) neighbours += 1
          }
        }
        if (neighbours < 2) cleaned[y * GRID_W + x] = 0
      }
    }
    coverage.set(cleaned)
  }

  /**
   * **对 coverage 做一次 3×3 邻域平滑**（2026-11-13）。
   *
   * 目的：消掉「有的格子 0、相邻格子 1」的棋盘跳变 —— 那是小图标放大后
   * 最刺眼的观感问题（用户截图 2 的碎片感）。
   *
   * ⚠️ 只平滑 coverage（决定画不画、画多粗），**不动 luminance**
   *    （它只做微观深浅调节，平滑它没有收益）。
   * ⚠️ 权重 [1,2,1]² 的中心化卷积，总计 16 —— 轻微、不糊掉轮廓。
   */
  {
    const smoothed = new Float32Array(COUNT)
    for (let y = 0; y < GRID_H; y += 1) {
      for (let x = 0; x < GRID_W; x += 1) {
        let sum = 0
        let weight = 0
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue
            const w = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1)
            sum += coverage[ny * GRID_W + nx] * w
            weight += w
          }
        }
        smoothed[y * GRID_W + x] = sum / weight
      }
    }
    coverage.set(smoothed)
  }

  scratch.width = 0
  scratch.height = 0

  /** 主色（无彩色图标时返回 undefined，由调用方回退到主题色）。 */
  let accent
  if (colorWeight > 0) {
    let r = colorR / colorWeight
    let g = colorG / colorWeight
    let b = colorB / colorWeight
    /**
     * ⚠️⚠️ **必须提亮**（真实问题，2026-11-12 截图确认）。
     *
     * 图标主色往往偏暗（Qoder 的深蓝 `rgb(30,41,63)` 画在深色底上几乎看不见，
     * 实测三张卡里它最糊）。而线场是**细线**，比实心图标对亮度更敏感。
     *
     * 做法：把颜色往**高亮度方向**推 —— 保持色相，把最大分量拉到至少 0.85。
     * 这样深色的图标也能得到一条看得清的、同色相的线。
     */
    const max = Math.max(r, g, b)
    if (max > 0 && max < 0.85) {
      const scale = 0.85 / max
      r = Math.min(1, r * scale)
      g = Math.min(1, g * scale)
      b = Math.min(1, b * scale)
    }
    accent = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`
  }
  return { luminance, coverage, accent }
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
    /** 图标覆盖率（0..1，来自 alpha 通道）；见 sampleIcon 的注释。 */
    this.coverage = undefined
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
    const sampled = await sampleIcon(src)
    if (sampled !== undefined) {
      this.luminance = sampled.luminance
      /**
       * `coverage`（图标覆盖率，来自 alpha）与 `luminance`（明暗）**分工不同**：
       * - coverage 决定「这个格子该不该画线」以及基础粗细档位
       * - luminance 只做微观调节（同色系内部的深浅差异）
       *
       * 见 sampleIcon 里那段注释：只用亮度会把深色图标判成空白。
       */
      this.coverage = sampled.coverage
      // 主色来自图标本身 ⇒ 线与图标永远同色（用户要求「跟图标一致」）
      if (sampled.accent !== undefined) this.ink = sampled.accent
    }
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
    this.pointer.pulse *= Math.exp(-dt * 7.5)  // 衰减更快 = 更跟手

    /** 指针影响半径：四分之一绘图宽度（原示例口径）。 */
    const radius = Math.min(width, height) / 3  // 影响半径更大 = 更连贯
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
        const hasIcon = this.coverage !== undefined && this.luminance !== undefined
        /**
         * **两个取样上下相邻，拼成一条约两格高的竖线**（与原示例一致）。
         * 取「上格 + 下格」的平均值作为这条线代表的那片区域的属性。
         */
        const cov = hasIcon
          ? (this.coverage[gy * GRID_W + gx] + this.coverage[(gy + 1) * GRID_W + gx]) / 2
          : 0
        const light = hasIcon
          ? (this.luminance[gy * GRID_W + gx] + this.luminance[(gy + 1) * GRID_W + gx]) / 2
          : 0

        /**
         * ⚠️⚠️ **coverage 与 luminance 必须一起用，单用任何一个都会坏**（2026-11-13）。
         *
         * 这一步是本文件最容易写错的地方，两次都从截图上翻过车，记清楚：
         *
         * | 只用 | 后果 |
         * |---|---|
         * | **只看亮度**（旧版 `if (luminance < 0.045)`） | 深色图标填充区亮度低 ⇒ 判成空白 ⇒ **标志出现大块缺口**；半透明抗锯齿边缘也被啃掉 ⇒ **边缘锯齿** |
         * | **只看 alpha**（本轮的第一次尝试） | 带**整块不透明底图**的图标（实测 ZCode alpha 覆盖 95%、monkeycode 43%）⇒ **整张卡被涂满成实心方块**，标志反而消失 |
         *
         * 正解：**alpha 管「边界」、亮度管「内部结构」**：
         * - `cov` 低 ⇒ 这里确实没有图形（图标外的留白）⇒ 不画
         * - `cov` 高但 `light` 低 ⇒ 有图形且是深色填充 ⇒ **照样要画**（这正是旧版的缺口来源）
         * - `cov` 高且 `light` 高 ⇒ 亮色图形 ⇒ 画粗线
         *
         * 故取「覆盖率 × (亮度与一个下限的最大值)」：深色区域不会归零，
         * 而空白区域仍被 coverage 挡掉。
         */
        if (!hasIcon || cov < 0.06) continue

        /**
         * 内部结构信号：
         * - `cov` 提供「有图形」的基础量
         * - `light` 提供同色系内部的深浅层次
         *
         * ⚠️ 深色填充要保底：`Math.max(light, 0.35)` —— 否则 ZCode 那种
         *    深绿底（light≈0.1）会被压成接近 0，又回到「缺口」问题。
         */
        let signal = cov * (0.45 + Math.max(light, 0.35) * 0.75)

        // ── 缓慢下流的噪声（x: 列*0.15 + seed，y: 行*0.16 - 时间*0.17）──
        const noise = noiseAt(gx * 0.15 + this.seed, gy * 0.16 - this.time * 0.17)
        /** 噪声只做**轻微呼吸**，不能破坏轮廓。 */
        signal = signal * (0.94 + noise * 0.07)
        if (signal < 0.05) continue

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

        buckets[bucketOf(signal)].push(x, y0, y1)
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

    /*
     * ⚠️ 检测框已移除（2026-11-12，用户要求）。
     *
     * 用户原话：「这个蓝色小框框你不做动态的就没必要了，单独放有点丑」。
     * 它确实是示例页的卖点（「AI 检测标注」），但本项目里它只是个静态装饰框，
     * 既不随粒子流动也不算真实检测 —— 留着反而像「界面出错了」。
     * 上一轮又为了性能砍成单目标，视觉上更孤立，故整套删掉。
     */
  }

  /*
   * `drawCallouts()` 已移除（见 renderFrame 里的说明）：
   * 蓝色检测框是本项目里一个静态装饰，不随粒子流动、也不是真实检测，
   * 用户认为「单独放有点丑」，故整套删掉（连同 detection 配色参数）。
   */

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
