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
  other?: Record<string, unknown>;
};

type Context = {
  config: Record<string, unknown>;
  signal?: AbortSignal;
  tool: { fetch: typeof fetch; fetchDetached: typeof fetch };
};

type MediaInput = { type?: string; data?: string; url?: string; mimeType?: string; name?: string };

type MediaAsset = { mediaType: "video"; type: "url"; url: string };

type GraphNode = { inputs: Record<string, unknown>; class_type: string };

const COMFY_URL = "http://127.0.0.1:8188";

// ResolutionSelector 的 aspect_ratio 只接受带标签的枚举值，画布节点传下来的是纯 W:H。
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

const DEFAULT_ASPECT = "16:9 (Widescreen)";
// 画布 #221「ResolutionSelector」的固定值，作为 mp 片段缺失时的兜底。
const DEFAULT_MEGAPIXELS = 0.9;
// 画布 #235「Float (duration)」的取值，作为节点未下发时长时的兜底。
const DEFAULT_DURATION = 12;
const MIN_DURATION = 1;
const MAX_DURATION = 15;

// 参考素材上限，与模型声明的混合参考能力（imageReference:9 / videoReference:3 / audioReference:3）一致。
const MAX_IMAGES = 9;
const MAX_VIDEOS = 3;
const MAX_AUDIOS = 3;

// 动态节点编号区间：画布自身节点最大到 264，这里从 900 起，避免冲突。
const LOAD_IMAGE_BASE = 900;
const LOAD_VIDEO_BASE = 920;
const VIDEO_PARTS_BASE = 940;
const LOAD_AUDIO_BASE = 960;

// 视频请求的平台字段是严格白名单（providerId / modelId / prompt / outputDirectory / images / videos /
// audios / ratio / resolution / duration / mode / generateAudio），没有图片请求那样的 size 通道。
// 因此画布节点把「百万像素 / 是否重写提示词 / 是否开启 Turbo」编进 resolution 的片段里：
//   resolution = "mp=1.6|rw=1|tb=1"
// 不含 "=" 的片段视为真实分辨率字符串，保留给声明了分辨率档位的模型；两者可共存。
function parseOutputSpec(raw?: string) {
  // 兜底与 minimaxH3Video 一致：默认开启 Turbo（10 段 sigmas）。原始画布导出的 #255 是 false，
  // 但画布节点总会显式下发 tb=1|0，兜底只影响不传 resolution 的调用方（脚本、AI 工具调用等）。
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

// 时长在画布上是 PrimitiveFloat「Float (duration)」(#235)，经 #234 的数学表达式
// （round(秒 × 24) 后再对齐到 frames ≡ 5 (mod 17)）换算成 #248.length 的帧数，fps 固定 24。
function clampDuration(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_DURATION;
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, value));
}

