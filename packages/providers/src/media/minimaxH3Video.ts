type VideoRequest = {
  model: string;
  prompt: string;
  mode?: string;
  images?: unknown[];
  videos?: unknown[];
  audios?: unknown[];
  firstFrame?: unknown;
  lastFrame?: unknown;
  duration?: number;
  ratio?: string;
  resolution?: string;
  generateAudio?: boolean;
  watermark?: boolean;
  // 可叠加的 LoRA，按顺序应用，最多 12 条（堆叠节点的槽位数）。
  loras?: { name?: string; strength?: number }[];
  other?: Record<string, unknown>;
};

type Context = {
  config: Record<string, unknown>;
  signal?: AbortSignal;
  tool: { fetch: typeof fetch; fetchDetached: typeof fetch };
};

type MediaInput = { type?: string; data?: string; url?: string; mimeType?: string; name?: string };

type MediaAsset = { mediaType: "video"; type: "url"; url: string };

const COMFY_URL = "http://127.0.0.1:8188";

// ResolutionSelector 的 aspect_ratio 只接受带标签的枚举值，而画布节点传下来的是纯 W:H。
const RATIO_LABEL: Record<string, string> = {
  "1:1": "1:1 (Square)",
  "2:3": "2:3 (Portrait Photo)",
  "3:2": "3:2 (Photo)",
  "3:4": "3:4 (Portrait Standard)",
  "4:3": "4:3 (Standard)",
  "9:16": "9:16 (Portrait Widescreen)",
  "16:9": "16:9 (Widescreen)",
  "21:9": "21:9 (Ultrawide)",
};

// 画布节点默认 16:9；这里作为 ratio 缺失或无法映射时的兜底（与节点默认保持一致）。
const DEFAULT_ASPECT = "16:9 (Widescreen)";
// 画布节点默认 0.9MP（16:9 吸附后为 1280×720）；这里作为 mp 片段缺失时的兜底。
const DEFAULT_MEGAPIXELS = 0.9;
// 时长（秒）的兜底与取值区间，与画布 #186 的 PrimitiveFloat 对齐。
const DEFAULT_DURATION = 6;
const MIN_DURATION = 1;
const MAX_DURATION = 15;

// 视频请求的平台字段是严格白名单（providerId / modelId / prompt / outputDirectory / images / ratio /
// resolution / duration / mode / generateAudio / 首尾帧 / 视频 / 音频），没有图片请求那样的 size 通道。
// 因此画布节点把「百万像素 / 是否重写提示词 / 是否开启 Turbo」编进 resolution 的片段里：
//   resolution = "mp=1|rw=1|tb=1"
// 不含 "=" 的片段视为真实分辨率字符串（如 720p），保留给声明了分辨率档位的模型；两者可共存。
// 只有未声明分辨率档位的工作流模型会收到这套编码，云端供应商的 resolution 语义不受影响。
function parseOutputSpec(raw?: string) {
  const spec = { megapixels: DEFAULT_MEGAPIXELS as number, rewrite: true, turbo: true };
  for (const part of String(raw ?? "").split("|")) {
    const text = part.trim();
    if (!text) continue;
    const separator = text.indexOf("=");
    const key = (separator === -1 ? text : text.slice(0, separator)).trim();
    const value = separator === -1 ? "" : text.slice(separator + 1).trim();
    if (key === "mp") {
      const megapixels = Number(value);
      if (Number.isFinite(megapixels) && megapixels > 0) spec.megapixels = megapixels;
    } else if (key === "rw") spec.rewrite = value !== "0";
    else if (key === "tb") spec.turbo = value === "1";
  }
  return spec;
}

// ResolutionSelector.megapixels 是 0.1~16、step 0.01 的浮点。
function clampMegapixels(value: number) {
  return Math.min(16, Math.max(0.1, Math.round(value * 100) / 100));
}

// ── LoRA 堆叠（ComfyUI 节点「🐈‍⬛StackLoras」）────────────────────────────────────
// 与图片侧同一套：12 槽位（lora_N / strength_N / on_N），未用的槽位跳过。
// 供应商不能 import 模块（宿主 module.link 拒绝），所以函数内联在此。
const LORA_STACK_SLOTS = 12;
/** 堆叠节点的类名，含零宽字符 U+200D，必须与 ComfyUI 注册的完全一致。 */
const LORA_STACK_NODE = "🐈‍⬛StackLoras";
const loraSlotKey = (prefix: string, index: number) => `${prefix}_${String(index).padStart(2, "0")}`;

/** 画布通过 loras 字段传（最多 12 条）。strength 原样透传，缺省 1，负值表示反转。 */
function readLoraEntries(loras: { name?: unknown; strength?: unknown }[] | undefined) {
  if (!Array.isArray(loras) || !loras.length) return [];
  const entries: { name: string; strength: number }[] = [];
  for (const item of loras.slice(0, LORA_STACK_SLOTS)) {
    if (!item || typeof item !== "object") continue;
    const name = (item as { name?: unknown }).name;
    if (typeof name !== "string" || !name.trim()) continue;
    const strength = (item as { strength?: unknown }).strength;
    entries.push({ name: name.trim(), strength: typeof strength === "number" && Number.isFinite(strength) ? Math.max(-10, Math.min(10, strength)) : 1 });
  }
  return entries;
}

