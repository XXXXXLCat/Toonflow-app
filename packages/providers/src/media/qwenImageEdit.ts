type ImageRequest = {
  model: string;
  prompt: string;
  images?: unknown[];
  mask?: unknown;
  n?: number;
  ratio?: string;
  size?: string;
  quality?: string;
  outputFormat?: string;
  // 可叠加的 LoRA，按顺序应用，最多 12 条（画布面板默认显示 4 行，可加到 12 行）。
  loras?: { name?: string; strength?: number }[];
  other?: Record<string, unknown>;
};

type MediaInput = { type?: string; data?: string; url?: string; mimeType?: string; name?: string };

type Context = {
  config: Record<string, unknown>;
  signal?: AbortSignal;
  tool: { fetch: typeof fetch; fetchDetached: typeof fetch };
};

type MediaAsset = { mediaType: "image"; type: "url"; url: string };

const COMFY_URL = "http://127.0.0.1:8188";

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

// ResolutionSelector 的 aspect_ratio 是固定枚举，凡是枚举里没有的比例都只能绕开它直传宽高：
// 全景的 2:1（球面）与 4:1（圆柱）——等距柱状投影对比例是硬要求，差一点球面贴图就会拉伸，不能就近取整到 21:9；
// 扩图按「原图比例 × 方向 × 幅度」算出的动态比例（如 8:3）同理。
function ratioValueOf(ratio?: string): number {
  const [width, height] = (ratio ?? "").split(":").map(Number);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? width / height : 0;
}

