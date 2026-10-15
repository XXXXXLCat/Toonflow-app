/**
 * 图像基本调整（亮度 / 曝光 / 对比度 / 阴影 / 晕影 / 饱和度 / 暖色 / 淡色 / 清晰度…）
 *
 * 算法逐行移植自 @xdadda/mini-gl 的 `filterAdjustments` 与 `filterHighlightsShadows`
 * 两枚 GLSL 着色器（MIT License, github.com/xdadda/mini-gl）。着色器里的魔数
 * （saturation 的 0.213/0.715/0.072 亮度权重、vignette 的 inner .20 / outer 1.1 /
 * curvature .65、highlights 的 -0.76 与 -0.8 系数）全部照抄原值，不自行校准。
 *
 * 走的仍是 Canvas 2D 而非 WebGL：本只需要「面板预览 + 导出时算一次」，没必要为它
 * 往每个图片节点 UMD 里塞一个 WebGL2 运行时（nodeShared 会被打进每个节点包）。
 *
 * 像素在 **[0,1] 线性光**空间计算，与 mini-gl 的 sRGB 工作流一致：入口把 sRGB 解码成
 * 线性光，出口编码回去。内部必须用 Float32Array 中转——若拿 8bit ImageData 直接做
 * 换算，暗部会被量化吃掉，与原版 GPU 结果能差到 20~40 灰阶；换成 Float32 后平均偏差
 * 降到 1 个灰阶以内（实测见 .tmp-review/image-adjust-lib-research.md）。
 */

export interface ImageAdjustParams {
  /** 亮度：加法抬/压，暗部响应更明显。 */
  brightness: number;
  /** 曝光：乘法（近似 2^n），主要抬亮部、几乎不动暗部。 */
  exposure: number;
  /** 对比度：绕中灰 0.5 做 S 曲线。 */
  contrast: number;
  /** 高光：只动亮部。 */
  highlights: number;
  /** 阴影：只动暗部。 */
  shadows: number;
  /** 饱和度：整体彩度。 */
  saturation: number;
  /** 自然饱和度：保护已饱和区域，只推低饱和像素。 */
  vibrance: number;
  /** 暖色（色温）：R 升 B 降为暖。 */
  temperature: number;
  /** 淡色（色调）：绿-品红平衡。 */
  tint: number;
  /** 清晰度：十字卷积做局部对比，负值转高斯柔化。 */
  clarity: number;
  /** 晕影：中心不动，向边角渐次压暗。 */
  vignette: number;
}

export type ImageAdjustKey = keyof ImageAdjustParams;

/** 面板顺序与取值范围。 */
export const ADJUST_FIELDS: { key: ImageAdjustKey; label: string; min: number; max: number }[] = [
  { key: "brightness", label: "亮度", min: -1, max: 1 },
  { key: "exposure", label: "曝光", min: -1, max: 1 },
  { key: "contrast", label: "对比度", min: -1, max: 1 },
  { key: "highlights", label: "高光", min: -1, max: 1 },
  { key: "shadows", label: "阴影", min: -1, max: 1 },
  { key: "saturation", label: "饱和度", min: -1, max: 1 },
  { key: "vibrance", label: "自然饱和度", min: -1, max: 1 },
  { key: "temperature", label: "暖色", min: -1, max: 1 },
  { key: "tint", label: "淡色", min: -1, max: 1 },
  { key: "clarity", label: "清晰度", min: -1, max: 1 },
  { key: "vignette", label: "晕影", min: 0, max: 1 },
];

export function defaultImageAdjust(): ImageAdjustParams {
  return { brightness: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, saturation: 0, vibrance: 0, temperature: 0, tint: 0, clarity: 0, vignette: 0 };
}

export function isNoopImageAdjust(params: ImageAdjustParams): boolean {
  return ADJUST_FIELDS.every(field => params[field.key] === 0);
}

const clamp = (value: number, low: number, high: number) => (value < low ? low : value > high ? high : value);
const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/** GLSL smoothstep。 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** sRGB 编码值 → 线性光。 */
function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** 线性光 → sRGB 编码值。 */
function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

type Matrix4 = number[][];

const IDENTITY: Matrix4 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];

/** 4x4 行优先矩阵乘 left·right。 */
function multiplyMatrix(left: Matrix4, right: Matrix4): Matrix4 {
  const out: Matrix4 = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += left[row]![k]! * right[k]![column]!;
      out[row]![column] = sum;
    }
  }
  return out;
}

/**
 * 由各滑块值构造「颜色矩阵 + 加性偏移」。每个矩阵写成 4 行，对应的第 5 列（加性偏移）
 * 单独返回——着色器里它走的是 `(c * m) + o`，不参与后续矩阵乘。
 * 合并顺序与着色器完全一致：亮度 → 对比度 → 饱和度 → 曝光 → 暖色 → 淡色。
 */