/** 转成堆叠节点 inputs。未用的槽位填 None + on=false，节点原样跳过，等价于没接。 */
function buildLoraStackInputs(entries: { name: string; strength: number }[]) {
  const inputs: Record<string, unknown> = {};
  for (let index = 0; index < LORA_STACK_SLOTS; index += 1) {
    const entry = entries[index];
    inputs[loraSlotKey("lora", index + 1)] = entry ? entry.name : "None";
    inputs[loraSlotKey("strength", index + 1)] = entry ? entry.strength : 1;
    inputs[loraSlotKey("on", index + 1)] = !!entry;
  }
  return inputs;
}

/** 从 ComfyUI 读堆叠节点当前的 LoRA 枚举作为校验依据。读不到返回空集（不拦生成）。 */
async function collectLoraNames(tool: Context["tool"]): Promise<string[]> {
  try {
    const response = await tool.fetch(`${COMFY_URL}/object_info/${encodeURIComponent(LORA_STACK_NODE)}`);
    if (!response.ok) return [];
    const data = await response.json() as Record<string, { input?: { required?: Record<string, unknown> } }>;
    const names: string[] = [];
    for (const spec of Object.values(data[LORA_STACK_NODE]?.input?.required ?? {})) {
      const options = Array.isArray(spec) ? (spec[1] as { options?: unknown } | undefined)?.options : undefined;
      if (Array.isArray(options)) {
        names.push(...options.filter((item): item is string => typeof item === "string"));
        break;
      }
    }
    return names;
  } catch {
    return [];
  }
}

// 时长在画布上是 PrimitiveFloat「Float (duration)」(#186)，1–15 秒；它经 #185 的数学表达式
// （round(秒 × 24) 后再对齐到 frames ≡ 5 (mod 17)）换算成 #184.length 的帧数，fps 固定 24。
// 画布固定 6 秒，这里作为缺失值兜底。
function clampDuration(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_DURATION;
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, value));
}