// VM 沙箱只注入了 Buffer/Blob/URL 等，没有 FormData，因此手工拼 multipart 正文。
function multipartFile(field: string, filename: string, mimeType: string, bytes: Buffer) {
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

// LoadImage / LoadVideo / LoadAudio 都靠扩展名识别文件，缺 mimeType 时按类型给一个可用的兜底。
function extensionOf(mimeType: string, fallback: string) {
  const subtype = mimeType.split("/")[1]?.toLowerCase() ?? "";
  if (subtype === "jpeg" || subtype === "jpg") return "jpg";
  if (subtype === "quicktime") return "mov";
  if (subtype === "mpeg") return "mp3";
  if (subtype === "x-wav" || subtype === "wave") return "wav";
  return /^[a-z0-9]{2,5}$/.test(subtype) ? subtype : fallback;
}

function isMedia(item: unknown): item is MediaInput {
  if (!item || typeof item !== "object") return false;
  const value = item as MediaInput;
  return typeof value.data === "string" ? value.data.length > 0 : typeof value.url === "string" && value.url.length > 0;
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

// 以用户导出的 API 工作流为基准的静态图。参考素材相关节点——LoadImage(182/186/188/191/193/194/262/
// 263/264)、LoadVideo(174)、GetVideoComponents(175)、LoadAudio(202)、BatchImagesNode(241)——以及
// #248 的 ref_* 连线、#238 的 image/video/audio 入参，都由 generateVideo 按实际接入数量动态生成，
// 因此这里不包含它们。前端专用、节点未声明的入参（StackLoras 的 Add LoRA / Remove empty rows，
// LoadVideo 的 video-preview）已剔除。
const BASE_GRAPH: Record<string, GraphNode> = {
      "92": {
            "inputs": {
                  "filename_prefix": "MiniMax/MiniMax_H3",
                  "format": "auto",
                  "format.codec": "auto",
                  "codec": "auto",
                  "video": [
                        "233",
                        0
                  ]
            },
            "class_type": "SaveVideo"
      },
      "150": {
            "inputs": {
                  "lora_01": "MiniMax-H3\\H3_Combat_V2.safetensors",
                  "strength_01": 0.6,
                  "on_01": true,
                  "lora_02": "MiniMax-H3\\Motion_Repair_V2.safetensors",
                  "strength_02": 0.3,
                  "on_02": true,
                  "lora_03": "MiniMax-H3\\H3_speed_slider_1.1.safetensors",
                  "strength_03": 6,
                  "on_03": true,
                  "lora_04": "None",
                  "strength_04": 1,
                  "on_04": true,
                  "lora_05": "None",
                  "strength_05": 1,
                  "on_05": true,
                  "lora_06": "None",
                  "strength_06": 1,
                  "on_06": true,
                  "lora_07": "None",
                  "strength_07": 1,
                  "on_07": true,
                  "lora_08": "None",
                  "strength_08": 1,
                  "on_08": true,
                  "lora_09": "None",
                  "strength_09": 1,
                  "on_09": true,
                  "lora_10": "None",
                  "strength_10": 1,
                  "on_10": true,
                  "lora_11": "None",
                  "strength_11": 1,
                  "on_11": true,
                  "lora_12": "None",
                  "strength_12": 1,
                  "on_12": true,
                  "model": [
                        "230",
                        0
                  ]
            },
            "class_type": "🐈‍⬛StackLoras"
      },
      "221": {
            "inputs": {
                  "aspect_ratio": "16:9 (Widescreen)",
                  "megapixels": 0.9,
                  "multiple": 32,
                  "preview_ratio": "16:9 (Widescreen)",
                  "preview_megapixels": 0.9
            },
            "class_type": "🐈‍⬛ResolutionSelector"
      },
      "224": {
            "inputs": {
                  "vae_name": "minimax_h3_audio_vae_fp32.safetensors"
            },
            "class_type": "VAELoader"
      },
      "225": {
            "inputs": {
                  "samples": [
                        "228",
                        0
                  ],
                  "vae": [
                        "224",
                        0
                  ]
            },
            "class_type": "VAEDecodeAudio"
      },
      "226": {
            "inputs": {
                  "samples": [
                        "228",
                        0
                  ],
                  "vae": [
                        "242",
                        0
                  ]
            },
            "class_type": "VAEDecode"
      },
      "227": {
            "inputs": {
                  "sampler_name": "er_sde"
            },
            "class_type": "KSamplerSelect"
      },
      "228": {
            "inputs": {
                  "noise": [
                        "232",
                        0
                  ],
                  "guider": [
                        "229",
                        0
                  ],
                  "sampler": [
                        "227",
                        0
                  ],
                  "sigmas": [
                        "254",
                        0
                  ],
                  "latent_image": [
                        "248",
                        1
                  ]
            },
            "class_type": "SamplerCustomAdvanced"
      },
      "229": {
            "inputs": {
                  "model": [
                        "245",
                        0
                  ],
                  "conditioning": [
                        "248",
                        0
                  ]
            },
            "class_type": "BasicGuider"
      },
      "230": {
            "inputs": {
                  "unet_name": "MiniMax-H3\\Cobijada_H3_Hybrid_Uncensored_pruned_hybrid_int8_convrot_pruned.safetensors",
                  "weight_dtype": "default"
            },
            "class_type": "UNETLoader"
      },
      "231": {
            "inputs": {
                  "clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
                  "type": "minimax",
                  "device": "default"
            },
            "class_type": "CLIPLoader"
      },
      "232": {
            "inputs": {
                  "noise_seed": 405106531190402
            },
            "class_type": "RandomNoise"
      },
      "233": {
            "inputs": {
                  "fps": 24,
                  "bit_depth": 8,
                  "color_space": "sRGB",
                  "codec": "none",
                  "images": [
                        "226",
                        0
                  ],
                  "audio": [
                        "225",
                        0
                  ]
            },
            "class_type": "CreateVideo"
      },
      "234": {
            "inputs": {
                  "expression": "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17",
                  "values.a": [
                        "235",
                        0
                  ]
            },
            "class_type": "ComfyMathExpression"
      },
      "235": {
            "inputs": {
                  "value": 12
            },
            "class_type": "PrimitiveFloat"
      },
      "236": {
            "inputs": {
                  "value": 30
            },
            "class_type": "PrimitiveInt"
      },
      "237": {
            "inputs": {
                  "clip_name": "qwen3.8_27b_w4a8.safetensors",
                  "type": "stable_diffusion",
                  "device": "default"
            },
            "class_type": "CLIPLoader"
      },
      "238": {
            "inputs": {
                  "prompt": [
                        "243",
                        0
                  ],
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
                  "clip": [
                        "237",
                        0
                  ],
                  "system_prompt": [
                        "239",
                        0
                  ]
            },
            "class_type": "TextGenerate"
      },
      "239": {
            "inputs": {
                  "value": "# Full-Reference Mode Rewrite Output Format Guide\n\n## 1. Task Overview\n\nThis guide defines the output format for full-reference video rewriting.\n\nFull-reference mode describes a target video while explicitly tracking referenced visual and audio content through stable reference labels. The output records how referenced people, objects, environments, images, videos, and audio assets are preserved, transferred, or referenced throughout the target video.\n\nA complete full-reference rewrite consists of six sections in the following order:\n\n```text\nsubject_definitions\nsummary\nretention_analysis\ndetailed_description\noverall_soundscape\nnon_diegetic_music\n```\n\nThe basic shot, camera movement, speaker, dialogue, singing, on-screen text, and sound formats follow the rules defined in this guide.\n\n---\n\n# 2. Overall Output Structure\n\nA complete full-reference rewrite uses the following structure:\n\n```text\nsubject_definitions:\n...\n\nsummary:\n...\n\nretention_analysis:\n...\n\ndetailed_description:\n...\n\noverall_soundscape:\n...\n\nnon_diegetic_music:\n...\n```\n\nThe six sections have the following purposes:\n\n| Section                | Purpose                                                                  |\n| ---------------------- | ------------------------------------------------------------------------ |\n| `subject_definitions`  | Defines referenced content and assigns stable reference labels           |\n| `summary`              | Summarizes the task type, target video, and main reference relationships |\n| `retention_analysis`   | Describes how referenced content is preserved, transferred, or reused    |\n| `detailed_description` | Describes visuals, actions, shots, sound, and dialogue in playback order |\n| `overall_soundscape`   | Summarizes ambience and physical sounds across the full video            |\n| `non_diegetic_music`   | Describes audience-only background music                                 |\n\nWrite all six sections in English.\n\nPreserve the original language only for dialogue and lyrics inside `<d>`, and for text visibly present in the scene.\n\n---\n\n# 3. Reference Labels and Definitions\n\nFull-reference rewrites use four types of labels:\n\n| Label         | Meaning                                                                                                           |\n| ------------- | ----------------------------------------------------------------------------------------------------------------- |\n| `<Subject N>` | Visible content abstracted from reference assets that can be reused or modified in the target video               |\n| `<Picture N>` | A reference image used as a concrete target frame or shot-planning anchor                                         |\n| `<Video N>`   | A reference video that provides an editing source, continuation starting point, or whole-video temporal structure |\n| `<Audio N>`   | An audio signal that is copied or referenced                                                                      |\n\nOnce a reference label is assigned to a piece of content, it keeps the same meaning across:\n\n```text\nsubject_definitions\nsummary\nretention_analysis\ndetailed_description\noverall_soundscape\nnon_diegetic_music\n```\n\nDo not assign a new label to the same referenced content later.\n\n---\n\n## 3.1 `<Subject N>`\n\n`<Subject N>` represents reusable visible content that will actually be used in the target video.\n\nIt can represent:\n\n* People\n* Animals\n* Objects\n* Scenes\n* Backgrounds\n* Environments\n* Clothing\n* Props\n* Interfaces\n* Visual effects\n* Styles\n* Actions\n* Expressions\n* Poses\n\nA subject represents the content unit used in the target video rather than the source file itself.\n\nOne subject may be defined by multiple reference assets.\n\nOne reference asset may provide multiple subjects.\n\nExample:\n\n```text\n<Subject 1> is the young woman in <Picture 1>, with long dark hair, a blue cardigan, and a thin silver necklace.\n```\n\nWhen the same subject comes from multiple assets, combine the sources and state what each asset provides:\n\n```text\n<Subject 1> is the woman whose appearance comes from <Picture 1> and whose walking motion comes from <Video 1>.\n```\n\n---\n\n## 3.2 `<Picture N>`\n\nUse a standalone `<Picture N>` when the reference image itself serves as:\n\n* A target frame\n* A first frame\n* A keyframe\n* A last frame\n* An edited keyframe\n* A composition anchor\n* A storyboard or shot-planning reference\n\nExample:\n\n```text\n<Picture 2> is the first frame of [Shot 1], showing a woman seated beside a café window.\n```\n\nIf an image only defines a character, scene, costume, style, or other reusable content, cite the image source inside the corresponding `<Subject N>` definition instead of creating a standalone picture entry.\n\nWhen an image acts as a storyboard or shot-planning reference, state which shots it maps to and what planning information it provides:\n\n```text\n<Picture 3> is a storyboard reference for [Shot 1] and [Shot 2], defining their viewpoint, subject placement, and shot order.\n```\n\n---\n\n## 3.3 `<Video N>`\n\n`<Video N>` is reserved for whole-video relationships, including:\n\n* Editing an original video\n* Continuing from the end of an original video\n* Referencing the original video's camera movement\n* Referencing cuts\n* Referencing rhythm\n* Referencing temporal structure\n\nExample:\n\n```text\n<Video 1> is the source video for the target video edit.\n```\n\nIf a person, object, scene, action, or effect from a reference video is reused as visible content, define that content under `<Subject N>`.\n\n`<Video N>` identifies the source asset or structural source and does not replace subject labels.\n\n---\n\n## 3.4 `<Audio N>`\n\n`<Audio N>` represents a standalone audio asset or an enabled synchronized audio track from a reference video.\n\nCommon uses include:\n\n* Copying all or part of an audio signal\n* Referencing a background-music style\n* Referencing a speaker's voice timbre and delivery\n* Using dialogue, lyrics, or sound effects from the original audio\n* Referencing beat, rhythm, or audio continuity\n\nWhen an `<Audio N>` explicitly corresponds to a target speaker, reuse that speaker's global ID in the definition:\n\n```text\n<Subject N> (Sx)\n```\n\nor use a stable voice description followed by `(Sx)` when the speaker does not correspond to a separately defined subject.\n\nExample:\n\n```text\n<Audio 1> is the voice-timbre reference for <Subject 1> (S1).\n```\n\nWhen one audio asset serves multiple roles, describe those roles in one natural sentence rather than creating additional subsections.\n\n---\n\n## 3.5 Visual and Audio Tracks from the Same Reference Video\n\n`<Video N>` and `<Audio N>` are numbered independently.\n\nEach index indicates only the label's order within its own category. The indices do not encode a pairing between the two categories.\n\nThe same reference video may therefore correspond to:\n\n```text\n<Video 1>\n<Audio 2>\n```\n\nDifferent indices do not prevent them from coming from the same source asset.\n\nAn ordinary reference video does not create `<Audio N>` merely because the file contains sound.\n\nAn `<Audio N>` definition primarily states the audio's role.\n\nState the shared source only when needed to remove provenance ambiguity:\n\n```text\n<Video 1> is the source video for the target video edit.\n<Audio 2> is the synchronized audio track of <Video 1> and is reused in the target video.\n```\n\n---\n\n# 4. `summary`\n\n`summary` uses one short English paragraph to summarize the target video and its reference relationships.\n\nIt begins with a square-bracketed task-type prefix.\n\nSupported task types are:\n\n```text\n[reference generation]\n[video editing]\n[video continuation]\n[audio reuse]\n[audio reference]\n[keyframe completion]\n```\n\nWhen a task satisfies multiple relationships, combine the task types with `+` and do not repeat a type.\n\nExamples:\n\n```text\n[reference generation] ...\n```\n\n```text\n[video editing + audio reuse] ...\n```\n\n```text\n[video continuation + keyframe completion] ...\n```\n\n```text\n[reference generation + audio reference] ...\n```\n\nChoose task types according to the actual role each reference asset plays in the target video.\n\nThe mere presence of a video or audio asset does not automatically create a corresponding task type.\n\nIf a reference video provides camera movement, cuts, or rhythm as generation guidance, use:\n\n```text\nreference generation\n```\n\nWhen an existing source video is directly modified, use:\n\n```text\nvideo editing\n```\n\nWhen new content continues, extends, resumes, or transitions from an existing source video, use:\n\n```text\nvideo continuation\n```\n\nWhen the same audio signal is reused in full or in part, use:\n\n```text\naudio reuse\n```\n\nWhen the audio signal is used only as a reference for timbre, rhythm, music style, dialogue, lyrics, sound-effect texture, or continuity, use:\n\n```text\naudio reference\n```\n\nWhen an image serves as a concrete target frame, keyframe, or other frame anchor, use:\n\n```text\nkeyframe completion\n```\n\nDo not introduce new reference labels in `summary`.\n\nUse only the labels already defined in `subject_definitions`.\n\nFor video-editing tasks, the summary begins after the task-type prefix with:\n\n```text\nThe target video is an edited version of <Video 1>.\n```\n\n---\n\n# 5. `retention_analysis`\n\n`retention_analysis` describes how each referenced item is preserved, transferred, copied, or referenced in the target video.\n\nUse one line for each reference label.\n\nPreserve the meaning established in `subject_definitions`.\n\n---\n\n## 5.1 Visible Content\n\n`<Subject N>`, `<Picture N>`, and `<Video N>` use the following relationship markers:\n\n| Relationship marker   | Meaning                                                                                                       |\n| --------------------- | ------------------------------------------------------------------------------------------------------------- |\n| `fully_preserved`     | The defined role of the referenced content is fully preserved                                                 |\n| `partially_preserved` | The referenced content is still used, but some defined characteristics are changed or only partially retained |\n| `attribute_transfer`  | Referenced characteristics are transferred to a different identifiable target subject                         |\n| `weak_reference`      | Only broad similarity in style, category, composition, or atmosphere is retained                              |\n\nSubject entry:\n\n```text\n<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - ...\n```\n\nPicture entry:\n\n```text\n<Picture 2> ([Shot 1] first frame): fully_preserved - ...\n```\n\nVideo-structure entry:\n\n```text\n<Video 1> (cut and pacing structure): weak_reference - ...\n```\n\nChoose the relationship marker according to the reference role established in `subject_definitions`.\n\nDo not treat newly added actions, backgrounds, or plot events in the target video as losses of reference fidelity.\n\n---\n\n## 5.2 Audio\n\n`<Audio N>` uses the following relationship markers:\n\n| Relationship marker | Meaning                                                                                                                      |\n| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |\n| `fully_copy`        | The complete source audio serves as the target video's complete final audio track                                            |\n| `partially_copy`    | Only part of the timeline or selected audio layers are copied, or other sounds are added, removed, or replaced after copying |\n| `reference`         | The signal is not copied directly; only timbre, rhythm, music style, dialogue content, or sound texture is referenced        |\n| `weak_reference`    | Only broad similarity in category or atmosphere is retained                                                                  |\n\nExample:\n\n```text\n<Audio 1>: fully_copy - <Audio 1> is reused 1:1 as the target video's complete final audio track.\n```\n\nExample:\n\n```text\n<Audio 2>: reference - the target speaker follows <Audio 2>'s voice timbre and measured delivery without copying the original signal.\n```\n\nDo not write `(Sx)` in `retention_analysis`.\n\n---\n\n# 6. `detailed_description`\n\n`detailed_description` is the main body of the full-reference rewrite.\n\nIt describes:\n\n* Visual style\n* Composition\n* Subject appearance\n* Subject position\n* Environment\n* Lighting\n* Props\n* Actions\n* State changes\n* Camera movement\n* Shot changes\n* Dialogue\n* Singing\n* Diegetic audio\n* Reference relationships\n\nWrite the description in target-video playback order.\n\nInsert reference labels where they apply.\n\nEvery detail should correspond to something visible or audible in the target video or to a defined reference relationship.\n\n---\n\n## 6.1 Basic Format\n\nThe body is written in English.\n\nPreserve the original language of dialogue, lyrics, and visible text.\n\n`[Shot 1]` marks the opening shot and has no timestamp.\n\nLater shots use:\n\n```text\n[Shot N] At MM:SS.mmm, ...\n```\n\nCut times must be strictly increasing and fall within the video duration.\n\nWrite camera movement as natural English within the current shot.\n\nGive vocal sources stable IDs such as `(S1)`, `(S2)`, and subsequent IDs.\n\nWrite dialogue and lyrics as:\n\n```text\n<d>[Language] ...</d>\n```\n\nUse `<scenetrans>` for dialogue or lyrics crossing a cut.\n\nUse `<cutoff>` when speech or lyrics are truncated by the end of the video.\n\n---\n\n## 6.2 Style and Opening Composition\n\nAt the beginning of `[Shot 1]`, establish the overall style and initial composition.\n\nCommon style expressions include:\n\n```text\nCinematic\nlive-action\n2D-animated\n3D CG\nclaymation\nwatercolor\nvintage film\n```\n\nIn Full-Reference Mode, derive the visual style and initial composition from the referenced material when applicable.\n\nExample:\n\n```text\nThe target video uses a realistic cinematic live-action style with soft lighting and a slightly desaturated color palette.\n\n[Shot 1] A medium-wide shot establishes <Subject 1>, the coffee-shop environment with its exposed brick wall, orange tufted sofa, patterned pillows, neon sign, and wooden coffee table.\n```\n\n---\n\n## 6.3 Shots and Cuts\n\nDo not add a timestamp to the first shot.\n\nUse sequential shot numbers for later shots.\n\nExample:\n\n```text\n[Shot 2] At 00:03.500, the shot cuts to...\n```\n\nFor ordinary cuts, use natural expressions such as:\n\n```text\nthe camera cuts to\nthe shot cuts to\nthe shot transitions to\nthe shot changes to\nthe shot switches to\n```\n\nCross-dissolve, fade, or wipe may be used when explicitly requested.\n\nA cut should introduce new information about the subject, space, state, viewpoint, or time.\n\nWhen only the distance or a slight angle needs to change, use camera motion.\n\n---\n\n## 6.4 Camera Motion\n\nA complete camera-motion expression has three dimensions:\n\n1. Motion type\n2. Amplitude\n3. Speed\n\nAdd amplitude and speed when they are meaningful.\n\nMedium amplitude and normal speed are usually omitted.\n\n### Motion Type\n\n| Expression                               | Description                                                        |\n| ---------------------------------------- | ------------------------------------------------------------------ |\n| `Zoom In / Zoom Out`                     | The focal length changes while the camera body remains stationary  |\n| `Push In / Pull Out`                     | The camera moves forward / backward                                |\n| `Pan Left / Pan Right`                   | The camera remains in place while the lens pivots horizontally     |\n| `Truck Left / Truck Right`               | The camera translates horizontally                                 |\n| `Tilt Up / Tilt Down`                    | The camera remains in place while the lens pivots vertically       |\n| `Pedestal Up / Pedestal Down`            | The entire camera moves upward / downward                          |\n| `Arc Shot`                               | The camera moves in an arc around the subject                      |\n| `Tracking Shot`                          | The camera follows a moving subject                                |\n| `Static Shot`                            | The camera position and lens remain still                          |\n| `Shake Slightly / Shake Strongly`        | Slight / strong camera shake                                       |\n| `POV`                                    | The subject's point of view                                        |\n| `Roll Clockwise / Roll Counterclockwise` | The camera rolls clockwise / counterclockwise around the lens axis |\n\n### Amplitude\n\n```text\nwith small amplitude\nwith large amplitude\n```\n\n### Speed\n\n```text\nat slow speed\nat fast speed\n```\n\nWrite camera movement as a natural action within the shot.\n\nExample:\n\n```text\nThe camera pushes in with small amplitude at slow speed toward the folded letter in her hands.\n```\n\n```text\nThe camera pans right with large amplitude at fast speed, revealing the open doorway.\n```\n\n```text\nThe camera holds a static shot as the runner exits the frame.\n```\n\n---\n\n## 6.5 Using Reference Labels in Shots\n\nAt the first clear appearance of an important `<Subject N>`, describe:\n\n* Its referenced characteristics\n* Its position in the frame\n* Its current action\n* The visible environment or interaction relevant to the shot\n\nContinue using the same label in later shots without redefining what the label represents.\n\nFor concrete frame anchors, use natural phrasing such as:\n\n```text\nthe shot begins from <Picture 1>\n```\n\n```text\nthe shot's keyframe corresponds to <Picture 2>\n```\n\n```text\nthe shot ends on <Picture 3>\n```\n\nWhen editing or continuing an original video, cite `<Video N>` naturally where its source state, structure, or continuation relationship applies.\n\nCite `<Audio N>` in the shot or semantic phase where the audio relationship is active.\n\n---\n\n## 6.6 Speakers, Audio Sources, Dialogue, and Singing\n\nSubjects who speak, sing, or produce an off-screen human voice use stable IDs:\n\n```text\n(S1)\n(S2)\n(S3)\n```\n\nWhen multiple already-numbered speakers speak or sing together, use a compound ID:\n\n```text\n(S1,S2)\n```\n\nA speaker keeps the same ID across shots.\n\nCharacters who never vocalize receive no speaker ID.\n\nWhen a speaker first appears, provide enough information from the visual and audio context to establish a stable identity, such as:\n\n* Character type\n* Age\n* Gender\n* On-screen or off-screen status\n* Pitch\n* Timbre\n* Speaking rate\n* Accent\n\nPlace the speaker's identifying phrase, ID, action, and delivery outside `<d>`.\n\nInside `<d>`, include only:\n\n1. The language tag\n2. The actual spoken content\n\nPreserve the original spoken words and punctuation as provided.\n\nExample:\n\n```text\n<Subject 2> (S1) turns toward the woman and says, <d>[English] Last summer, I went to my grandfather's house. He talked about you.</d>\n```\n\nWhen a referenced subject physically speaks, retain both the visual reference label and speaker ID:\n\n```text\n<Subject 2> (S1)\n```\n\nIf the same subject speaks off-screen, retain the same form and mark it as `off-screen`.\n\nWhen the speaker does not correspond to a defined subject, use a stable voice description followed by `(Sx)`.\n\nExample:\n\n```text\nA calm male voice with a low pitch (S2) speaks off-screen.\n```\n\n---\n\n## 6.7 Voiceover\n\nFor voiceover, use the exact phrase:\n\n```text\nsays in an off-screen voiceover\n```\n\nImmediately after every voiceover `<d>` block, state that the corresponding on-screen character's lips remain closed.\n\nExample:\n\n```text\nThe man (S1) says in an off-screen voiceover: <d>[English] I still remember that road.</d> while his lips remain completely closed.\n```\n\n---\n\n## 6.8 Dialogue and Lyrics Across Cuts\n\nWhen the same line of dialogue or lyrics crosses a cut, use `<scenetrans>` at the connecting points in both parts.\n\nExplicitly state that the audio continues across the cut.\n\nContinuity may be expressed with:\n\n```text\ncontinues seamlessly across the cut\ncontinues uninterrupted into the next shot\ncarries over from the previous shot\nremains audible across the transition\n```\n\nUse `<cutoff>` when speech or lyrics are truncated by the end of the video.\n\n---\n\n## 6.9 Reference Audio and Speakers\n\n`<Subject N>` identifies the referenced subject.\n\n`(Sx)` identifies the actual speaker.\n\nWhen the subject speaks, use:\n\n```text\n<Subject N> (Sx)\n```\n\nWhen an `<Audio N>` provides only a voice-timbre reference, the target speaker retains the corresponding `(Sx)`.\n\nExample:\n\n```text\n<Subject 3> (S1) speaks with the clear youthful voice timbre referenced from <Audio 1>.\n```\n\nWhen verbal content exists only as a cue within directly reused BGM or a complete soundtrack, use `<Audio N>` as the audible source and do not create an additional `(Sx)`.\n\nWhen a concrete person, character, narrator, or other independent vocal source produces the voice, assign and reuse `(Sx)` for that source.\n\nWhen dialogue, narration, or lyrics from reference audio are directly reused, or when the task explicitly requests their reperformance, preserve the exact source words and original language inside `<d>`.\n\nWrite:\n\n```text\n[unclear]\n```\n\nfor unintelligible spans instead of guessing or paraphrasing them.\n\nStandardize punctuation to the basic written marks needed to express the sentence, such as:\n\n```text\n,\n.\n?\n!\n```\n\nEnd complete statements, questions, and exclamations with `.`, `?`, or `!` respectively before `</d>`.\n\nWhen only timbre, rhythm, emotion, or delivery is referenced, do not carry the original dialogue from the reference audio into the target video.\n\nAssign `(Sx)` once according to the order of actual vocal events in the target video.\n\nReuse the corresponding ID at every actual vocal event in `detailed_description`.\n\nAn `<Audio N>` definition bound to a target speaker in `subject_definitions` reuses the same `(Sx)` and does not assign a new speaker ID independently.\n\n---\n\n## 6.10 On-Screen Text\n\nPlace any banner, sign, label, subtitle, or neon text that is actually visible on screen in English double quotation marks.\n\nPreserve the original text and punctuation verbatim.\n\nDo not translate visible text.\n\nExample:\n\n```text\nA red neon sign reading \"营业中\" glows above the doorway.\n```\n\n---\n\n## 6.11 Description Detail\n\n`detailed_description` should be detailed and explicit.\n\nFor each shot, establish:\n\n* Current composition\n* Subject appearance\n* Subject position\n* Environment\n* Lighting\n* Actions\n* State changes\n* Camera movement\n* Current sound\n* Dialogue\n* Points where referenced content actually appears\n* Points where referenced content takes effect\n\nAvoid reducing the description to a plot summary or a list of reference relationships.\n\nFor generation tasks, `detailed_description` is normally 350–500 English words.\n\nDialogue-dense content prioritizes fitting the complete spoken timeline rather than mechanically reaching a word count.\n\nVideo-editing descriptions scale with the complexity of the source video and do not have to follow the generation-task range.\n\nA single shot does not automatically justify a shorter description. Distribute detail across multiple shots according to their information load.\n\n---\n\n# 7. `overall_soundscape`\n\n`overall_soundscape` summarizes ambience and physical sounds across the full video.\n\nUse 1–4 English sentences in one continuous paragraph.\n\nInclude sounds such as:\n\n* Wind\n* Rain\n* Traffic\n* Footsteps\n* Fabric movement\n* Impacts\n* Breathing\n* Laughter\n* Panting\n* Other physical action sounds\n* Non-verbal human sounds\n\nDialogue, singing, and diegetic music already belong in `detailed_description` and should not be repeated here.\n\nWhen reference audio is used, state its copy or reference relationship in the appropriate audio section.\n\nExample:\n\n```text\noverall_soundscape: Quiet indoor room tone and a low ventilation hum continue throughout the video.\n```\n\nWhen copied ambience or sound effects form part of the target soundscape:\n\n```text\noverall_soundscape: The copied ambience layer from <Audio 1> continues throughout the target video.\n```\n\nUse:\n\n```text\nN/A\n```\n\nonly when the user explicitly requests complete silence throughout the video.\n\n---\n\n# 8. `non_diegetic_music`\n\n`non_diegetic_music` describes background music that the characters cannot hear and that is audible only to the audience.\n\nUse 1–3 English sentences.\n\nDescribe:\n\n* Instrumentation\n* Tempo\n* Rhythm\n* Dynamic changes\n* Volume development\n\nDo not use abstract mood words or explain the emotional function of the score.\n\nSinging, instruments, radio, television, or phone music audible to the characters are diegetic events and belong in `detailed_description`.\n\nExample:\n\n```text\nnon_diegetic_music: Sparse piano notes at a slow tempo, joined by sustained low strings that gradually increase in volume before fading out.\n```\n\nUse:\n\n```text\nN/A\n```\n\nwhen there is no non-diegetic music.\n\nWhen reference audio provides audience-only score:\n\n```text\nnon_diegetic_music: <Audio 2> is directly reused as the complete audience-only score.\n```\n\nWhen the same reference audio provides both ambience and audience-only music, describe the corresponding relationship in each appropriate section.\n\n---\n\n# 9. Complete Full-Reference Example\n\n```text\nsubject_definitions:\n<Subject 1> is the coffee-shop environment in <Picture 1>, featuring an exposed brick wall, an orange tufted sofa with patterned pillows, a neon sign, and a wooden coffee table.\n<Subject 2> is the fluffy white Samoyed in <Picture 2>, <Picture 3>, and <Picture 4>, with thick white fur, pointed ears, a dark nose, and a curved tail.\n<Subject 3> is the young blonde woman in <Video 1>, with long blonde hair and a light-pink button-down shirt with rolled-up sleeves.\n<Subject 4> is the young man in <Video 2>, with short wavy brown hair and a dark-grey hoodie with drawstrings.\n<Audio 1> is the voice-timbre reference for <Subject 3> (S1), containing a spoken English vocal layer.\n\nsummary:\n[reference generation + audio reference] The target video shows <Subject 3> eating a cookie in <Subject 1>. <Subject 4> enters with <Subject 2>, which lunges toward the cookie. The three-shot exchange uses <Audio 1> as the voice-timbre reference for <Subject 3> and ends with a canned audience laugh.\n\nretention_analysis:\n<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - the exposed brick wall, orange tufted sofa, patterned pillows, neon sign, and wooden coffee table are retained.\n<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - the Samoyed's thick white fur, pointed ears, dark nose, and curved tail are retained.\n<Subject 3> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - the blonde woman's identity, long hair, and light-pink shirt are retained.\n<Subject 4> (appears in [Shot 1], [Shot 2]): fully_preserved - the young man's short wavy brown hair and dark-grey hoodie are retained.\n<Audio 1>: reference - its vocal timbre guides the dialogue delivery of <Subject 3> without copying the original signal.\n\ndetailed_description:\nThe target video uses a realistic multi-camera sitcom style with warm indoor lighting.\n\n[Shot 1] A medium shot establishes <Subject 1>, the coffee shop with its exposed brick wall, orange tufted sofa, patterned pillows, neon sign, and wooden coffee table. <Subject 3> (S1), the young woman with long blonde hair and a light-pink button-down shirt with rolled-up sleeves, sits on the sofa holding a chocolate-chip cookie. From the left, <Subject 4>, the young man with short wavy brown hair and a dark-grey hoodie with drawstrings, enters holding the leash of <Subject 2>, the thick-furred white Samoyed with pointed ears, a dark nose, and a curved tail. The dog lunges toward the cookie and pulls the leash taut. <Subject 3> (S1) jerks her hand back and, using the clear youthful voice timbre referenced from <Audio 1>, exclaims with light annoyance, <d>[English] Hey! Watch your dog!</d> She closes her lips and guards the cookie while <Subject 4> pulls the dog back.\n\n[Shot 2] At 00:03.000, the shot cuts to a close-up of <Subject 4> (S2), the young man in the dark-grey hoodie from Shot 1, sitting beside <Subject 3> on the sofa and holding <Subject 2> securely in his arms. <Subject 4> (S2) says in a casual young male voice with a playful tone and an easy conversational pace, <d>[English] He just likes cookies more than me.</d> He closes his mouth into an apologetic smile and strokes the dog's thick white fur.\n\n[Shot 3] At 00:05.000, the shot cuts to a close-up of <Subject 3> (S1), the blonde woman in the light-pink shirt from Shot 1. Her annoyance softens as she looks toward the Samoyed. <Subject 3> (S1) replies in the same clear youthful voice referenced from <Audio 1> with an amused cadence, <d>[English] Well, he has good taste at least.</d> She smiles and raises the cookie in a small toast-like gesture. A classic canned audience laugh begins immediately after the line and continues through the final frame.\n\noverall_soundscape:\nSoft indoor coffee-shop room tone continues throughout the scene.\n\nnon_diegetic_music:\nN/A\n```\n"
            },
            "class_type": "PrimitiveStringMultiline"
      },
      "240": {
            "inputs": {
                  "switch": true,
                  "on_false": [
                        "243",
                        0
                  ],
                  "on_true": [
                        "238",
                        0
                  ]
            },
            "class_type": "ComfySwitchNode"
      },
      "242": {
            "inputs": {
                  "vae_name": "minimax_h3_video_vae_int8_convrot.safetensors"
            },
            "class_type": "VAELoader"
      },
      "243": {
            "inputs": {
                  "value": "| 001 | 3秒 | 远景，正面，手持后退 | 三名搜巡士兵从浓雾中朝镜头方向奔逃，身影若隐若现。 | 急促脚步、喘息、雾中风声 | 三名疲惫的中世纪搜巡士兵穿过浓白浓雾，远景，湿冷草地，低饱和灰白色调，写实电影质感 | 镜头不稳定地向后移动，三名士兵从雾中冲近，奔跑急促，雾气翻涌，保持三人服装与人数一致 |\n| 002 | 3秒 | 中景，侧向跟拍 | 士兵们冲出雾层，脚下地面逐渐清晰，跌跌撞撞冲向草地。 | 脚步踩过湿草、急喘 | 士兵冲出白雾进入开阔草地，中景侧面，盔甲沾湿、衣物凌乱 | 摄影机平行跟随，士兵连续跑出雾区，脚步不稳但不停下 |\n| 003 | 3秒 | 广角全景，低机位 | 三人分散冲向远处缓坡，白雾留在身后。 | 风声、脚步 | 开阔草地与远处缓坡，三名士兵奔跑，白雾形成清晰边界，低机位广角 | 镜头略微后拉，三人穿过前景向缓坡奔跑，雾界留在画面后方 |\n| 004 | 3秒 | 近景，低机位 | 最后一名士兵摔倒，手掌撑地，泥草飞溅。 | 重摔声、痛喘 | 士兵在湿草地摔倒的近景，泥土与草叶，紧张写实 | 士兵失去平衡摔倒，手掌撑地，身体向前滑动，动作自然连续 |"
            },
            "class_type": "PrimitiveStringMultiline"
      },
      "244": {
            "inputs": {
                  "attention": "comfy kitchen attention",
                  "model": [
                        "246",
                        0
                  ]
            },
            "class_type": "ModelAttentionBackend"
      },
      "245": {
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
                  "model": [
                        "244",
                        0
                  ]
            },
            "class_type": "BlockSparseAttention"
      },
      "246": {
            "inputs": {
                  "switch": [
                        "255",
                        0
                  ],
                  "on_false": [
                        "150",
                        0
                  ],
                  "on_true": [
                        "247",
                        0
                  ]
            },
            "class_type": "ComfySwitchNode"
      },
      "247": {
            "inputs": {
                  "lora_name": "MiniMax-H3\\minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
                  "strength_model": 0.75,
                  "model": [
                        "150",
                        0
                  ]
            },
            "class_type": "LoraLoaderModelOnly"
      },
      "248": {
            "inputs": {
                  "prompt": [
                        "240",
                        0
                  ],
                  "width": [
                        "221",
                        0
                  ],
                  "height": [
                        "221",
                        1
                  ],
                  "length": [
                        "234",
                        1
                  ],
                  "ref_image_size": "match",
                  "clip": [
                        "231",
                        0
                  ],
                  "vae": [
                        "242",
                        0
                  ],
                  "audio_vae": [
                        "224",
                        0
                  ]
            },
            "class_type": "MiniMaxH3ReferenceToVideo"
      },
      "252": {
            "inputs": {
                  "sigmas": "1, .9882, .973, .9524, .9231, .878, .8, .6316, .4737, .1579, 0 "
            },
            "class_type": "ManualSigmas"
      },
      "253": {
            "inputs": {
                  "scheduler": "beta",
                  "steps": [
                        "236",
                        0
                  ],
                  "denoise": 1,
                  "model": [
                        "245",
                        0
                  ]
            },
            "class_type": "BasicScheduler"
      },
      "254": {
            "inputs": {
                  "switch": [
                        "255",
                        0
                  ],
                  "on_false": [
                        "253",
                        0
                  ],
                  "on_true": [
                        "252",
                        0
                  ]
            },
            "class_type": "ComfySwitchNode"
      },
      "255": {
            "inputs": {
                  "value": false
            },
            "class_type": "PrimitiveBoolean"
      }
};

export default {
  id: "minimaxH3ReferenceVideo",
  label: "MiniMax H3 参考转视频工作流",
  version: "2.1.2",
  apiUrl: COMFY_URL,
  readme: "接入本地 ComfyUI 的 MiniMax H3 全功能参考转视频工作流（画布 #248 MiniMaxH3ReferenceToVideo）：把接入的图片（最多 9 张）、视频（最多 3 个，其音轨一并作为参考）与音频（最多 3 个）作为参考素材，与提示词一起决定输出。不接任何素材时按文生视频提交。画布节点的「高宽比」「百万像素」驱动 ResolutionSelector（#221）；时长（1–15 秒）写入 Float (duration)（#235），经数学表达式换算成帧数（fps 24）；重写提示词切换 TextGenerate 改写分支（#240，携带完整的全参考改写指南）；Turbo 一个布尔同时驱动模型链（#150 的 LoRA 堆栈与 #247 的 ref2v turbo LoRA，#246）与采样步数（10 段 sigmas 与 30 步 BasicScheduler，#254）。未显式下发 Turbo 时默认开启（与 MiniMax H3 视频工作流一致）。停止生成时会撤销已提交到 ComfyUI 的任务（执行中的中断、排队中的移除），不会继续占用显存。",
  rules: [],
  models: [
    {
      id: "minimax_h3_ref2v",
      label: "MiniMax H3 参考转视频",
      type: "video",
      // 参考转视频把图片、视频、音频统一当作「参考素材」，没有首帧/尾帧语义，因此只声明文生视频
      // 与混合参考两种模式；素材数量上限对齐平台的能力写法。
      mode: ["text", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      // 画布节点的「高宽比」驱动 ResolutionSelector（#221）；「百万像素」调它的 megapixels。
      // 平台只接受纯 W:H 格式，提交前由 RATIO_LABEL 映射成带标签的枚举值。
      imageRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"],
      imageSizes: ["0.4", "0.9", "1.6", "2"],
    },
  ],
  async generateVideo(this: Context, request: VideoRequest): Promise<MediaAsset[]> {
    this.signal?.throwIfAborted();
    if (request.model !== "minimax_h3_ref2v" || !request.prompt.trim()) {
      throw new Error("模型或提示词无效");
    }

    const images = (Array.isArray(request.images) ? request.images : []).filter(isMedia).slice(0, MAX_IMAGES);
    const videos = (Array.isArray(request.videos) ? request.videos : []).filter(isMedia).slice(0, MAX_VIDEOS);
    const audios = (Array.isArray(request.audios) ? request.audios : []).filter(isMedia).slice(0, MAX_AUDIOS);

    const { megapixels: requestMegapixels, rewrite, turbo } = parseOutputSpec(request.resolution);
    const megapixels = clampMegapixels(requestMegapixels);
    const aspectRatio = RATIO_LABEL[request.ratio ?? ""] ?? DEFAULT_ASPECT;

    const signal = AbortSignal.any([AbortSignal.timeout(900000), ...(this.signal ? [this.signal] : [])]);

    // 把接入的参考素材逐个上传到 ComfyUI 的 input 目录，拿回可供 LoadImage / LoadVideo / LoadAudio
    // 使用的文件名。/upload/image 是 ComfyUI 的通用上传入口，三种媒体类型都能收。
    // 文件名只使用 ASCII，避免非 UTF-8 环境下中文名被写坏。
    const upload = async (item: MediaInput, index: number, kind: string, tag: string, fallbackExtension: string, defaultMime: string) => {
      signal.throwIfAborted();
      const base64 = typeof item.data === "string" ? item.data.replace(/^data:[^;]+;base64,/, "") : "";
      let bytes: Buffer | undefined;
      if (base64) bytes = Buffer.from(base64, "base64");
      else if (typeof item.url === "string" && /^https?:\/\//i.test(item.url)) {
        const downloaded = await this.tool.fetch(item.url, { signal });
        if (!downloaded.ok) throw new Error(`读取第 ${index + 1} 个${kind}失败，HTTP ${downloaded.status}`);
        bytes = Buffer.from(await downloaded.arrayBuffer());
      }
      if (!bytes || !bytes.length) throw new Error(`第 ${index + 1} 个${kind}内容无效`);
      const mimeType = typeof item.mimeType === "string" && item.mimeType ? item.mimeType : defaultMime;
      const filename = `toonflow_h3_ref_${tag}_${Date.now()}_${index}.${extensionOf(mimeType, fallbackExtension)}`;
      const form = multipartFile("image", filename, mimeType, bytes);
      const response = await this.tool.fetch(`${COMFY_URL}/upload/image`, {
        method: "POST",
        headers: { "Content-Type": form.contentType },
        body: form.body,
        signal,
      });
      if (!response.ok) throw new Error(`上传第 ${index + 1} 个${kind}失败，HTTP ${response.status}`);
      const result = (await response.json()) as { name?: string; subfolder?: string };
      const name = typeof result?.name === "string" ? result.name : "";
      if (!name) throw new Error(`第 ${index + 1} 个${kind}未返回文件名`);
      return result.subfolder ? `${result.subfolder}/${name}` : name;
    };

    const graph: Record<string, GraphNode> = JSON.parse(JSON.stringify(BASE_GRAPH));

    // 1. 参考图片：逐张生成 LoadImage，并喂给 #248 的 ref_images 与 #241 的批量入口。
    const refImages: Record<string, unknown> = {};
    const imageNodes: Record<string, unknown> = {};
    for (let index = 0; index < images.length; index++) {
      const nodeId = String(LOAD_IMAGE_BASE + index);
      graph[nodeId] = { inputs: { image: await upload(images[index]!, index, "参考图", "image", "png", "image/png") }, class_type: "LoadImage" };
      refImages[`ref_images.ref_image_${index}`] = [nodeId, 0];
      imageNodes[`images.image${index}`] = [nodeId, 0];
    }

    // 2. 参考视频：LoadVideo → GetVideoComponents，画面与音轨分别作为两类参考。
    const refVideos: Record<string, unknown> = {};
    let firstVideo: [string, number] | undefined;
    for (let index = 0; index < videos.length; index++) {
      const loadId = String(LOAD_VIDEO_BASE + index);
      const partsId = String(VIDEO_PARTS_BASE + index);
      const file = await upload(videos[index]!, index, "参考视频", "video", "mp4", "video/mp4");
      // LoadVideo 只声明了 file 一个入参，画布导出里的 video-preview 是前端专用预览字段。
      graph[loadId] = { inputs: { file }, class_type: "LoadVideo" };
      graph[partsId] = { inputs: { video: [loadId, 0] }, class_type: "GetVideoComponents" };
      refVideos[`ref_videos.ref_video_${index}`] = [partsId, 0];
      refVideos[`ref_video_audios.ref_video_audio_${index}`] = [partsId, 1];
      if (!firstVideo) firstVideo = [partsId, 0];
    }

    // 3. 参考音频。
    const refAudios: Record<string, unknown> = {};
    let firstAudio: [string, number] | undefined;
    for (let index = 0; index < audios.length; index++) {
      const nodeId = String(LOAD_AUDIO_BASE + index);
      graph[nodeId] = { inputs: { audio: await upload(audios[index]!, index, "参考音频", "audio", "flac", "audio/flac") }, class_type: "LoadAudio" };
      refAudios[`ref_audios.ref_audio_${index}`] = [nodeId, 0];
      if (!firstAudio) firstAudio = [nodeId, 0];
    }

    // 4. 参考转视频节点与改写器的素材入口。BatchImagesNode 的 images 必填且不能为空，
    //    无参考图时整块不生成；TextGenerate 的三个素材入口都是可选的，缺失时不接。
    graph["248"]!.inputs = { ...graph["248"]!.inputs, ...refImages, ...refVideos, ...refAudios };
    const textGenerate = graph["238"]!.inputs;
    if (images.length) {
      graph["241"] = { inputs: imageNodes, class_type: "BatchImagesNode" };
      textGenerate.image = ["241", 0];
    } else delete textGenerate.image;
    if (firstVideo) textGenerate.video = firstVideo; else delete textGenerate.video;
    if (firstAudio) textGenerate.audio = firstAudio; else delete textGenerate.audio;

    // 5. 画布节点下发的参数：画幅与百万像素驱动 ResolutionSelector，时长写入 Float (duration)，
    //    提示词与两个开关分别对应文本、改写分支与 Turbo 分支。
    graph["221"]!.inputs = { ...graph["221"]!.inputs, aspect_ratio: aspectRatio, preview_ratio: aspectRatio, megapixels, preview_megapixels: megapixels };
    graph["235"]!.inputs.value = clampDuration(request.duration);
    graph["240"]!.inputs.switch = rewrite;
    graph["255"]!.inputs.value = turbo;
    graph["243"]!.inputs.value = request.prompt;

    const promptRes = await this.tool.fetch(`${COMFY_URL}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph }),
      signal,
    });

    if (!promptRes.ok) {
      const detail = await promptRes.text().catch(() => "");
      throw new Error(`提交参考视频生成任务到 ComfyUI 失败，HTTP ${promptRes.status}${detail ? `：${detail.slice(0, 500)}` : ""}`);
    }

    const promptResult = (await promptRes.json()) as { prompt_id?: string; error?: unknown };
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
          throw new Error("ComfyUI 执行参考视频生成工作流失败，请检查工作流与模型");
        }
        break;
      }

      signal.throwIfAborted();
      if (!videoUrl) {
        throw new Error("未能获取生成的参考视频结果");
      }
    } finally {
      // 用户中止时任务仍留在 ComfyUI 里（画布「停止生成」只是断开了请求）：主动撤销，
      // 别让它白占显存跑完。已经拿到结果的不撤销——它本来就要结束了。
      if (this.signal?.aborted && !videoUrl) await cancelComfyTask(this.tool, promptId);
    }

    return [{ mediaType: "video", type: "url", url: videoUrl }];
  }
};
