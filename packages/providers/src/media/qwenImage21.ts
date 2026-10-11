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

function ratioParts(ratio?: string): [number, number] {
  const matched = /^(\d{1,4})\s*[:x×]\s*(\d{1,4})$/.exec(ratio ?? "");
  if (!matched) return [1, 1];
  const width = Number(matched[1]);
  const height = Number(matched[2]);
  return width > 0 && height > 0 ? [width, height] : [1, 1];
}

// 画布节点把「分辨率（百万像素）× 比例」推导成长边像素通过 request.size 传下来，这里按面积反算百万像素。
// 基数用 1024²（不是 10⁶）：画布的「1MP」就是 1024×1024，两边必须互逆才能 round-trip 回 1。
function megapixelsFromRequest(size?: string, ratio?: string): number {
  const longEdge = Number(size);
  if (!Number.isFinite(longEdge) || longEdge <= 0) return 1;
  const [width, height] = ratioParts(ratio);
  const area = longEdge * longEdge * (Math.min(width, height) / Math.max(width, height));
  const megapixels = area / (1024 * 1024);
  const nearest = Math.round(megapixels);
  return Math.abs(megapixels - nearest) <= 0.2 ? nearest : Math.round(megapixels * 10) / 10;
}

// 平台给图片生成的请求体是严格白名单（只有 providerId / modelId / prompt / images / ratio / size 会到达供应商），
// 因此画布节点把「重写提示词」关掉的状态挂在 size 前缀上：size = "<长边像素>"（重写）或 "+<长边像素>"（不重写）。
// 前缀不改变数值语义（Number("+1000") === 1000），不认这个约定的供应商行为不变。
function parseSize(raw?: string) {
  const text = String(raw ?? "");
  return { side: text.startsWith("+") ? text.slice(1) : text, rewrite: !text.startsWith("+") };
}

// ── LoRA 堆叠（ComfyUI 节点「🐈‍⬛StackLoras」/ Load LoRA Stack）────────────────────
// 与图生图供应商同一套：串在 #484 底模与 #496 缓存之间。选堆叠节点而不是串多个 LoraLoader，
// 是因为串 N 个就要 N 组节点与连线。供应商不能 import 模块（宿主 module.link 拒绝），函数内联在此。
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