// VM 沙箱只注入了 Buffer/Blob/URL 等，没有 FormData，因此手工拼 multipart 正文。
function multipartImage(field: string, filename: string, mimeType: string, bytes: Buffer) {
  const boundary = `----ToonflowFormBoundary${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const text = (value: string) => Buffer.from(value, "utf8");
  const body = Buffer.concat([
    text(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    bytes,
    text(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ninput\r\n`),
    text(`--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n`),
    text(`--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function extensionOf(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.toLowerCase() ?? "";
  if (subtype === "jpeg" || subtype === "jpg") return "jpg";
  if (/^[a-z0-9]{2,5}$/.test(subtype)) return subtype;
  return "png";
}

// 用户中止生成时 ComfyUI 侧不会跟着停：工作流仍会占着显存跑完，白等一场还留下产物。
// 所以任务一旦提交成功，中止时就要主动撤下来：先按 ID 从队列摘掉（还没轮到时这一步就够，
// 也不会波及画布上其他任务）；若它已经在执行，摘除不会生效，此时再看队列状态确认正在跑的
// 确实是我们这个任务，才发 /interrupt（ComfyUI 只有全局中断，没有按任务的中断接口）。
// 取消之后主 signal 已中止，普通 tool.fetch 会立即抛错，只能用 fetchDetached。
// 注意 POST /queue 只返回 200 空体，队列状态得另发一次 GET 才看得到。
async function cancelComfyTask(tool: Context["tool"], promptId: string) {
  const headers = { "Content-Type": "application/json" };
  // 先按 ID 从队列里摘掉：任务还没轮到时这一步就够，也不会波及同时在跑的其他任务。
  await tool.fetchDetached(`${COMFY_URL}/queue`, {
    method: "POST",
    headers,
    body: JSON.stringify({ delete: [promptId] }),
  }).catch(() => undefined);
  // 摘除对已经开始执行的任务不生效（它不在 pending 里），这时队列里还看得到它，才需要中断。
  const queue = await tool.fetchDetached(`${COMFY_URL}/queue`)
    .then((response) => response.json() as Promise<{ queue_running?: unknown[][] }>).catch(() => undefined);
  if (!queue?.queue_running?.some((entry) => entry?.[1] === promptId)) return;
  await tool.fetchDetached(`${COMFY_URL}/interrupt`, { method: "POST" }).catch(() => {});
}

export default {
  id: "minimaxH3Video",
  label: "MiniMax H3 图生视频工作流",
  version: "2.6.1",
  apiUrl: COMFY_URL,
  readme: "接入本地 ComfyUI 的 MiniMax H3 视频工作流（画布 #105 子图）：不接参考图按文生视频，单图默认作首帧（选「首帧可选」则作尾帧，对应画布 L2VA 用法），两张按顺序作首尾帧。画布节点的高宽比、百万像素驱动 ResolutionSelector；时长（1–15 秒）写入 Float (duration)，经数学表达式换算成帧数（fps 24）；重写提示词切换 TextGenerate 改写分支（refine_prompt，携带完整写作指南）；Turbo 一个布尔同时驱动模型链（sol-attn + turbo LoRA 与否，#198）与采样步数（10 段 sigmas / 30 步，#201）。停止生成时会撤销已提交到 ComfyUI 的任务（执行中的中断、排队中的移除），不会继续占用显存。",
  rules: [],
  models: [
    {
      id: "minimax_h3_i2v",
      label: "MiniMax H3 图生视频",
      type: "video",
      // 单图 = 单图作首帧；两张图按引用顺序作首帧、尾帧；一张不给 = 文生视频（工作流原生支持）。
      // startFrameOptional 是「首帧可选」：只有一张图时该图作**尾帧**（尾部锚定，工作流自行推演开头），
      // 因此单图时它和 singleImage 同时命中，节点会把模式下拉显示出来让用户指定首帧还是尾帧。
      mode: ["text", "startEndRequired", "singleImage", "startFrameOptional"],
      // 画布节点的「高宽比」驱动 ResolutionSelector（#170）；「百万像素」调它的 megapixels。
      // 平台只接受纯 W:H 格式，提交前由 RATIO_LABEL 映射成带标签的枚举值。
      imageRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"],
      // 画布节点的百万像素档位。
      imageSizes: ["0.4", "0.9", "1.6", "2"]
    }
  ],
  async generateVideo(this: Context, request: VideoRequest): Promise<MediaAsset[]> {
    this.signal?.throwIfAborted();
    if (request.model !== "minimax_h3_i2v" || !request.prompt.trim()) {
      throw new Error("模型或提示词无效");
    }

    // 首尾帧优先；单图模式下画布节点把图片放在 images 里，这里按顺序补位。
    // 「首帧可选」(startFrameOptional) 是画布 L2VA 的用法：只有一张图时该图作**尾帧**，首帧留空交给
    // 工作流推演；其余模式下单图都作首帧。工作流的 first_frame / last_frame 都是 optional 输入。
    const images = Array.isArray(request.images) ? request.images : [];
    const asMedia = (item: unknown): MediaInput | undefined => (item && typeof item === "object" ? (item as MediaInput) : undefined);
    const explicitFirst = asMedia(request.firstFrame);
    const explicitLast = asMedia(request.lastFrame);
    const single = explicitFirst ?? explicitLast ?? asMedia(images[0]);
    // 只有客户端没显式给首帧时，「首帧可选」才表示「这张图当尾帧」。
    const singleAsLast = request.mode === "startFrameOptional" && !explicitFirst;
    const firstFrame = explicitFirst ?? (singleAsLast ? undefined : single);
    const lastFrame = explicitLast ?? (singleAsLast ? single : asMedia(images[1]));
    // 上传顺序 = 提示词里 <Picture N> 的顺序：首帧在前、尾帧在后，与工作流的首尾帧语义一致。
    const slots: { key: "first_frame" | "last_frame"; frame: MediaInput }[] = [];
    if (firstFrame) slots.push({ key: "first_frame", frame: firstFrame });
    if (lastFrame) slots.push({ key: "last_frame", frame: lastFrame });
    // 工作流只有 first_frame / last_frame 两个入口，多出的参考图丢弃。
    // 一张不给即「文生视频」：工作流里的 MiniMaxH3ImageToVideo 把 first_frame / last_frame 声明为
    // optional，无关键帧时只编码文本、不挂 minimax_keyframes，空 latent 的宽高直接取
    // ResolutionSelector（#170）的输出 ⇒ 文生视频的画幅、百万像素、时长、Turbo、重写提示词全都照常生效。

    const { megapixels: requestMegapixels, rewrite, turbo } = parseOutputSpec(request.resolution);
    const megapixels = clampMegapixels(requestMegapixels);
    const aspectRatio = RATIO_LABEL[request.ratio ?? ""] ?? DEFAULT_ASPECT;
    // LoRA 名称直接决定堆叠节点入参，写错（换过路径、改过名）ComfyUI 只会报一句不指明节点的错。
    // 先对着枚举校一遍，把问题说清楚；读不到枚举时返回空集、不拦生成。
    const requestedLoras = readLoraEntries(request.loras);
    if (requestedLoras.length) {
      const available = new Set(await collectLoraNames(this.tool));
      const missing = requestedLoras.filter(entry => !available.has(entry.name)).map(entry => entry.name);
      if (missing.length) throw new Error(`找不到 LoRA：${missing.join("、")}。确认 ComfyUI 的 lora 模型目录里有该文件，且节点侧列表已刷新。`);
    }
    const loraStackInputs = buildLoraStackInputs(requestedLoras);

    const signal = AbortSignal.any([AbortSignal.timeout(900000), ...(this.signal ? [this.signal] : [])]);

    // 1. 把接入的参考图逐张上传到 ComfyUI 的 input 目录，拿回可供 LoadImage 使用的文件名。
    const uploaded: string[] = [];
    for (let index = 0; index < slots.length; index++) {
      signal.throwIfAborted();
      const frame = slots[index]!.frame;
      const base64 = typeof frame.data === "string" ? frame.data.replace(/^data:[^;]+;base64,/, "") : "";
      let bytes: Buffer | undefined;
      if (base64) bytes = Buffer.from(base64, "base64");
      else if (typeof frame.url === "string" && /^https?:\/\//i.test(frame.url)) {
        const downloaded = await this.tool.fetch(frame.url, { signal });
        if (!downloaded.ok) throw new Error(`读取第 ${index + 1} 张参考图失败，HTTP ${downloaded.status}`);
        bytes = Buffer.from(await downloaded.arrayBuffer());
      }
      if (!bytes || !bytes.length) throw new Error(`第 ${index + 1} 张参考图内容无效`);
      const mimeType = typeof frame.mimeType === "string" && frame.mimeType ? frame.mimeType : "image/png";
      const filename = `toonflow_h3_ref_${Date.now()}_${index}.${extensionOf(mimeType)}`;
      const form = multipartImage("image", filename, mimeType, bytes);
      const response = await this.tool.fetch(`${COMFY_URL}/upload/image`, {
        method: "POST",
        headers: { "Content-Type": form.contentType },
        body: form.body,
        signal,
      });
      if (!response.ok) throw new Error(`上传第 ${index + 1} 张参考图失败，HTTP ${response.status}`);
      const result = (await response.json()) as { name?: string; subfolder?: string };
      const name = typeof result?.name === "string" ? result.name : "";
      if (!name) throw new Error(`第 ${index + 1} 张参考图未返回文件名`);
      uploaded.push(result.subfolder ? `${result.subfolder}/${name}` : name);
    }

    // 2. 按实际接入的帧生成 LoadImage 节点（画布里 137/138 写死的实例文件不再使用），
    //    并记住每个节点落在首帧还是尾帧槽位上。
    const loadImageIds = uploaded.map((_, index) => String(900 + index));
    const loadImages: Record<string, { inputs: Record<string, unknown>; class_type: string }> = {};
    const batchImages: Record<string, [string, number]> = {};
    const frameWiring: Record<string, [string, number]> = {};
    loadImageIds.forEach((nodeId, index) => {
      loadImages[nodeId] = { inputs: { image: uploaded[index] }, class_type: "LoadImage" };
      batchImages[`images.image${index}`] = [nodeId, 0];
      frameWiring[slots[index]!.key] = [nodeId, 0];
    });

    const workflow: Record<string, { inputs: Record<string, unknown>; class_type: string }> = {
      "92": {
        "inputs": { "filename_prefix": "MiniMax/MiniMax_H3", "format": "auto", "format.codec": "auto", "codec": "auto", "video": ["183", 0] },
        "class_type": "SaveVideo"
      },
      "170": {
        "inputs": { "aspect_ratio": aspectRatio, "megapixels": megapixels, "multiple": 32, "preview_ratio": aspectRatio, "preview_megapixels": megapixels },
        "class_type": "🐈‍⬛ResolutionSelector"
      },
      // LoRA 堆叠：串在 #180 底模与 #198 switch 之间，12 个槽位由画布侧按需下发。
      // 导出时槽位 1-3 带过 LoRA（战斗/运镜修复/速度），这里改成完全由请求决定：
      // 未指定的槽位一律 None + on=false，节点跳过，等价于没接。
      "171": {
        "inputs": {
          ...loraStackInputs,
          "model": ["180", 0]
        },
        "class_type": LORA_STACK_NODE
      },
      "173": { "inputs": { "vae_name": "minimax_h3_audio_vae_fp32.safetensors" }, "class_type": "VAELoader" },
      "174": { "inputs": { "samples": ["178", 0], "vae": ["173", 0] }, "class_type": "VAEDecodeAudio" },
      "175": { "inputs": { "samples": ["178", 0], "vae": ["194", 0] }, "class_type": "VAEDecode" },
      "176": { "inputs": { "sampler_name": "er_sde" }, "class_type": "KSamplerSelect" },
      "177": { "inputs": { "scheduler": "beta", "steps": ["187", 0], "denoise": 1, "model": ["188", 0] }, "class_type": "BasicScheduler" },
      "178": {
        "inputs": { "noise": ["182", 0], "guider": ["179", 0], "sampler": ["176", 0], "sigmas": ["201", 0], "latent_image": ["184", 1] },
        "class_type": "SamplerCustomAdvanced"
      },
      "179": { "inputs": { "model": ["188", 0], "conditioning": ["184", 0] }, "class_type": "BasicGuider" },
      "180": { "inputs": { "unet_name": "MiniMax-H3\\minimax_h3_fl2va_pruned_int8_convrot.safetensors", "weight_dtype": "default" }, "class_type": "UNETLoader" },
      "181": { "inputs": { "clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default" }, "class_type": "CLIPLoader" },
      "182": { "inputs": { "noise_seed": Math.floor(Math.random() * 1000000000000) }, "class_type": "RandomNoise" },
      "183": { "inputs": { "fps": 24, "bit_depth": 8, "color_space": "sRGB", "codec": "none", "images": ["175", 0], "audio": ["174", 0] }, "class_type": "CreateVideo" },
      "184": {
        "inputs": {
          "prompt": ["192", 0],
          "width": ["170", 0],
          "height": ["170", 1],
          "length": ["185", 1],
          "clip": ["181", 0],
          "vae": ["194", 0],
          // 两个关键帧输入都是 optional：无图时都不接，工作流按文生视频处理；单图作尾帧时只接 last_frame。
          ...frameWiring
        },
        "class_type": "MiniMaxH3ImageToVideo"
      },
      "185": { "inputs": { "expression": "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17", "values.a": ["186", 0] }, "class_type": "ComfyMathExpression" },
      "186": { "inputs": { "value": clampDuration(request.duration) }, "class_type": "PrimitiveFloat" },
      "187": { "inputs": { "value": 30 }, "class_type": "PrimitiveInt" },
      // 工作流自带的 Chunk FeedForward（画布 #127，chunks 2 / seq_threshold 4096），位于 Turbo 开关之后、采样器之前。
      "188": { "inputs": { "chunks": 2, "seq_threshold": 4096, "model": ["198", 0] }, "class_type": "MiniMaxChunkFeedForward" },
      "189": { "inputs": { "clip_name": "qwen3.8_27b_w4a8.safetensors", "type": "stable_diffusion", "device": "default" }, "class_type": "CLIPLoader" },
      "190": {
        "inputs": {
          "prompt": ["195", 0],
          "max_length": 2048,
          "sampling_mode": "on",
          "sampling_mode.temperature": 0.7,
          "sampling_mode.top_k": 64,
          "sampling_mode.top_p": 0.95,
          "sampling_mode.min_p": 0.05,
          "sampling_mode.repetition_penalty": 1.05,
          "sampling_mode.seed": 0,
          "sampling_mode.presence_penalty": 0,
          "thinking": true,
          "use_default_template": true,
          "mtp": "auto",
          "clip": ["189", 0],
          // TextGenerate 的 image 是 optional 输入：无参考图时改写器只吃文本提示词。
          ...(loadImageIds.length ? { "image": ["193", 0] } : {}),
          "system_prompt": ["191", 0]
        },
        "class_type": "TextGenerate"
      },
      "191": { "inputs": { "value": "# Video Prompt Writing Guide (T2VA / I2VA / FL2VA / L2VA)\n\n## 1. Task Overview\n\n- **T2VA**: Builds a complete audiovisual timeline from text.\n- **I2VA**: T2VA body + first-frame instruction + a visual path that develops forward from the first frame.\n- **FL2VA**: T2VA body + first-and-last-frame instruction + a continuous path from the first frame to the last frame.\n- **L2VA**: T2VA body + last-frame instruction + a path that converges from a plausible preceding state to the last frame.\n\n## 2. Final Prompt Structure\n\n### 2.1 Part One Is the Instruction\n\n**T2VA** has no image-alignment instruction and begins directly with the three core fields.\n\n**I2VA** always uses:\n\n```text\nFor the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n```\n\n**FL2VA** always uses:\n\n```text\nHow the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.\n```\n\n**L2VA** always uses:\n\n```text\nHow the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.\n```\n\nHere, `N` is the index of the actual final shot, and `S.SS` is the effective video duration formatted to exactly two decimal places. The instruction must be the first line of the final prompt, followed by one blank line before the core fields.\n\n### 2.2 Part Two Contains the Three Core Fields\n\n```text\nintegrated_multimodal_description: [Shot 1] ...\n\noverall_soundscape: ...\n\nnon_diegetic_music: ...\n```\n\n- **integrated_multimodal_description**: Describes visuals, actions, shots, speakers, dialogue, singing, and diegetic audio along the timeline.\n- **overall_soundscape**: Summarizes ambient sound, physical action sounds, and non-verbal human sounds across the entire video.\n- **non_diegetic_music**: Describes background music that the characters cannot hear and only the audience can hear.\n\n## 3. How to Incorporate Keyframes into the Multimodal Description\n\n### 3.1 I2VA: Begin from the Image and Develop Forward\n\n`<Picture 1>` is the actual first frame of the video at 0.00 seconds and belongs to `[Shot 1]`. The description should first establish the style, subjects, composition, and scene anchors in the image, then describe the next action. Character identity, clothing, colors, key objects, and spatial relationships should remain consistent.\n\nRecommended structure: **first-frame anchor → action onset → continuous development → result or reaction**.\n\n### 3.2 FL2VA: Describe the Path Between the First and Last Frames\n\nPicture 1 is the opening, and Picture 2 is the ending. Focus on how the subject moves, how poses change, how objects are manipulated, how the composition evolves, and how the scene or lighting transitions.\n\nFL2VA generally favors a single shot so the model can interpolate continuously from the first frame to the last frame. Use multiple shots only when they are explicitly specified. The last frame must be reached by the final `[Shot N]` at the end of the video.\n\nRecommended structure: **first-frame state → observable intermediate changes → progressively narrowing differences → last-frame state**.\n\n### 3.3 L2VA: Infer the Opening and Land on the Image at the End\n\n`<Picture 1>` is the final frame of the video and belongs to the last `[Shot N]`; it does not inherently belong to Shot 1. Infer a plausible earlier state from the user's intent and the last frame, then describe how the characters, objects, camera, and scene gradually approach the reference image.\n\nRecommended structure: **plausible preceding state → explicit action and transition path → gradual convergence in the final shot → last-frame landing**.\n\n## 4. How to Write the Three Shared Core Sections\n\n### 4.1 Develop the Multimodal Description Along the Timeline\n\n`integrated_multimodal_description` is the main body of the rewritten prompt. Every detail should correspond to something visible or audible: visual style, initial composition, subject appearance and position, scene and key props, actions and reactions, shot changes, spoken language, and synchronized diegetic sound.\n\nAt the beginning of `[Shot 1]`, state the overall style and initial composition. Common styles include `Cinematic`, `live-action`, `2D-animated`, `3D CG`, `claymation`, `watercolor`, and `vintage film`. For keyframe tasks, derive the style from the reference image; for T2VA, select it from the user's text.\n\n```text\n[Shot 1] Live-action, cinematic, a medium-wide shot frames...\n```\n\n### 4.2 Shots and Cuts\n\nDo not add a timestamp to the first shot. Use sequential shot numbers for later shots, and begin each one with a strictly increasing cut time that falls within the video duration:\n\n```text\n[Shot 2] At 00:03.500, the camera cuts to...\n```\n\nFor ordinary cuts, use `the camera cuts to`, `the shot cuts to`, `the shot transitions to`, `the shot changes to`, or `the shot switches to`. When explicitly requested by the user, cross-dissolve, fade, or wipe may also be used. A cut should introduce new information about the subject, space, state, viewpoint, or time. If only the distance or a slight angle needs to change, prefer camera motion.\n\n### 4.3 Camera Motion: Motion Type + Amplitude + Speed\n\nA complete camera-motion expression has three dimensions: the **motion type** defines how the camera moves, **amplitude** defines the range of compositional change, and **speed** defines the pacing of that change. Add amplitude and speed only when they are meaningful; medium amplitude and normal speed are usually omitted.\n\n| Dimension | Available Expression | Description |\n|-|-|-|\n| Motion type | `Zoom In / Zoom Out` | The focal length changes while the camera body remains stationary |\n| Motion type | `Push In / Pull Out` | The camera moves forward / backward |\n| Motion type | `Pan Left / Pan Right` | The camera remains in place while the lens pivots horizontally |\n| Motion type | `Truck Left / Truck Right` | The camera translates horizontally |\n| Motion type | `Tilt Up / Tilt Down` | The camera remains in place while the lens pivots vertically |\n| Motion type | `Pedestal Up / Pedestal Down` | The entire camera moves upward / downward |\n| Motion type | `Arc Shot` | The camera moves in an arc around the subject |\n| Motion type | `Tracking Shot` | The camera follows a moving subject |\n| Motion type | `Static Shot` | The camera position and lens remain still |\n| Motion type | `Shake Slightly / Shake Strongly` | Slight / strong camera shake |\n| Motion type | `POV` | The subject's point of view |\n| Motion type | `Roll Clockwise / Roll Counterclockwise` | The camera rolls clockwise / counterclockwise around the lens axis |\n| Amplitude | `with small amplitude` | Small-range change |\n| Amplitude | `with large amplitude` | Large-range change |\n| Speed | `at slow speed` | Slow movement |\n| Speed | `at fast speed` | Fast movement |\n\nCamera motion should be written as a natural English action within the shot, rather than stacked as separate labels at the end of a sentence:\n\n```text\nThe camera pushes in with small amplitude at slow speed toward the folded letter in her hands.\nThe camera pans right with large amplitude at fast speed, revealing the open doorway.\nThe camera holds a static shot as the runner exits the frame.\n```\n\n### 4.4 Speakers, Dialogue, and Singing\n\nSubjects who speak, sing, or produce an off-screen human voice use stable IDs such as `(S1)` and `(S2)`. When multiple already-numbered speakers speak or sing together, use a compound ID such as `(S1,S2)`. A speaker keeps the same ID across shots; characters who never vocalize receive no speaker ID.\n\nWhen a speaker first appears, provide enough information from the visual and audio context to establish a stable identity, such as character type, age, gender, whether the person is on-screen, pitch, timbre, speaking rate, or accent. Place the speaker's identifying phrase, ID, action, and delivery outside `<d>`. Inside `<d>`, include only the language tag and the actual user-provided spoken content. Preserve every original word and punctuation mark verbatim; do not translate or rewrite them.\n\n```text\nThe young woman with a quiet, breathy voice (S1) says: <d>[English] I get off at the next station.</d>\nThe two children (S1,S2) shout together, <d>[English] Wait for us!</d>\n```\n\nFor voiceover, use the exact phrase `says in an off-screen voiceover`. Immediately after every voiceover `<d>` block, state that the corresponding on-screen character's lips remain closed:\n\n```text\nThe man (S1) says in an off-screen voiceover: <d>[English] I still remember that road.</d> while his lips remain completely closed.\n```\n\nWhen the same line of dialogue or lyrics crosses a cut, use `<scenetrans>` at the connecting points in both parts and explicitly state that the audio continues across the cut. Use `<cutoff>` when speech is truncated by the end of the video. Continuity may be expressed with `continues seamlessly across the cut`, `continues uninterrupted into the next shot`, `carries over from the previous shot`, or `remains audible across the transition`.\n\n### 4.5 On-Screen Text\n\nPlace any banner, sign, label, subtitle, or neon text that is actually visible on screen in English double quotation marks. Preserve the original text and punctuation verbatim, without translation.\n\n```text\nA red neon sign reading \"营业中\" glows above the doorway.\n```\n\n### 4.6 overall_soundscape\n\nUse 1–4 English sentences in one continuous paragraph to summarize the ambient sound, physical action sounds, and non-verbal human sounds across the full video, such as wind, rain, traffic, footsteps, fabric movement, impacts, breathing, laughter, or panting. Dialogue, singing, and diegetic music already belong in the multimodal description and should not be repeated here. Use `N/A` only when the user explicitly requests complete silence throughout the video.\n\n```text\noverall_soundscape: Steady rain taps against the café windows while low room ambience continues underneath. The entrance bell rings once, followed by wet footsteps and the soft scrape of a chair.\n```\n\n### 4.7 non_diegetic_music\n\nUse 1–3 English sentences to describe background music that the characters cannot hear and only the audience can hear. Focus on instrumentation, speed, rhythm, and dynamic changes; do not use abstract mood words or explain the emotional function of the score. Singing, instruments, radio, television, or phone music audible to the characters are diegetic events and should appear in the multimodal description. Use `N/A` when there is no non-diegetic music.\n\n```text\nnon_diegetic_music: Sparse piano notes at a slow tempo, joined by sustained low strings that gradually increase in volume before fading out.\n```\n\n## 5. Cases\n\n### Case 1: T2VA\n\nWith no reference image, construct the complete timeline directly from the text. You may add scene, character, action, and sound details that remain consistent with the user's intent.\n\n```text\nintegrated_multimodal_description: [Shot 1] Live-action, cinematic, a medium-wide shot frames a baker opening the shutters of a small street bakery before sunrise. The camera pushes in with small amplitude at slow speed as the middle-aged baker with a calm, slightly raspy voice (S1) places a fresh loaf on the wooden counter and says: <d>[English] First batch of the morning.</d> [Shot 2] At 00:05.000, the camera cuts to a close-up of steam rising from the sliced bread while the baker's final words carry over from the previous shot.\n\noverall_soundscape: Wooden shutters scrape open over a quiet street as trays clink softly inside the bakery. The doorbell rings once, followed by light footsteps and the crisp sound of bread being sliced.\n\nnon_diegetic_music: A soft acoustic-guitar pattern at a moderate tempo, joined by sparse upright-bass notes and a gentle fade at the end.\n```\n\n### Case 2: I2VA\n\nWrite the first-frame instruction first, then use the subject, composition, and scene in Picture 1 as the starting point of Shot 1 before describing how the scene continues to develop.\n\n```text\nFor the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\nintegrated_multimodal_description: [Shot 1] Live-action, cinematic, the young woman shown in <Picture 1> remains beside the rain-covered train window, preserving her appearance, clothing, seat position, and the carriage layout. The camera trucks right with small amplitude at slow speed as she lifts her gaze from the folded letter toward the passing city lights. Her reflection moves across the glass while the quiet, breathy young woman (S1) says: <d>[English] I get off at the next station.</d> She folds the letter along its existing crease.\n\noverall_soundscape: The train wheels produce a steady metallic rhythm beneath a low ventilation hum. Rain ticks against the window while paper rustles softly in her hands.\n\nnon_diegetic_music: Sustained cello notes at a slow tempo with widely spaced piano tones, gradually decreasing in volume.\n```\n\n### Case 3: FL2VA\n\nThe two images anchor the opening and ending respectively. The body should not repeat two static image descriptions; instead, it should supply the motion path that connects them. The following example is an eight-second single shot.\n\n```text\nHow the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the 8.00-second mark of the target video.\n\nintegrated_multimodal_description: [Shot 1] Live-action, cinematic, a rain-soaked cyclist begins in the position and framing established by Picture 1, holding a closed black umbrella beside a silver bicycle. The camera pulls out with small amplitude at slow speed as she releases the bicycle handle, raises the umbrella above her shoulder, and presses the runner upward until the canopy opens. Water rolls from the expanding fabric while she steps beneath it, rotates the handle into the final angle, and settles into the pose, spacing, and composition established by Picture 2 at the end of the shot.\n\noverall_soundscape: Rain falls steadily on the pavement, followed by the metallic click of the umbrella runner and the soft snap of the canopy opening. Water drips from the bicycle frame as distant traffic passes.\n\nnon_diegetic_music: N/A\n```\n\n### Case 4: L2VA\n\nThe image anchors only the final moment. First establish a compatible earlier state, then let the actions, object states, and composition gradually land on Picture 1 in the final shot. The following example is a six-second single shot.\n\n```text\nHow the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the 6.00-second mark of the target video.\n\nintegrated_multimodal_description: [Shot 1] Live-action, cinematic, a close shot begins with an intact drinking glass near the edge of a dark wooden table, while the same hand and sleeve visible in <Picture 1> approach from the right. The camera pushes in with small amplitude at slow speed as the fingertips strike the rim. The glass tips, falls, and hits the floor with a sharp impact; cracks spread through it as fragments slide outward. Toward the end, the moving pieces lose momentum and settle into the exact broken arrangement, hand position, camera angle, lighting, and final composition established by <Picture 1>.\n\noverall_soundscape: Fingertips tap the glass before it scrapes across the tabletop, falls, and breaks with a sharp crash. Small fragments scatter and gradually stop sliding across the floor.\n\nnon_diegetic_music: A low electronic pulse at a slow tempo, ending immediately after the glass breaks.\n```" }, "class_type": "PrimitiveStringMultiline" },
      // 重写提示词：开启时走 TextGenerate（#190）的改写结果，关闭时直连 #195 的原始提示词。
      "192": { "inputs": { "switch": rewrite, "on_false": ["195", 0], "on_true": ["190", 0] }, "class_type": "ComfySwitchNode" },
      // 改写器看图用的批量入口；BatchImagesNode 的 images 必填且不能为空，无参考图时整块不生成。
      ...(loadImageIds.length ? { "193": { "inputs": { ...batchImages }, "class_type": "BatchImagesNode" } } : {}),
      "194": { "inputs": { "vae_name": "minimax_h3_video_vae_int8_convrot.safetensors" }, "class_type": "VAELoader" },
      "195": { "inputs": { "value": request.prompt }, "class_type": "PrimitiveStringMultiline" },
      "196": { "inputs": { "attention": "comfy kitchen attention", "model": ["199", 0] }, "class_type": "ModelAttentionBackend" },
      "197": {
        "inputs": {
          "selection": "sol-attn",
          "selection.tau": 1.3,
          "start_percent": 0.3,
          "end_percent": 0.9,
          "dense_blocks": "",
          "min_tokens": 12288,
          "extra_tokens": 256,
          "sink_conditioning": "exact_kv_and_rows",
          "verbose": false,
          "model": ["196", 0]
        },
        "class_type": "BlockSparseAttention"
      },
      // Turbo（模型侧）：开 → 走 sol-attn 链（#197 ← #196 ← #199 turbo LoRA ← #171）；关 → 直接用 #171 的 LoRA 栈。
      "198": { "inputs": { "switch": ["202", 0], "on_false": ["171", 0], "on_true": ["197", 0] }, "class_type": "ComfySwitchNode" },
      "199": {
        "inputs": { "lora_name": "MiniMax-H3\\minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors", "strength_model": 0.75, "model": ["171", 0] },
        "class_type": "LoraLoaderModelOnly"
      },
      "200": { "inputs": { "sigmas": "1, .9882, .973, .9524, .9231, .878, .8, .6316, .4737, .1579, 0 " }, "class_type": "ManualSigmas" },
      // Turbo（采样侧）：开启时用 10 段 ManualSigmas（少步快出），关闭时用 BasicScheduler 的 30 步（慢而稳）。
      // 与 #198 同受 #202（turbo_mode）驱动，保持工作流原本「一个开关同时切模型与步数」的行为。
      "201": { "inputs": { "switch": ["202", 0], "on_false": ["177", 0], "on_true": ["200", 0] }, "class_type": "ComfySwitchNode" },
      "202": { "inputs": { "value": turbo }, "class_type": "PrimitiveBoolean" },
      ...loadImages
    };

    // 3. 提交任务并轮询结果。
    const promptRes = await this.tool.fetch(`${COMFY_URL}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow }),
      signal,
    });

    if (!promptRes.ok) {
      const detail = await promptRes.text().catch(() => "");
      throw new Error(`提交视频生成任务到 ComfyUI 失败，HTTP ${promptRes.status}${detail ? `：${detail.slice(0, 500)}` : ""}`);
    }

    const promptResult = (await promptRes.json()) as { prompt_id: string; error?: unknown };
    const promptId = promptResult.prompt_id;
    if (!promptId) {
      throw new Error(`未获取到 ComfyUI 的任务 ID${promptResult.error ? `：${JSON.stringify(promptResult.error).slice(0, 500)}` : ""}`);
    }

    let videoUrl = "";
    try {
      while (!signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const historyRes = await this.tool.fetch(`${COMFY_URL}/history/${promptId}`, { signal });
        if (!historyRes.ok) continue;

        const historyData = (await historyRes.json()) as Record<string, any>;
        const entry = historyData?.[promptId];
        if (!entry) continue;

        const outputs = entry.outputs;
        if (outputs) {
          for (const nodeId of Object.keys(outputs)) {
            const nodeOutput = outputs[nodeId];
            // 视频结果的存放位置随 ComfyUI 版本与插件而变：核心 SaveVideo 放在 images 里
            // （带 metadata.kind="video" 与 animated 标记），VideoHelperSuite 等放在 gifs 里。
            // 两处都取，先认显式的视频标记，再按扩展名兜底。
            const items = [...(nodeOutput?.gifs ?? []), ...(nodeOutput?.images ?? [])];
            const vidInfo = items.find((item: any) => item?.metadata?.kind === "video")
              ?? items.find((item: any) => /\.(mp4|webm|mkv|mov|gif|m4v)$/i.test(String(item?.filename ?? "")));
            if (vidInfo?.filename) {
              videoUrl = `${COMFY_URL}/view?filename=${encodeURIComponent(vidInfo.filename)}&subfolder=${encodeURIComponent(vidInfo.subfolder || "")}&type=${encodeURIComponent(vidInfo.type || "output")}`;
              break;
            }
          }
        }
        if (!videoUrl && entry.status?.status_str === "error") {
          throw new Error("ComfyUI 执行视频生成工作流失败，请检查工作流与模型");
        }
        break;
      }

      signal.throwIfAborted();
      if (!videoUrl) {
        throw new Error("未能获取生成的视频结果");
      }
    } finally {
      // 用户中止时任务仍留在 ComfyUI 里（画布「停止生成」只是断开了请求）：主动撤销，
      // 别让它白占显存跑完。已经拿到结果的不撤销——它本来就要结束了。
      if (this.signal?.aborted && !videoUrl) await cancelComfyTask(this.tool, promptId);
    }

    return [{ mediaType: "video", type: "url", url: videoUrl }];
  }
};