function buildColorMatrix(params: ImageAdjustParams) {
  const brightness = params.brightness / 4;
  const contrast = (params.contrast + 1) / 2 + 0.5;
  const saturation = params.saturation + 1;
  const exposure = ((params.exposure > 0 ? params.exposure * 3 : params.exposure * 1.5) + 1) / 2 + 0.5;
  const x = params.temperature * 2;
  const tint = params.tint * 2;

  const brightnessMatrix: Matrix4 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const brightnessOffset = [brightness, brightness, brightness, 0];
  const contrastMatrix: Matrix4 = [[contrast, 0, 0, 0], [0, contrast, 0, 0], [0, 0, contrast, 0], [0, 0, 0, 1]];
  const contrastOffset = [0.5 * (1 - contrast), 0.5 * (1 - contrast), 0.5 * (1 - contrast), 0];
  const saturationMatrix: Matrix4 = [
    [0.213 + 0.787 * saturation, 0.715 - 0.715 * saturation, 0.072 - 0.072 * saturation, 0],
    [0.213 - 0.213 * saturation, 0.715 + 0.285 * saturation, 0.072 - 0.072 * saturation, 0],
    [0.213 - 0.213 * saturation, 0.715 - 0.715 * saturation, 0.072 + 0.928 * saturation, 0],
    [0, 0, 0, 1],
  ];
  const exposureMatrix: Matrix4 = [[exposure, 0, 0, 0], [0, exposure, 0, 0], [0, 0, exposure, 0], [0, 0, 0, 1]];
  // 暖色正负两套系数：加暖时只推 R、压 B；变冷时 G 也会微降（原着色器就是这么写的）。
  const temperatureMatrix: Matrix4 = x > 0
    ? [[1 + 0.1 * x, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1 - 0.1 * x, 0], [0, 0, 0, 1]]
    : [[1 + 0.15 * x, 0, 0, 0], [0, 1 + 0.05 * x, 0, 0], [0, 0, 1 - 0.15 * x, 0], [0, 0, 0, 1]];
  const tintMatrix: Matrix4 = [[1, 0, 0, 0], [0, 1 + 0.1 * tint, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];

  let matrix = IDENTITY;
  const offset = [0, 0, 0, 0];
  const chain: { matrix: Matrix4; offset?: number[] }[] = [
    { matrix: brightnessMatrix, offset: brightnessOffset },
    { matrix: contrastMatrix, offset: contrastOffset },
    { matrix: saturationMatrix },
    { matrix: exposureMatrix },
    { matrix: temperatureMatrix },
    { matrix: tintMatrix },
  ];
  for (const step of chain) {
    matrix = multiplyMatrix(matrix, step.matrix);
    if (step.offset) for (let i = 0; i < 4; i += 1) offset[i]! += step.offset[i]!;
  }
  return { matrix, offset };
}

/** 取邻域像素，越界坐标夹回图内（等价 GPU 的 clamp-to-edge 采样），避免出现黑边。 */
function pick(source: Float32Array, width: number, height: number, x: number, y: number, channel: number): number {
  const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
  const cy = y < 0 ? 0 : y >= height ? height - 1 : y;
  return source[(cy * width + cx) * 3 + channel]!;
}

function applyClarity(buffer: Float32Array, width: number, height: number, clarity: number) {
  const f = clarity;
  // 正值是十字锐化核，负值转为高斯柔化核（原着色器分两套）。
  const kernel = f >= 0
    ? [0, -f, 0, -f, 1 + 4 * f, -f, 0, -f, 0]
    : [-f, -2 * f, -f, -2 * f, 1 - 3 * f, -2 * f, -f, -2 * f, -f];
  let weight = kernel.reduce((sum, value) => sum + value, 0);
  if (weight <= 0) weight = 1;
  const snapshot = Float32Array.from(buffer);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        for (let ky = -1; ky <= 1; ky += 1) {
          for (let kx = -1; kx <= 1; kx += 1) {
            sum += pick(snapshot, width, height, x + kx, y + ky, channel) * kernel[(ky + 1) * 3 + (kx + 1)]!;
          }
        }
        buffer[target + channel] = clamp01(sum / weight);
      }
    }
  }
}

