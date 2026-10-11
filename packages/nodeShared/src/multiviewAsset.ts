import { z } from "@toonflow/nodes-scaffold/runtime";
import { MULTIVIEW_ONE_HEAD_REF, MULTIVIEW_THREE_HEADS_REF, MULTIVIEW_TWO_HEADS_REF } from "./multiviewAssetRefs";

/**
 * 制作资产：把一张 9:16 竖版单人图转成一张横版「多角度分段板」。
 *
 * 与「多角度」的区别（两处功能都在图像节点上，不要混淆）：
 * - 多角度（imageMultiAngle.ts）：绕相机环绕，**出一张新视角的单图**，用方位角/俯仰角/距离
 *   三个连续参数描述一个机位；
 * - 制作资产（本文件）：「出一张板」，板内视图数量与排布由版式写死，没有可调机位——
 *   用户只需选版式与输出设置。
 *
 * 版式（左右两段，左段三格固定，右段按版式 1/2/3 格）：
 * - 左段约占 3/4 画幅，三个等宽竖栏放**无头躯干与完整背面**（正面无头躯干 / 严格 90° 左侧
 *   无头躯干 / 完整背面全身）；
 * - 右段约占 1/4 画幅，放**脸与颈**。**右段格数由用户选，这是本功能唯一的结构变量**：
 *   一个头（单格大特写）/ 两个头（正脸 + 严格左侧）/ 三个头（正脸 + 45° 右三分之四 + 严格左侧）。
 *
 * 左栏刻意无头是分段式设计：躯干要占满竖栏高度才看得清领口、肩线、袖长、腰线、衣摆、靴筒，
 * 头部信息由右段完整承接。判据是「两段合看头身信息都不缺即合规」。
 *
 * **画幅跟着版式走**（不是写死一个全局比例）：右段格数越多、整板越方。
 * 单头一格竖长大脸 → 16:9；双头/三头两三个横栏 → 4:3。三张引导图的原图比例即如此。
 *
 * 提示词骨架（用户给定的结构，逐段对应，不要打散）：
 * ```
 * Generate a professional multi-view character asset reference sheet on a <画幅> canvas.
 *   <两张参考图分工：身份取自 <image1>，<image2> 只当版式/取景参考>
 *   <身份一致性 + 姿态>
 * **Left Section — approx. <左段宽> of the frame width**
 * - Layout: three equally sized vertical full-body panels, arranged side by side from left to right, ...
 * - Panel L1: ...
 * - Panel L2: ...
 * - Panel L3: ...
 * **Right Section — approx. <右段宽> of the frame width**
 * - Layout: <右段排布句>
 * - Panel R1: ...
 * - Panel R2: ...（双头/三头才有）
 * - Panel R3: ...（仅三头）
 * **Global Requirements**
 * - The head absent from the Left Section is the identical head shown in the Right Section at the corresponding angle.
 * - Use a clean white background, even soft studio lighting, and thin uniform gutters.
 * - Accurate angles, consistent proportions, anatomically correct and undistorted faces and bodies, and identical outfit details across all panels.
 * - No text, no watermark.
 * ```
 *
 * **段宽按版式区分**（不是全局常量）：左段格数恒为 3，但右段的每格宽度随格数增长——
 * 单头只有一格大脸却要和三格等宽会挤压左段，故单头给 `2/3 + 1/3`；双头/三头给 `3/4 + 1/4`。
 */

/** 唯一的严格侧向。全板统一取左侧，两个侧向视图（左栏第 2 格与右栏侧向格）必须同侧。 */
export const multiviewAssetSide = "left" as const;
export type MultiviewAssetSide = typeof multiviewAssetSide;

/**
 * 右段的三种版式。三张引导图**只有右段头部格数不同**，左段完全一致（三竖栏躯干）。
 * 选哪个版式，就把对应的图作为第二参考提交，同时用各自写死的提示词加强引导。
 *
 * `ratio` 是该版式的**画幅**，取自引导图原图比例——**画幅是版式的函数，不是全局常量**。
 * 让出图画布与灰模比例对齐，模型照图排布时不会因画布不符而拉伸版式。
 */
export const multiviewAssetLayouts = [
  {
    id: "oneHead",
    label: "单头",
    hint: "右段一格：正脸近景",
    // 原图 1376×768 ≈ 1.79 → 16:9
    ratio: "16:9",
    url: MULTIVIEW_ONE_HEAD_REF,
  },
  {
    id: "twoHeads",
    label: "双头",
    hint: "右段两格：正脸 + 严格左侧",
    // 原图 1200×896 ≈ 1.34 → 4:3
    ratio: "4:3",
    url: MULTIVIEW_TWO_HEADS_REF,
  },
  {
    id: "threeHeads",
    label: "三头",
    hint: "右段三格：正脸 + 45° 右三分之四 + 严格左侧",
    // 原图 1200×896 ≈ 1.34 → 4:3
    ratio: "4:3",
    url: MULTIVIEW_THREE_HEADS_REF,
  },
] as const;

