// 漫 / 真互转：一键玩法，没有可调参数，提示词固定，两个方向只差「渲染语言」与 LoRA。
// 共同前提是「只换渲染方式，不换画面」——构图、姿势、配色、人物身份全部保留，
// 只把二次元的绘制感与照片的真实感互换，所以两条提示词都以 keep the same composition 开头。

/** 动漫转真人：把插画渲染成真实照片。 */
export function buildAnimeToRealPrompt() {
  return [
    "Redraw reference image {{ref 1}} as a real photograph of a real person in the real world. Keep exactly the same composition, framing, camera angle, pose, gesture, facial expression and color palette as the reference.",
    "Translate the illustrated rendering into believable photographic reality: real skin with pores and subtle imperfections, natural subsurface warmth, fine hair strands instead of flat color blocks, fabric with visible weave and believable wrinkle structure, and physically consistent light falloff with soft shadows.",
    "Keep the illustrated eye design intent but render it as a lifelike eye: a moist iris with depth, a catchlight matching the scene lighting, and natural eyelid and lash detail. Do not make the face look like a plastic mask or a wax figure, and do not over-smooth the skin.",
    "Use a lens-appropriate depth of field, coherent background detail and a real-camera dynamic range. No illustration outlines, no cel shading, no painterly brush strokes, no halftone pattern, no text and no watermark.",
  ].join("\n");
}

/** 真人转动漫：把真实照片画成日式动画插画（配 Nick_2anime LoRA）。 */
export function buildRealToAnimePrompt() {
  return [
    "Redraw reference image {{ref 1}} as a Japanese anime illustration of the same person. Keep exactly the same composition, framing, camera angle, pose, gesture, facial expression and color palette as the reference.",
    "Translate photographic reality into clean anime rendering: smooth cel shading with a single soft shadow terminator, even-weight line art, simplified skin without pores, hair grouped into deliberate shaped strands with one distinct highlight band, and clothing reduced to a few essential folds.",
    "Keep the person recognizable: face shape, hairstyle, hair color, eye color and outfit design stay the same. Render the eyes in anime style with a large defined iris, gradient depth, a clear catchlight and a clean upper lash line, but do not redesign the character.",
    "Remove photographic texture, film grain, lens blur and HDR contrast. No photorealistic skin detail, no text and no watermark.",
  ].join("\n");
}
