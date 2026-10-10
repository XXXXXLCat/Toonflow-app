// 动漫转真人：一键玩法，没有可调参数，提示词固定。
// 核心是「只换渲染方式，不换画面」——构图、姿势、配色全部保留，只把二次元的绘制感换成照片的真实感。
export function buildAnimeToRealPrompt() {
  return [
    "Redraw reference image {{ref 1}} as a real photograph of a real person in the real world. Keep exactly the same composition, framing, camera angle, pose, gesture, facial expression and color palette as the reference.",
    "Translate the illustrated rendering into believable photographic reality: real skin with pores and subtle imperfections, natural subsurface warmth, fine hair strands instead of flat color blocks, fabric with visible weave and believable wrinkle structure, and physically consistent light falloff with soft shadows.",
    "Keep the illustrated eye design intent but render it as a lifelike eye: a moist iris with depth, a catchlight matching the scene lighting, and natural eyelid and lash detail. Do not make the face look like a plastic mask or a wax figure, and do not over-smooth the skin.",
    "Use a lens-appropriate depth of field, coherent background detail and a real-camera dynamic range. No illustration outlines, no cel shading, no painterly brush strokes, no halftone pattern, no text and no watermark.",
  ].join("\n");
}