export type MultiviewAssetLayout = (typeof multiviewAssetLayouts)[number]["id"];

export function multiviewAssetLayoutOf(layout: MultiviewAssetLayout) {
  return multiviewAssetLayouts.find(item => item.id === layout);
}

/** 取某版式的画幅；未知版式回落到 4:3（双头/三头那档，信息量较大的一侧）。 */
export function multiviewAssetRatioOf(layout: MultiviewAssetLayout): string {
  return multiviewAssetLayoutOf(layout)?.ratio ?? "4:3";
}

/**
 * 右段各版式的视图名（小写起头，直接嵌进 `- Panel RX:` 条目里，避免句中大写）。
 * 面板缩略图与提示词共用，避免两处描述漂移。
 * 文案与引导图逐格对应——这是「再次加强引导」的核心：图与文同时说同一件事。
 *
 * 最后一条恒为严格 90° 左侧（双头是 R2、三头是 R3），与左段第 2 格的侧向**同侧**。
 */
export const multiviewAssetRightViews: Record<MultiviewAssetLayout, readonly string[]> = {
  oneHead: ["front-facing face and neck close-up"],
  twoHeads: ["front-facing face and neck close-up", "exact 90° left profile face and neck close-up — a true orthogonal side view, not a three-quarter angle"],
  threeHeads: ["front-facing face and neck close-up", "45° right three-quarter face and neck close-up", "exact 90° left profile face and neck close-up — a true orthogonal side view, not a three-quarter angle"],
};

/** 左段固定三格，三张版式共用。（L1 / L2 / L3，横排从左到右。） */
export const multiviewAssetLeftViews = [
  "front-view headless torso, cleanly cropped just above the collarbone down to the soles; no head, chin, or neck at all; at the crop only the intact collar opening and the plain background remain",
  "exact 90° left-side headless torso with the same collarbone-to-sole crop; no head, chin, or neck at all; at the crop only the intact collar opening and the plain background remain",
  "exact rear full-body view, shown from the complete head and hair down to the soles",
] as const;

const multiviewAssetSchema = z.object({
  model: z.string().catch(""),
  size: z.string().catch(""),
  // 画幅跟着版式走（oneHead=16:9 / twoHeads=4:3 / threeHeads=4:3），默认值取三头那档。
  ratio: z.string().catch(multiviewAssetRatioOf("threeHeads")),
  // 版式是逐字写死的结构（两段 / 无头裁切约束），交给工作流重写有被改乱的风险，默认关闭。
  rewritePrompt: z.boolean().catch(false),
  // 默认接「三头」：右段信息量最全，正脸 / 45° / 严格侧都有，是三种里最完整的资产板。
  layout: z.enum(["oneHead", "twoHeads", "threeHeads"]).catch("threeHeads"),
});

export type MultiviewAssetSettings = z.infer<typeof multiviewAssetSchema>;

export function readMultiviewAssetSettings(value: unknown): MultiviewAssetSettings {
  return multiviewAssetSchema.parse(value && typeof value === "object" && !Array.isArray(value) ? value : {});
}

/**
 * 引导图句。用 `<image1>` / `<image2>` 的写法把两张参考图的职责分开：
 * 身份全取自 image1，image2 只当版式与取景参考，明确要求丢弃灰模的人台表面 / 道具 / 打光。
 * 不这么写会把两张图混成一张看——立绘与灰模差别极大，混看会把人物画成灰模。
 */
const GUIDE_SENTENCE: Record<MultiviewAssetLayout, string> = {
  oneHead: `Take the character exclusively from <image1>, and use <image2> only as a layout and framing guide for panel sizes, head scale, and crop positions, while discarding its bald, featureless mannequin surface, props, and lighting.`,
  twoHeads: `Take the character exclusively from <image1>, and use <image2> only as a layout and framing guide for panel sizes, head scale, and crop positions, while discarding its bald, featureless mannequin surface, props, and lighting.`,
  threeHeads: `Take the character exclusively from <image1>, and use <image2> only as a layout and framing guide for panel sizes, head scale, and crop positions, while discarding its bald, featureless mannequin surface, props, and lighting.`,
};

/**
 * 画幅句。**画幅跟着版式走**：右段格数越多整板越方。
 * 单头一格是竖长大脸，给 16:9；双头/三头是两三个横栏，给 4:3。
 * 比例与所选灰模的原图一致，模型照图排布时不会被画布拉伸。
 */
const CANVAS_PHRASE: Record<MultiviewAssetLayout, string> = {
  oneHead: `16:9 landscape`,
  twoHeads: `4:3 landscape`,
  threeHeads: `4:3 landscape`,
};

/**
 * 左右两段的宽度占比。**按版式区分**：左段格数恒为 3，右段格数随版式增长，
 * 若始终给左段留 3/4，单头版那块单格大脸会被压得比左段三格还窄 → 单头改用 2/3 + 1/3。
 *
 * 导出给面板用：版式缩略图的网格列宽与提示文案都要跟着这个表走，不能写死 3fr 1fr。
 */