export default {
  id: "qwenImage21",
  label: "Qwen Image 2.1 文生图",
  version: "2.2.1",
  apiUrl: COMFY_URL,
  readme: "接入本地 ComfyUI 的 Qwen Image 2.1 文生图工作流（可切换是否重写提示词）。停止生成时会撤销已提交到 ComfyUI 的任务（执行中的中断、排队中的移除），不会继续占用显存。",
  rules: [],
  models: [
    {
      id: "qwen_image_2_1",
      label: "Qwen Image 2.1 文生图",
      type: "image",
      mode: ["text"],
      // 工作流带提示词重写分支（#494 切换 #491 改写器 / #497 原始提示词），画布节点的「重写提示词」开关控制它。
      // 平台只接受纯 W:H 格式，提交前由 RATIO_LABEL 映射成 ResolutionSelector 的标签值。
      imageRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"],
      // 画布节点的百万像素选项：1MP / 2MP / 3MP / 4MP。
      imageSizes: ["1", "2", "3", "4"]
    }
  ],
  async generateImage(this: Context, request: ImageRequest): Promise<MediaAsset[]> {
    this.signal?.throwIfAborted();
    if (request.model !== "qwen_image_2_1" || !request.prompt.trim()) {
      throw new Error("模型或提示词无效");
    }

    const { side, rewrite } = parseSize(request.size);
    const aspectRatio = RATIO_LABEL[request.ratio ?? ""] ?? "1:1 (Square)";
    const megapixels = megapixelsFromRequest(side, request.ratio);
    // LoRA 名称直接决定堆叠节点入参，写错（换过路径、改过名）ComfyUI 只会报一句不指明节点的错。
    // 先对着工作流的枚举校一遍，把问题说清楚。
    const requestedLoras = readLoraEntries(request.loras);
    if (requestedLoras.length) {
      const available = new Set(await collectLoraNames(this.tool));
      const missing = requestedLoras.filter(entry => !available.has(entry.name)).map(entry => entry.name);
      if (missing.length) throw new Error(`找不到 LoRA：${missing.join("、")}。确认 ComfyUI 的 lora 模型目录里有该文件，且节点侧列表已刷新。`);
    }

    // 提示词：#491(TextGenerate.prompt) 是唯一注入点（改写模型读到的正文）。
    // #495 保持工作流自带的「提示词改写规则」文本作为 system_prompt，不注入用户提示词。
    // 分辨率的唯一控制点是 #13(ResolutionSelector)：aspect_ratio + megapixels，其输出喂给 #488 的宽高。
    const workflow = {
      "13": {
        "inputs": {
          "aspect_ratio": aspectRatio,
          "megapixels": megapixels,
          "multiple": 32
        },
        "class_type": "ResolutionSelector"
      },
      "461": {
        "inputs": {
          "filename_prefix": "Qwen_image_2.1",
          "format": "png",
          "format.bit_depth": "8-bit",
          "format.input_color_space": "sRGB",
          "images": ["489", 0]
        },
        "class_type": "SaveImageAdvanced"
      },
      "484": {
        "inputs": {
          "unet_name": "Qwen-Image-2.1\\qwen_image_2.1_int8_convrot.safetensors",
          "weight_dtype": "default"
        },
        "class_type": "UNETLoader"
      },
      "485": {
        "inputs": {
          "prompt": ["492", 0],
          "negative_prompt": "",
          "resolution": 1024,
          "clip": ["486", 0]
        },
        "class_type": "TextEncodeQwenImage21"
      },
      "486": {
        "inputs": {
          "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
          "type": "qwen_image",
          "device": "default"
        },
        "class_type": "CLIPLoader"
      },
      "487": {
        "inputs": {
          "vae_name": "qwen_image_2.1_vae_bf16.safetensors"
        },
        "class_type": "VAELoader"
      },
      "488": {
        "inputs": {
          "width": ["13", 0],
          "height": ["13", 1],
          "batch_size": 1
        },
        "class_type": "EmptyLatentImage"
      },
      "489": {
        "inputs": {
          "samples": ["490", 0],
          "vae": ["487", 0]
        },
        "class_type": "VAEDecode"
      },
      "490": {
        "inputs": {
          "seed": Math.floor(Math.random() * 1000000000000),
          "steps": 40,
          "cfg": 1,
          "sampler_name": "euler",
          "scheduler": "simple",
          "denoise": 1,
          "model": ["496", 0],
          "positive": ["485", 0],
          "negative": ["485", 1],
          "latent_image": ["488", 0]
        },
        "class_type": "KSampler"
      },
      "491": {
        "inputs": {
          "prompt": request.prompt,
          "max_length": 4096,
          "sampling_mode": "on",
          "sampling_mode.temperature": 1,
          "sampling_mode.top_k": 20,
          "sampling_mode.top_p": 0.95,
          "sampling_mode.min_p": 0,
          "sampling_mode.repetition_penalty": 1,
          "sampling_mode.seed": 447606998181262,
          "sampling_mode.presence_penalty": 1.5,
          "thinking": true,
          "use_default_template": true,
          "mtp": "auto",
          "clip": ["493", 0],
          "system_prompt": ["495", 0]
        },
        "class_type": "TextGenerate"
      },
      "492": {
        "inputs": {
          "source": ["494", 0]
        },
        "class_type": "PreviewAny"
      },
      "493": {
        "inputs": {
          "clip_name": "qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors",
          "type": "stable_diffusion",
          "device": "default"
        },
        "class_type": "CLIPLoader"
      },
      // 重写提示词：开启时用提示词改写器（#491）的输出，关闭时直连 #497 的原始提示词。
      "494": {
        "inputs": {
          "switch": rewrite,
          "on_true": ["491", 0],
          "on_false": ["497", 0]
        },
        "class_type": "ComfySwitchNode"
      },
      "495": {
        "inputs": {
          "value": "# Image Prompt Rewriting Expert\n\nYou turn a user's image request into one long English paragraph that describes the\nfinished image as if you were looking at it, plus the aspect ratio it should be\nrendered at. You are not talking to the user and not talking to a renderer: you are\nan observer reporting what is in the frame.\n\nWork through the eight steps below in order. Each step commits one decision; later\nsteps never revise an earlier one.\n\n## Step 1 — Read the brief and split it in two\n\nList what the user has fixed and what they have left open.\n\nFixed, and it must survive into your description unchanged: every string of text\nthey want shown, every named object, every count, every stated colour, every stated\nposition, and the aspect ratio if they gave one. Copy their text strings character\nfor character, in their own script, including punctuation and spacing.\n\nA third thing they may give you is an instruction about the job rather than about the\npicture — \"use double quotes\", \"no hard-edged blocks\", \"4K, no noise\", \"make sure the\ntext is sharp\". That is not content. Obey it silently where it applies and never echo\nit: the description states what is in the frame, never what must be done.\n\nOpen, and you must decide it: everything they did not mention. A three-word request\nand a three-hundred-word request both become a description of the same size, so a\nshort brief means you are inventing most of the frame, not writing less.\n\n## Step 2 — Fix the frame\n\nDecide the orientation from the subject, then pick the ratio.\n\nIf the user states a ratio, use it. Otherwise: `3:2` for anything horizontal and\n`2:3` for anything vertical — these are the two defaults and cover most images.\nUse `1:1` for a square badge, icon, album cover or single centred emblem, `16:9`\nfor a wide cinematic or presentation frame, `1:2` or `9:16` for a phone screen or a\ntall standing banner. `3:4`, `2:1`, `21:9`, `4:3`, `9:21`, `4:5`, `3:1`, `5:4`,\n`1:3` exist but only when the subject or the user really calls for them.\n\nThe ratio lives only in the `wh_ratio` field. Never write a ratio, a resolution, or\na pixel count into the description itself.\n\n## Step 3 — Write the opening sentence\n\nOne sentence, around twenty words. Name the medium, the style, the subject, and the\nbackground or palette; usually name the orientation too:\n\n`The image is a ⟨vertical / wide / square / tall⟩ ⟨style⟩ ⟨photograph · poster · illustration · scene · portrait · infographic · close-up · graphic · page · card · sheet · logo⟩ of ⟨subject⟩, ⟨the background and its palette⟩.`\n\n`This is a …` or a bare `A vertical realistic photograph of …` work equally well. The\nmedium noun is the one part that is never omitted.\n\nThe style word goes here — realistic, photorealistic, minimalist, flat-vector,\ncinematic, watercolour, isometric, editorial, hand-drawn, 3D-rendered, retro. Name\nit once here; you may echo it in the closing sentence.\n\n## Step 4 — Inventory before you write\n\nBefore any more prose, settle two lists.\n\nEvery element that will appear, each with a place in the frame: upper-left,\nacross the top, on the far right, in the lower-third, in the centre, in front of,\nbehind, tucked into the corner. You will need eight to fourteen such positional\nphrases, about ten typically, and they must reach the corners, the edges and the\ncentre — not cluster in the middle.\n\nEvery piece of text that will be legible in the image, in reading order.\n\n## Step 5 — Walk the frame\n\nNow describe it in order. Which order depends on how the frame is filled.\n\n**If the frame is divided into regions** — a poster, a page, an interface, a layout, a\nwide scene with several things in it — walk the regions:\n\n1. The background and the surface it sits on — this comes immediately after the\n   opening sentence, not at the end.\n2. The top band: headline, header bar, sky, ceiling, whatever occupies the top edge.\n3. Down and across the body of the frame: left side, then centre, then right side.\n   Give each region one or two sentences.\n4. The bottom band: footer, foreground, ground plane, base row.\n\n**If one subject fills the frame** — a portrait, a close-up, a single object — walk\nthe subject instead: the background and how far it falls off, then the subject's pose\nand where it is placed in the frame, then head and face, then body and each garment or\nsurface, then what is held or touching it, then whatever little is left at the edges.\nKeep using positional phrases inside the subject — in the upper-left of the frame,\nbehind the left shoulder, along the lower edge — so the frame stays locatable.\n\nRoughly a third of your sentences should open on the positional phrase itself —\n\"On the right side of the frame, …\", \"In the upper-left corner, …\", \"Across the\nlower third, …\" — so the reader always knows where they are looking.\n\nKeep it to one paragraph. Break to a new paragraph only when the image is genuinely\nbuilt from stacked regions — panels, cards, sections, slides — and then one\nparagraph per region, each opening on where that region sits.\n\n## Step 6 — Set every piece of text\n\nSkip this step if nothing in the image is meant to be read — a third of images have\nno legible text at all, and inventing signage for them is a mistake.\n\nOtherwise, for each string from your Step 4 list, in reading order, name where it sits,\nwhat it looks like, and what it says: `a bold black headline across the top reads \"…\"`.\n\nPut the string in straight double quotes, in its own script — Chinese, Russian,\nKorean, Japanese and Arabic text stays in Chinese, Russian, Korean, Japanese and\nArabic. Give its weight, colour, case and relative size. Describe a line break as a\nsecond line rather than putting a real newline inside the string. If a mark is not meant\nto be read — distant signage, a label behind glass, dense body copy — call it\nblurred, indistinct, or too small to read rather than inventing letters. If the image contains a chart\nor a table, its axes, tick labels, legend entries, series and cell values are text\ntoo: write them out.\n\n## Step 7 — Give the lighting its own sentence\n\nEvery image has light in it, and the description always accounts for it: the source,\nits direction, its quality, and the shadows and highlights it leaves. Soft diffused\ndaylight from a window on the left, hard overhead studio light, warm low sun, flat\neven ambient light for a diagram.\n\nOnce the contents are placed, give it a sentence of its own — `The lighting is …` —\nor, if the light is what makes a particular surface look the way it does, fold it into\nthat surface's sentence. Either way it is stated explicitly, not left implied.\n\n## Step 8 — Close with the whole frame\n\nEnd on a single sentence that steps back:\n\n`The overall composition ⟨is / uses / feels⟩ …`\n\n`The composition is …`, `The overall design …`, `The overall mood …`, `The overall\npalette …` and `The image has …` are the same move. Cover balance and symmetry, the\npalette, the style, and the mood in that one sentence. Write exactly one such\nsentence — do not follow it with a second summary.\n\n## Throughout\n\n**Size.** The description runs about twenty sentences and four to five hundred words,\nroughly twenty-five words a sentence. That is the same size whether the brief was three\nwords or three hundred: a dense frame with many regions and a lot of text runs longer, a\nsingle quiet subject runs shorter, but a thin brief never buys a thin description.\n\n**Observe, don't instruct.** Present tense, third person, declarative. No \"you\", no\n\"create\", no \"make sure\", no \"the AI should\". No quality boosters — no \"masterpiece\",\n\"8K\", \"highly detailed\", \"award-winning\".\n\n**Hedge what you cannot be certain of.** An observer describing a picture says\n\"appears to be\", \"likely\", \"suggesting\", and offers a pair — \"a notebook\nor a tablet\", \"wood or dark laminate\" — when the thing is genuinely ambiguous. Do\nthis often; it is the natural register here. Be flatly definite only about what the\nuser fixed.\n\n**Name colours with a modifier, almost never bare.** Deep navy, muted olive, pale\ncream, warm terracotta, soft dusty rose, blue-grey, off-white, charcoal, brownish-\ngreen. Hex codes only if the user gave them.\n\n**Give the material, not just the noun.** Brushed metal, matte plastic, glossy\nceramic, coarse linen, weathered wood, frosted glass, grain, scuffs, condensation,\nvisible brush strokes, paper fibre.\n\n**Enumerate; never summarise.** \"Several items\" and \"various decorations\" are not\ndescriptions. Say what each thing is. Write small counts as words — three, five,\ntwelve — and if something is partly hidden, say so and describe the visible part.\n\n**People get their observable surface.** Build, posture, where they are looking,\nexpression, hair, skin tone, and each garment with its colour and material. Age is a\nlife stage or a decade — a child, a teenager, a young adult, middle-aged, elderly,\nin her thirties — never a number of years. If a face is turned away or cropped, say\nthat instead of describing it.\n\n**Objects by class, not by brand.** A silver laptop, a mirrorless camera, a compact\nhatchback — unless the user named the brand. Photographic and design vocabulary is\nwelcome: shallow depth of field, bokeh, backlit, close-up, negative space,\ngrid, drop shadow.\n\n**Everything holds together physically.** Shadows fall away from the light, reflections\nmatch what is in front of the surface, scale is consistent between neighbouring\nobjects, and a surface reacts to what sits on it. If the user asked for something\nimpossible, describe it as the image shows it and let the rest of the scene stay\ncoherent around it.\n\n## Language\n\nThe description is always in English, whatever language the request arrives in. The\nonly exception is text shown inside the image, which stays in its own script.\n\n## Output format\n\n- Return the description and nothing else: one continuous paragraph of English, in a single line\nstarting on the very first character of your reply.\n- No JSON, no braces, no key names, no labels, no headings, no markdown, no code fences, and no quotation marks around the paragraph.\n- No preamble, no acknowledgement, no explanation, no summary, no notes, no closing remarks, no questions.\n- No ratio, no resolution, no pixel count, no timestamps.\n\nYour whole reply is used as the image prompt, so every extra word you add becomes part of the image.\n"
        },
        "class_type": "PrimitiveStringMultiline"
      },
      "496": {
        "inputs": {
          "device": "auto",
          "dtype": "default",
          "model": ["600", 0]
        },
        "class_type": "QwenImage21Cache"
      },
      // LoRA 堆叠：串在 #484 底模与 #496 缓存之间。堆叠节点 MODEL→MODEL 直连串接即可，
      // 12 个槽位（lora_01..12 / strength_01..12 / on_01..12）由画布侧按需下发，
      // 未指定的槽位一律填 None + 关闭，节点原样跳过，等价于没接 LoRA。
      "600": {
        "inputs": {
          "model": ["484", 0],
          ...buildLoraStackInputs(requestedLoras)
        },
        "class_type": LORA_STACK_NODE
      },
      // 关闭重写时喂给 #485.prompt 的原始提示词（#494 的 on_false）。
      "497": {
        "inputs": {
          "value": request.prompt
        },
        "class_type": "PrimitiveStringMultiline"
      }
    };

    const signal = AbortSignal.any([AbortSignal.timeout(300000), ...(this.signal ? [this.signal] : [])]);
    
    // 1. 提交 Prompt 任务
    const promptRes = await this.tool.fetch(`${COMFY_URL}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow }),
      signal,
    });

    if (!promptRes.ok) {
      throw new Error(`提交任务到 ComfyUI 失败，HTTP ${promptRes.status}`);
    }

    const promptResult = (await promptRes.json()) as { prompt_id: string };
    const promptId = promptResult.prompt_id;
    if (!promptId) {
      throw new Error("未获取到 ComfyUI 的任务 ID");
    }

    // 2. 轮询任务状态
    let imageUrl = "";
    try {
      while (!signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const historyRes = await this.tool.fetch(`${COMFY_URL}/history/${promptId}`, { signal });
        if (!historyRes.ok) continue;

        const historyData = (await historyRes.json()) as Record<string, any>;
        if (historyData && historyData[promptId]) {
          const outputs = historyData[promptId].outputs;
          if (outputs) {
            // 查找保存图片的节点输出
            for (const nodeId of Object.keys(outputs)) {
              const nodeOutput = outputs[nodeId];
              if (nodeOutput.images && nodeOutput.images.length > 0) {
                const imgInfo = nodeOutput.images[0];
                imageUrl = `${COMFY_URL}/view?filename=${encodeURIComponent(imgInfo.filename)}&subfolder=${encodeURIComponent(imgInfo.subfolder || "")}&type=${encodeURIComponent(imgInfo.type || "output")}`;
                break;
              }
            }
          }
          break;
        }
      }

      signal.throwIfAborted();
      if (!imageUrl) {
        throw new Error("未能获取生成的图片结果");
      }
    } finally {
      // 用户中止时任务仍留在 ComfyUI 里（画布「停止生成」只是断开了请求）：主动撤销，
      // 别让它白占显存跑完。已经拿到结果的不撤销——它本来就要结束了。
      if (this.signal?.aborted && !imageUrl) await cancelComfyTask(this.tool, promptId);
    }

    return [{ mediaType: "image", type: "url", url: imageUrl }];
  }
};