function applyHighlightsShadows(buffer: Float32Array, highlights: number, shadows: number) {
  // 着色器收到的是 (滑块值 + 1) 与 (滑块值 / 2 + 1)，中间值为 1 时这趟是恒等。
  const uHighlights = highlights + 1;
  const uShadows = shadows / 2 + 1;
  const whiteTarget = clamp(uHighlights, 0, 2) - 1;
  const blackTarget = 1 - clamp(uShadows, 0, 1);
  const shadowPower = 1 / uShadows;
  // highlights 满量程时 2 - uHighlights 为 0，指数为 Infinity：与原着色器保持一致，
  // 它会让 pow(1-lum, Inf) 收敛到 0，效果和「highlights 极强」语义吻合。
  const highlightPower1 = 1 / (2 - uHighlights);
  const highlightPower2 = 2 / (2 - uHighlights);
  for (let index = 0; index < buffer.length; index += 3) {
    const r = buffer[index]!;
    const g = buffer[index + 1]!;
    const b = buffer[index + 2]!;
    const luminance = 0.2125 * r + 0.7154 * g + 0.0721 * b;
    if (luminance <= 0) continue; // 纯黑像素在原着色器里会除零，直接跳过
    const shadow = clamp((luminance ** shadowPower + -0.76 * luminance ** (2 / uShadows)) - luminance, 0, 1);
    const highlight = clamp((1 - ((1 - luminance) ** highlightPower1 + -0.8 * (1 - luminance) ** highlightPower2)) - luminance, -1, 0);
    const scale = (luminance + shadow + highlight) / luminance;
    const contrasted = (luminance - 0.5) * 1.5 + 0.5;
    const whiteInterp = contrasted * contrasted * contrasted;
    const inverseContrasted = 1 - contrasted;
    const blackInterp = inverseContrasted * inverseContrasted * inverseContrasted;
    // mix(result, white, whiteInterp*whiteTarget) 后再 mix(..., black, blackInterp*blackTarget)
    const whiteBlend = whiteInterp * whiteTarget;
    const blackBlend = blackInterp * blackTarget;
    buffer[index] = (r * scale + (1 - r * scale) * whiteBlend) * (1 - blackBlend);
    buffer[index + 1] = (g * scale + (1 - g * scale) * whiteBlend) * (1 - blackBlend);
    buffer[index + 2] = (b * scale + (1 - b * scale) * whiteBlend) * (1 - blackBlend);
  }
}

/**
 * 就地按参数处理一张 ImageData。处理顺序严格照着色器 main()：
 * 清晰度 → gamma → 自然饱和度 → 颜色矩阵 → 晕影（高光 / 阴影是更早的独立一趟）。
 * gamma 未开放给用户，恒等于 1/(0+1)，故省略。
 */
export function applyImageAdjust(image: ImageData, params: ImageAdjustParams): ImageData {
  const { width, height, data } = image;
  if (isNoopImageAdjust(params)) return image;

  const count = width * height;
  const buffer = new Float32Array(count * 3);
  for (let pixel = 0, source = 0, target = 0; pixel < count; pixel += 1, source += 4, target += 3) {
    buffer[target] = srgbToLinear(data[source]! / 255);
    buffer[target + 1] = srgbToLinear(data[source + 1]! / 255);
    buffer[target + 2] = srgbToLinear(data[source + 2]! / 255);
  }

  if (params.highlights !== 0 || params.shadows !== 0) applyHighlightsShadows(buffer, params.highlights, params.shadows);
  if (params.clarity !== 0) applyClarity(buffer, width, height, params.clarity);

  const { matrix, offset } = buildColorMatrix(params);
  const vibrance = params.vibrance;
  const vignette = params.vignette;
  const hasVignette = vignette !== 0;
  const m00 = matrix[0]![0]!;
  const m01 = matrix[0]![1]!;
  const m02 = matrix[0]![2]!;
  const m10 = matrix[1]![0]!;
  const m11 = matrix[1]![1]!;
  const m12 = matrix[1]![2]!;
  const m20 = matrix[2]![0]!;
  const m21 = matrix[2]![1]!;
  const m22 = matrix[2]![2]!;
  const o0 = offset[0]!;
  const o1 = offset[1]!;
  const o2 = offset[2]!;

  for (let y = 0; y < height; y += 1) {
    const ny = (y + 0.5) * 2 / height - 1;
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 3;
      let r = buffer[target]!;
      let g = buffer[target + 1]!;
      let b = buffer[target + 2]!;

      if (vibrance !== 0) {
        const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const average = (r + g + b) / 3;
        const amount = Math.abs(max - average) * 2 * -vibrance;
        if (r !== max) r += (max - r) * amount;
        if (g !== max) g += (max - g) * amount;
        if (b !== max) b += (max - b) * amount;
      }

      // 三行必须都用变换前的 r/g/b，不能边算边覆盖。
      const nr = clamp01(m00 * r + m01 * g + m02 * b + o0);
      const ng = clamp01(m10 * r + m11 * g + m12 * b + o1);
      const nb = clamp01(m20 * r + m21 * g + m22 * b + o2);
      r = nr;
      g = ng;
      b = nb;

      if (hasVignette) {
        const nx = (x + 0.5) * 2 / width - 1;
        const curveX = Math.abs(nx) ** (1 / 0.65);
        const curveY = Math.abs(ny) ** (1 / 0.65);
        const edge = Math.sqrt(curveX * curveX + curveY * curveY) ** 0.65;
        const factor = 1 - vignette * smoothstep(0.20, 1.1, edge);
        r *= factor;
        g *= factor;
        b *= factor;
      }

      buffer[target] = r;
      buffer[target + 1] = g;
      buffer[target + 2] = b;
    }
  }

  for (let pixel = 0, source = 0, target = 0; pixel < count; pixel += 1, source += 3, target += 4) {
    data[target] = linearToSrgb(clamp01(buffer[source]!)) * 255;
    data[target + 1] = linearToSrgb(clamp01(buffer[source + 1]!)) * 255;
    data[target + 2] = linearToSrgb(clamp01(buffer[source + 2]!)) * 255;
  }
  return image;
}