export const multiviewAssetSectionWidth: Record<MultiviewAssetLayout, { left: number; right: number }> = {
  oneHead: { left: 2, right: 1 },
  twoHeads: { left: 3, right: 1 },
  threeHeads: { left: 3, right: 1 },
};

/** 段宽在提示词里的写法（分数形式），由数值表推导，避免两处各写一份而漂移。 */
const SECTION_WIDTH: Record<MultiviewAssetLayout, { left: string; right: string }> = {
  oneHead: { left: `${multiviewAssetSectionWidth.oneHead.left}/3`, right: `${multiviewAssetSectionWidth.oneHead.right}/3` },
  twoHeads: { left: `3/4`, right: `1/4` },
  threeHeads: { left: `3/4`, right: `1/4` },
};

/** 左段排布句，三张版式完全一致（三个等宽竖栏，横排，同地面线同身高）。 */
const LEFT_LAYOUT_LINE =
  `- Layout: three equally sized vertical full-body panels, arranged side by side from left to right, on the same ground line and at the same figure height.`;

/**
 * 右段排布句，按版式给 1/2/3 格。格子纵向堆叠，头部比例一致，每格都含颈部。
 * 单头只有一格，不写「stacked vertically」——直接说清唯一那格的取景与比例。
 */
const RIGHT_LAYOUT_LINE: Record<MultiviewAssetLayout, string> = {
  oneHead: `- Layout: exactly one close-up panel, showing the face and neck down to its base, at the same head scale as the other views.`,
  twoHeads: `- Layout: two equally sized close-up panels, stacked vertically from top to bottom, all at the same head scale, all showing the neck down to its base.`,
  threeHeads: `- Layout: three equally sized close-up panels, stacked vertically from top to bottom, all at the same head scale, all showing the neck down to its base.`,
};

/**
 * 左段三格的 Panel 条目。恒为 L1/L2/L3，横向从左到右，与引导图逐格对齐。
 * 用编号条目（而非散文）是这版提示词的关键：每格都有独立条目、不易被模型合并或漏掉。
 */
function leftPanelLines() {
  return multiviewAssetLeftViews
    .map((view, index) => `- Panel L${index + 1}: ${view}.`)
    .join("\n");
}

/** 右段各格的 Panel 条目，按版式给 R1 / R1–R2 / R1–R3。 */
function rightPanelLines(layout: MultiviewAssetLayout) {
  return multiviewAssetRightViews[layout]
    .map((view, index) => `- Panel R${index + 1}: ${view}.`)
    .join("\n");
}

/**
 * 全局约束段。四条集中在末尾，前三条是跨格一致性（缺头对应 / 白底柔光细缝 / 角度比例解剖着装），
 * 最后一条是负面约束（无文字水印）。这段替代了此前散在两处的分栏结构句与收尾一致性句。
 */
const GLOBAL_REQUIREMENTS = [
  `**Global Requirements**`,
  `- The head absent from the Left Section is the identical head shown in the Right Section at the corresponding angle.`,
  `- Use a clean white background, even soft studio lighting, and thin uniform gutters.`,
  `- Accurate angles, consistent proportions, anatomically correct and undistorted faces and bodies, and identical outfit details across all panels.`,
  `- No text, no watermark.`,
].join("\n");

/**
 * 构建「制作资产」的提示词。
 *
 * 两张参考图有明确分工：`<image1>` 是连线进来的立绘（身份来源），
 * `<image2>` 是所选版式的引导灰模（只给版式与取景）——版式的右段格数在**图与提示词里
 * 同时写死**，两路互相加强。提示词为成品，不含任何可调参数。
 *
 * 结构：首段（画幅 + 参考图分工 + 身份一致性 + 姿态）→ 左段块 → 右段块 → 全局约束。
 * 段落标题用 `**…**` 加粗独立成行，段内先 `- Layout:` 再逐格 `- Panel LX:`。
 */
export function buildMultiviewAssetPrompt(layout: MultiviewAssetLayout = "threeHeads") {
  const width = SECTION_WIDTH[layout];
  const parts = [
    // 1. 首段：画幅 + 两张参考图分工 + 身份一致性 + 姿态。
    `Generate a professional multi-view character asset reference sheet on a ${CANVAS_PHRASE[layout]} canvas. ${GUIDE_SENTENCE[layout]} All identity traits of the character—including face, hairstyle, body type, clothing, accessories, colors, and materials—must remain fully consistent across every panel and be rendered exactly as in <image1>. Pose the character in a relaxed, upright standing stance with arms hanging naturally at the sides.`,
    // 2. 左段块（三格固定）。
    `**Left Section — approx. ${width.left} of the frame width**\n${LEFT_LAYOUT_LINE}\n${leftPanelLines()}`,
    // 3. 右段块（格数随版式）。
    `**Right Section — approx. ${width.right} of the frame width**\n${RIGHT_LAYOUT_LINE[layout]}\n${rightPanelLines(layout)}`,
    // 4. 全局约束段。
    GLOBAL_REQUIREMENTS,
  ];
  return parts.join("\n");
}