// 画布节点对「能吃参考图」的模型按「等效面积边长」传尺寸（≈ √出图面积，与 TextEncodeQwenImage21.resolution 同义）：
// 跟随参考图比例时比例未知，只能用面积表达百万像素。这里换算回 ResolutionSelector 需要的百万像素。
// 基数用 1024²（不是 10⁶）：画布的「1MP」就是 1024×1024，两边必须互逆才能 round-trip 回 1。
function megapixelsOf(side?: string): number {
  const value = Number(side);
  const megapixels = Number.isFinite(value) && value > 0 ? (value * value) / (1024 * 1024) : 1;
  // ResolutionSelector.megapixels 是 0.1~16、step 0.1 的浮点。
  return Math.min(16, Math.max(0.1, Math.round(megapixels * 10) / 10));
}
// 平台给图片生成的请求体是严格白名单（只有 providerId / modelId / prompt / images / ratio / size 会到达供应商），
// 因此画布节点把「重写提示词」关掉的状态挂在 size 前缀上：size = "<边长>"（重写）或 "+<边长>"（不重写）。
// 前缀不改变数值语义（Number("+1000") === 1000），不认这个约定的供应商行为不变。
function parseSize(raw?: string) {
  const text = String(raw ?? "");
  return { side: text.startsWith("+") ? text.slice(1) : text, rewrite: !text.startsWith("+") };
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

// ── LoRA 堆叠（ComfyUI 节点「🐈‍⬛StackLoras」/ Load LoRA Stack）────────────────────
// 串在 #502 底模与 #509 缓存之间。选它而不是串多个 LoraLoader：串 N 个就要 N 组节点与连线，
// 画布上不可维护；堆叠节点把 12 个槽位压成一个（lora_N / strength_N / on_N），未用的槽位跳过。
// 节点是 MODEL→MODEL 直连。供应商不能 import 模块（宿主用 module.link 拒绝），所以函数内联在此。
const LORA_STACK_SLOTS = 12;
/** 堆叠节点的类名，含零宽字符 U+200D，必须与 ComfyUI 注册的完全一致。 */
const LORA_STACK_NODE = "🐈‍⬛StackLoras";
const loraSlotKey = (prefix: string, index: number) => `${prefix}_${String(index).padStart(2, "0")}`;

/**
 * 画布通过 loras 字段传（与 size/ratio 同级，最多 12 条）。超出截断——堆叠节点只有 12 槽。
 * strength 原样透传（画布与堆叠节点同口径，都是 -10~10 的权重，缺省 1）；
 * 负值表示反转 LoRA。越界收敛到 ±10，避免 ComfyUI 收到异常权重。
 */
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

/** 转成堆叠节点 inputs。未用的槽位填 None + on=false，节点原样跳过，等价于没接 LoRA。 */
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

/** 从 ComfyUI 读堆叠节点当前的 LoRA 枚举，作为提交前的校验依据。读不到就返回空集（不拦生成）。 */
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


export default {
  id: "qwenImageEdit",
  label: "Qwen Image 2.1 图像编辑工作流",
  version: "2.4.0",
  apiUrl: COMFY_URL,
  readme: "接入本地 ComfyUI 的 Qwen Image 2.1 图像编辑工作流（图生图）。默认跟随参考图比例；接入方传 ratio 时按所选比例重绘。除通用比例外还支持全景专用的 2:1（720° 球面）与 4:1（360° 圆柱）——这两个不在 ResolutionSelector 的枚举里，提交时按面积算出宽高直传给 EmptyLatentImage。停止生成时会撤销已提交到 ComfyUI 的任务（执行中的中断、排队中的移除），不会继续占用显存。",
  rules: [],
  models: [
    {
      id: "qwen_image_edit",
      label: "Qwen Image 2.1 图像编辑",
      type: "image",
      mode: ["singleImage", "multiReference"],
      // 工作流带提示词重写分支（#514 切换 #516 改写器 / #518 原始提示词），画布节点的「重写提示词」开关控制它。
      // 平台只接受纯 W:H 格式，提交前由 RATIO_LABEL 映射成 ResolutionSelector 的标签值。
      // 2:1 / 4:1 是全景专用比例：ResolutionSelector 的枚举里没有，由 PANORAMA_RATIO 走宽高直传。
      imageRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9", "2:1", "4:1"],
      // 画布节点的百万像素选项：1MP / 2MP / 3MP / 4MP。
      imageSizes: ["1", "2", "3", "4"]
    }
  ],
  async generateImage(this: Context, request: ImageRequest): Promise<MediaAsset[]> {
    this.signal?.throwIfAborted();
    if (request.model !== "qwen_image_edit" || !request.prompt.trim()) {
      throw new Error("模型或提示词无效");
    }
    // LoRA 名称直接决定堆叠节点的入参，写错（换过路径、改过名、目录不匹配）ComfyUI 只会报
    // 一句不指明是哪个节点的错误。先在这里对着工作流的枚举校一遍，把问题说清楚。
    const requestedLoras = readLoraEntries(request.loras);
    if (requestedLoras.length) {
      const available = new Set(await collectLoraNames(this.tool));
      const missing = requestedLoras.filter(entry => !available.has(entry.name)).map(entry => entry.name);
      if (missing.length) throw new Error(`找不到 LoRA：${missing.join("、")}。确认 ComfyUI 的 lora 模型目录里有该文件，且节点侧列表已刷新。`);
    }

    const references = (Array.isArray(request.images) ? request.images : [])
      .map(item => (item && typeof item === "object" ? item as MediaInput : undefined))
      .filter((item): item is MediaInput => !!item)
      // 参考图上限 6 张：每张都要 VAE 编码进序列，耗时随张数线性上升；超出的会被丢弃。
      .slice(0, 6);
    if (!references.length) throw new Error("请先接入参考图片");

    const signal = AbortSignal.any([AbortSignal.timeout(300000), ...(this.signal ? [this.signal] : [])]);

    // 1. 把接入的参考图逐张上传到 ComfyUI 的 input 目录，拿回可供 LoadImage 使用的文件名。
    const uploaded: string[] = [];
    for (let index = 0; index < references.length; index++) {
      signal.throwIfAborted();
      const reference = references[index]!;
      const base64 = typeof reference.data === "string" ? reference.data.replace(/^data:[^;]+;base64,/, "") : "";
      let bytes: Buffer | undefined;
      if (base64) bytes = Buffer.from(base64, "base64");
      else if (typeof reference.url === "string" && /^https?:\/\//i.test(reference.url)) {
        const downloaded = await this.tool.fetch(reference.url, { signal });
        if (!downloaded.ok) throw new Error(`读取第 ${index + 1} 张参考图失败，HTTP ${downloaded.status}`);
        bytes = Buffer.from(await downloaded.arrayBuffer());
      }
      if (!bytes || !bytes.length) throw new Error(`第 ${index + 1} 张参考图内容无效`);
      const mimeType = typeof reference.mimeType === "string" && reference.mimeType ? reference.mimeType : "image/png";
      const filename = `toonflow_ref_${Date.now()}_${index}.${extensionOf(mimeType)}`;
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

    // 指定比例模式：接入方传下 ratio，主 latent 走 ResolutionSelector（#517 → #505）算出的宽高。
    // 跟随参考图模式：接入方不传 ratio，主 latent 取参考图编码（#508 的 on_false → #510），比例由参考图决定。
    const { side: requestSide, rewrite } = parseSize(request.size);
    const specifying = typeof request.ratio === "string" && request.ratio.length > 0;
    const aspectRatio = RATIO_LABEL[request.ratio ?? ""] ?? "1:1 (Square)";
    // 仅指定比例模式下会被真正执行（#517 的 megapixels）。
    const megapixels = megapixelsOf(requestSide);
    // TextEncodeQwenImage21.resolution 是「等效面积边长」：参考图会等比缩放到约 resolution × resolution 的面积。
    // 该输入 step=32、范围 0..4096，因此吸附到 32 的倍数并夹紧；0 表示沿用参考图原尺寸。
    const side = Math.round(Number(requestSide));
    const resolution = Number.isFinite(side) && side > 0
      ? Math.min(4096, Math.max(32, Math.round(side / 32) * 32))
      : 0;

    // 2. 按实际接入数量生成 LoadImage 节点，并接线到文本编码器与提示词增强器。
    const workflow: Record<string, { inputs: Record<string, unknown>; class_type: string }> = {};
    const loadImageIds = uploaded.map((_, index) => String(900 + index));
    loadImageIds.forEach((nodeId, index) => {
      workflow[nodeId] = { inputs: { image: uploaded[index] }, class_type: "LoadImage" };
    });
    const encoderImages: Record<string, [string, number]> = {};
    const batchImages: Record<string, [string, number]> = {};
    loadImageIds.forEach((nodeId, index) => {
      encoderImages[`images.image_${index + 1}`] = [nodeId, 0];
      batchImages[`images.image${index}`] = [nodeId, 0];
    });
    // LoRA 堆叠的槽位内容随请求变；未指定时全填 None + 关闭，节点跳过，等价于没接。
    const loraStackInputs = buildLoraStackInputs(readLoraEntries(request.loras));

    Object.assign(workflow, {
      "461": {
        inputs: {
          filename_prefix: "Qwen_image_2.1",
          format: "png",
          "format.bit_depth": "8-bit",
          "format.input_color_space": "sRGB",
          images: ["506", 0]
        },
        class_type: "SaveImageAdvanced"
      },
      "502": {
        inputs: {
          unet_name: "Qwen-Image-2.1\\qwen_image_2.1_int8_convrot.safetensors",
          weight_dtype: "default"
        },
        class_type: "UNETLoader"
      },
      "503": {
        inputs: {
          clip_name: "qwen3vl_8b_int8_convrot.safetensors",
          type: "qwen_image",
          device: "default"
        },
        class_type: "CLIPLoader"
      },
      "504": {
        inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" },
        class_type: "VAELoader"
      },
      "505": {
        inputs: { width: ["517", 0], height: ["517", 1], batch_size: 1 },
        class_type: "EmptyLatentImage"
      },
      "506": {
        inputs: { samples: ["507", 0], vae: ["504", 0] },
        class_type: "VAEDecode"
      },
      "507": {
        inputs: {
          seed: Math.floor(Math.random() * 1000000000000),
          steps: 40,
          cfg: 1,
          sampler_name: "euler",
          scheduler: "simple",
          denoise: 1,
          model: ["509", 0],
          positive: ["510", 0],
          negative: ["510", 1],
          latent_image: ["508", 0]
        },
        class_type: "KSampler"
      },
      // 跟随参考图（默认）时取参考图编码出的 latent（图生图）；开启「指定比例」后走 ResolutionSelector 的空 latent。
      "508": {
        inputs: { switch: specifying, on_false: ["510", 2], on_true: ["505", 0] },
        class_type: "ComfySwitchNode"
      },
      // LoRA 堆叠：串在 #502 底模与 #509 缓存之间。堆叠节点 MODEL→MODEL，直连串接即可，
      // 12 个槽位（lora_01..12 / strength_01..12 / on_01..12）由节点侧按需下发，
      // 未指定的槽位一律填 None + 关闭，节点会原样跳过，等价于没接 LoRA。
      "600": {
        inputs: { model: ["502", 0], ...loraStackInputs },
        class_type: LORA_STACK_NODE
      },
      "509": {
        inputs: { device: "auto", dtype: "default", model: ["600", 0] },
        class_type: "QwenImage21Cache"
      },
      "510": {
        inputs: {
          // 提示词来自「增强器」输出；#514 必须 switch=true，否则取到未接线的 on_false 会得到 None。
          prompt: ["513", 0],
          negative_prompt: "",
          resolution,
          clip: ["503", 0],
          vae: ["504", 0],
          ...encoderImages
        },
        class_type: "TextEncodeQwenImage21"
      },
      "511": {
        inputs: {
          clip_name: "qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors",
          type: "qwen_image",
          device: "default"
        },
        class_type: "CLIPLoader"
      },
      // 提示词增强器的改写规则（system_prompt）。当前为占位符，请替换为实际的编辑改写规则。
      "512": {
        inputs: { value: "# Edit Prompt Enhancer" },
        class_type: "PrimitiveStringMultiline"
      },
      "513": {
        inputs: { source: ["514", 0] },
        class_type: "PreviewAny"
      },
      // 重写提示词：开启时用提示词增强器（#516）的输出，关闭时直连 #518 的原始提示词。
      "514": {
        inputs: { switch: rewrite, on_true: ["516", 0], on_false: ["518", 0] },
        class_type: "ComfySwitchNode"
      },
      "515": {
        inputs: { ...batchImages },
        class_type: "BatchImagesNode"
      },
      "516": {
        inputs: {
          prompt: request.prompt,
          max_length: 4096,
          sampling_mode: "on",
          "sampling_mode.temperature": 1,
          "sampling_mode.top_k": 20,
          "sampling_mode.top_p": 0.95,
          "sampling_mode.min_p": 0,
          "sampling_mode.repetition_penalty": 1,
          "sampling_mode.seed": 891836227295375,
          "sampling_mode.presence_penalty": 0,
          thinking: false,
          use_default_template: true,
          mtp: "auto",
          clip: ["511", 0],
          image: ["515", 0],
          system_prompt: ["512", 0]
        },
        class_type: "TextGenerate"
      },
      "517": {
        inputs: { aspect_ratio: aspectRatio, megapixels, multiple: 32 },
        class_type: "ResolutionSelector"
      },
      // 关闭重写时喂给 #510.prompt 的原始提示词（#514 的 on_false）。
      "518": {
        inputs: { value: request.prompt },
        class_type: "PrimitiveStringMultiline"
      }
    });

    // 枚举外的比例绕开 ResolutionSelector：按面积与比例算出宽高，直接写进 EmptyLatentImage，
    // 并摘掉不再被任何人引用的 #517（留着会是个没有下游的孤立节点）。
    const ratio = request.ratio?.trim();
    const ratioValue = ratio && !RATIO_LABEL[ratio] ? ratioValueOf(ratio) : 0;
    if (ratioValue) {
      // 基数与画布一致（1024²），否则全景/扩图的出图尺寸会对不上画布档位。
      const area = megapixels * 1024 * 1024;
      // 与 ResolutionSelector 的 multiple=32 保持一致，避免出图尺寸不是模型要的倍数。
      const snap = (value: number) => Math.max(32, Math.round(value / 32) * 32);
      workflow["505"]!.inputs.width = snap(Math.sqrt(area * ratioValue));
      workflow["505"]!.inputs.height = snap(Math.sqrt(area / ratioValue));
      delete workflow["517"];
    }
    // 3. 提交任务并轮询结果。
    const promptRes = await this.tool.fetch(`${COMFY_URL}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow }),
      signal,
    });

    if (!promptRes.ok) {
      const detail = await promptRes.text().catch(() => "");
      throw new Error(`提交图像编辑任务到 ComfyUI 失败，HTTP ${promptRes.status}${detail ? `：${detail.slice(0, 500)}` : ""}`);
    }

    const promptResult = (await promptRes.json()) as { prompt_id: string; error?: unknown };
    const promptId = promptResult.prompt_id;
    if (!promptId) {
      throw new Error(`未获取到 ComfyUI 的任务 ID${promptResult.error ? `：${JSON.stringify(promptResult.error).slice(0, 500)}` : ""}`);
    }

    let imageUrl = "";
    try {
      while (!signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const historyRes = await this.tool.fetch(`${COMFY_URL}/history/${promptId}`, { signal });
        if (!historyRes.ok) continue;

        const historyData = (await historyRes.json()) as Record<string, any>;
        const entry = historyData?.[promptId];
        if (!entry) continue;

        const outputs = entry.outputs;
        if (outputs) {
          for (const nodeId of Object.keys(outputs)) {
            const nodeOutput = outputs[nodeId];
            if (nodeOutput?.images?.length) {
              const imgInfo = nodeOutput.images[0];
              imageUrl = `${COMFY_URL}/view?filename=${encodeURIComponent(imgInfo.filename)}&subfolder=${encodeURIComponent(imgInfo.subfolder || "")}&type=${encodeURIComponent(imgInfo.type || "output")}`;
              break;
            }
          }
        }
        if (!imageUrl && entry.status?.status_str === "error") {
          throw new Error("ComfyUI 执行图像编辑工作流失败，请检查工作流与模型");
        }
        break;
      }

      signal.throwIfAborted();
      if (!imageUrl) {
        throw new Error("未能获取编辑后的图片结果");
      }
    } finally {
      // 用户中止时任务仍留在 ComfyUI 里（画布「停止生成」只是断开了请求）：主动撤销，
      // 别让它白占显存跑完。已经拿到结果的不撤销——它本来就要结束了。
      if (this.signal?.aborted && !imageUrl) await cancelComfyTask(this.tool, promptId);
    }

    return [{ mediaType: "image", type: "url", url: imageUrl }];
  }
};
