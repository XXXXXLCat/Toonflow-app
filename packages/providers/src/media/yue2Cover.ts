type MediaInputLike = { data?: string; url?: string; mimeType?: string; name?: string; text?: string };

type AudioRequest = {
  model: string;
  text?: string;
  prompt?: string;
  audios?: MediaInputLike[];
  format?: string;
  quality?: string;
  seed?: number;
  other?: Record<string, unknown>;
};

type Context = {
  config: Record<string, unknown>;
  signal?: AbortSignal;
  tool: { fetch: typeof fetch; fetchDetached: typeof fetch };
};

type MediaAsset = { mediaType: "audio"; type: "url"; url: string };

const COMFY_URL = "http://127.0.0.1:8188";

// SaveAudioAdvanced 只声明了 flac / mp3 / opus。别的格式（wav / ogg）能过提交校验，
// 却在**执行时**抛 "Unsupported audio format"，表现为没有产物、一直等到超时——
// 所以这里按白名单收口，不认的一律回落 mp3。
// quality 是 format 的子入参，只对 mp3（V0 / 128k / 320k）与 opus（64k / 96k / 128k / 192k / 320k）存在，
// flac 没有这个入参；档位与 ComfyUI 节点里看到的一致。
const AUDIO_FORMATS: Record<string, { preset: string | null; options: string[] }> = {
  mp3: { preset: "V0", options: ["V0", "128k", "320k"] },
  opus: { preset: "128k", options: ["64k", "96k", "128k", "192k", "320k"] },
  flac: { preset: null, options: [] },
};

function audioFormat(format?: string, quality?: string) {
  const codec = format && Object.hasOwn(AUDIO_FORMATS, format) ? format : "mp3";
  const { preset, options } = AUDIO_FORMATS[codec];
  // 档位大小写由工作流决定（V0、320k），用户传入的大小写不做强要求。
  const chosen = options.find(option => option.toLowerCase() === quality?.trim().toLowerCase()) ?? preset;
  return chosen ? { format: codec, "format.quality": chosen } : { format: codec };
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

// LoadAudio 靠扩展名识别文件，缺 mimeType 时按类型给一个可用的兜底。
function extensionOf(mimeType: string, fallback: string) {
  const subtype = mimeType.split("/")[1]?.toLowerCase() ?? "";
  if (subtype === "mpeg") return "mp3";
  if (subtype === "x-wav" || subtype === "wave") return "wav";
  if (subtype === "x-flac") return "flac";
  if (subtype === "ogg" || subtype === "opus") return "ogg";
  return /^[a-z0-9]{2,5}$/.test(subtype) ? subtype : fallback;
}

// 参考音频来自画布上接入的素材：上传到 ComfyUI 的 input 目录，拿回 LoadAudio 能用的文件名。
// 不上传就只能用工作流里写死的文件名——那个文件在 input 目录里并不存在，LoadAudio 是下拉入参，
// 提交校验阶段就会因「值不在候选列表」被拒（HTTP 400）。
// 文件名只使用 ASCII，避免非 UTF-8 环境下中文名被写坏。
async function uploadReferenceAudio(tool: Context["tool"], item: MediaInputLike, signal: AbortSignal) {
  const base64 = typeof item.data === "string" ? item.data.replace(/^data:[^;]+;base64,/, "") : "";
  let bytes: Buffer | undefined;
  if (base64) bytes = Buffer.from(base64, "base64");
  else if (typeof item.url === "string" && /^https?:\/\//i.test(item.url)) {
    const downloaded = await tool.fetch(item.url, { signal });
    if (!downloaded.ok) throw new Error(`读取参考音频失败，HTTP ${downloaded.status}`);
    bytes = Buffer.from(await downloaded.arrayBuffer());
  }
  if (!bytes || !bytes.length) throw new Error("参考音频内容无效");
  const mimeType = typeof item.mimeType === "string" && item.mimeType ? item.mimeType : "audio/mpeg";
  const filename = `toonflow_yue2_cover_ref_${Date.now()}.${extensionOf(mimeType, "mp3")}`;
  const form = multipartFile("image", filename, mimeType, bytes);
  const response = await tool.fetch(`${COMFY_URL}/upload/image`, {
    method: "POST",
    headers: { "Content-Type": form.contentType },
    body: form.body,
    signal,
  });
  if (!response.ok) throw new Error(`上传参考音频失败，HTTP ${response.status}`);
  const result = (await response.json()) as { name?: string; subfolder?: string };
  const name = typeof result?.name === "string" ? result.name : "";
  if (!name) throw new Error("参考音频上传后未返回文件名");
  return result.subfolder ? `${result.subfolder}/${name}` : name;
}

// 时长上限（YuE2GenerateMusic.max_duration）：秒。节点声明 0.04~900、默认 360，超出收敛。
function readMaxDuration(value?: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 360;
  return Math.min(900, Math.max(10, Math.round(number)));
}

// 种子（SeedNode.seed）：64 位无符号整数。固定值时用请求里的，保证同一份输入能复现同一首曲子。
function readSeed(value?: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return Math.floor(Math.random() * 4294967295) + 1;
  return Math.floor(number);
}

// ComfyUI 提交失败时用 400 回一个结构化错误体，真正的原因在 node_errors 里
// （例如 "Value 900932003323 bigger than max of 2147483647"，details 指明是 seed 入参）。
// 只抛一个 HTTP 状态码等于把唯一的线索丢掉，所以这里把节点级原因拼进错误信息。
function submitFailure(status: number, body: string) {
  try {
    const payload = JSON.parse(body) as {
      error?: { message?: string };
      node_errors?: Record<string, { class_type?: string; errors?: { message?: string; details?: string; extra_info?: { input_name?: string } }[] }>;
    };
    const reasons = Object.entries(payload.node_errors ?? {}).flatMap(([id, node]) => (node.errors ?? []).map((item) =>
      `节点 ${id}${node.class_type ? `（${node.class_type}）` : ""}${item.extra_info?.input_name ?? item.details ?? ""}：${item.message ?? "未知错误"}`));
    if (reasons.length) return `提交音乐翻唱任务到 ComfyUI 失败，HTTP ${status}：${reasons.join("；")}`;
    if (payload.error?.message) return `提交音乐翻唱任务到 ComfyUI 失败，HTTP ${status}：${payload.error.message}`;
  } catch {}
  return `提交音乐翻唱任务到 ComfyUI 失败，HTTP ${status}${body.trim() ? `：${body.trim().slice(0, 300)}` : ""}`;
}

// 用户中止生成时 ComfyUI 侧不会跟着停：工作流仍会占着显存跑完，白等一场还留下产物。
// 任务一旦提交成功，中止时就要主动撤下来：先按 ID 从队列摘掉（还没轮到时这一步就够，
// 也不会波及画布上其他任务）；若它已经在执行，摘除不会生效，此时再看队列状态确认正在跑的
// 确实是我们这个任务，才发 /interrupt（ComfyUI 只有全局中断，没有按任务的中断接口）。
// 取消之后主 signal 已中止，普通 tool.fetch 会立即抛错，只能用 fetchDetached。
// 注意 POST /queue 只返回 200 空体，队列状态得另发一次 GET 才看得到。
async function cancelComfyTask(tool: Context["tool"], promptId: string) {
  const headers = { "Content-Type": "application/json" };
  await tool.fetchDetached(`${COMFY_URL}/queue`, {
    method: "POST",
    headers,
    body: JSON.stringify({ delete: [promptId] }),
  }).catch(() => undefined);
  const queue = await tool.fetchDetached(`${COMFY_URL}/queue`)
    .then((response) => response.json() as Promise<{ queue_running?: unknown[][] }>).catch(() => undefined);
  if (!queue?.queue_running?.some((entry) => entry?.[1] === promptId)) return;
  await tool.fetchDetached(`${COMFY_URL}/interrupt`, { method: "POST" }).catch(() => {});
}

export default {
  id: "yue2Cover",
  label: "YuE2 音乐翻唱/参考生成工作流",
  version: "2.1.0",
  apiUrl: COMFY_URL,
  readme: "接入本地 ComfyUI 的 YuE2 音乐翻唱工作流：用 SheetSage2 把接入的参考音频转成 ABC 记谱，再由 YuE2 按风格与歌词重新编曲。必须接入参考音频（会上传到 ComfyUI 替换 LoadAudio），否则无法翻唱。转谱产出的是旋律谱，因此转谱与出曲两个环节都固定走 melody 模式。风格描述走 prompt（工作流的 style），歌词走 text（lyrics）；时长上限通过 other 下发，种子固定后可复现同一首曲子。输出走 SaveAudioAdvanced，仅支持 flac / mp3 / opus。停止生成时会撤销已提交到 ComfyUI 的任务（执行中的中断、排队中的移除），不会继续占用显存。首次生成会加载 SheetSage2 音频编码器，耗时较长。",
  rules: [],
  models: [
    {
      id: "yue2_cover",
      label: "YuE2 音乐翻唱参考生成",
      type: "audio",
      audio: "optional",
      // 归属音乐生成节点：ComfyUI-音频生成只列 speech，这里不会被它看到。
      audioCategory: "music",
      // 翻唱的核心就是参考音频：接入的音频会上传到 ComfyUI 交给 SheetSage2 转谱，节点据此提示。
      referenceAudio: true,
      // 没有参考音频就转不出谱，节点据此在提交前拦住。
      requiresReferenceAudio: true
    }
  ],
  async generateAudio(this: Context, request: AudioRequest): Promise<MediaAsset[]> {
    this.signal?.throwIfAborted();
    if (request.model !== "yue2_cover") {
      throw new Error("模型选择无效");
    }

    const maxDuration = readMaxDuration(request.other?.maxDuration);
    const seed = readSeed(request.seed);
    const { format, "format.quality": quality } = audioFormat(request.format, request.quality);

    const signal = AbortSignal.any([AbortSignal.timeout(900000), ...(this.signal ? [this.signal] : [])]);

    // 翻唱必须给一段参考音频，否则无从转谱。这里不用工作流里的占位文件名兜底：
    // 那个文件在 input 目录里并不存在，LoadAudio 的下拉校验直接让提交失败（HTTP 400）。
    const reference = (Array.isArray(request.audios) ? request.audios : []).find(item => item && (item.data || item.url));
    if (!reference) throw new Error("翻唱需要接入一段参考音频，请从音频节点连入或拖入");
    const referenceAudio = await uploadReferenceAudio(this.tool, reference, signal);

    const workflow = {
      "10": {
        "inputs": {
          "filename_prefix": "audio/YuE2_cover",
          "format": format,
          ...(quality ? { "format.quality": quality } : {}),
          "audio": [
            "53",
            0
          ]
        },
        "class_type": "SaveAudioAdvanced"
      },
      "45": {
        "inputs": {
          "audio": referenceAudio
        },
        "class_type": "LoadAudio"
      },
      "47": {
        "inputs": {
          "ckpt_name": "YuE2\\yue2_3b_bf16.safetensors"
        },
        "class_type": "CheckpointLoaderSimple"
      },
      "48": {
        "inputs": {
          "style": request.prompt || "English, soulful jazz-pop, expressive male vocal...",
          "lyrics": request.text || "[Verse]\nStreetlights shimmer on the pavement...",
          "abc": [
            "57",
            0
          ],
          "seed": [
            "54",
            0
          ],
          // 固定 melody：SheetSage2 转出来的是旋律谱，YuE2GenerateMusic 必须用 melody 接。
          // 且 abc 入参非空时本节点就忽略选定的 mode，这里写死只是把意图写明。
          "mode": "melody",
          "max_duration": maxDuration,
          "temperature": 1,
          "top_p": 0.95,
          "top_k": 100,
          "repetition_penalty": 1.2,
          "cfg_scale": 1,
          "clip": [
            "47",
            1
          ]
        },
        "class_type": "YuE2GenerateMusic"
      },
      "49": {
        "inputs": {
          "conditioning": [
            "48",
            0
          ]
        },
        "class_type": "ConditioningZeroOut"
      },
      "50": {
        "inputs": {
          "source": [
            "48",
            1
          ]
        },
        "class_type": "PreviewAny"
      },
      "51": {
        "inputs": {
          "seed": [
            "54",
            0
          ],
          "steps": 32,
          "cfg": 1,
          "sampler_name": "dpm_2",
          "scheduler": "sgm_uniform",
          "denoise": 1,
          "model": [
            "47",
            0
          ],
          "positive": [
            "48",
            0
          ],
          "negative": [
            "49",
            0
          ],
          "latent_image": [
            "52",
            0
          ]
        },
        "class_type": "KSampler"
      },
      "52": {
        "inputs": {
          "seconds": [
            "48",
            1
          ],
          "batch_size": 1
        },
        "class_type": "EmptyYuE2LatentAudio"
      },
      "53": {
        "inputs": {
          "samples": [
            "51",
            0
          ],
          "vae": [
            "47",
            2
          ]
        },
        "class_type": "VAEDecodeAudio"
      },
      "54": {
        "inputs": {
          "seed": seed
        },
        "class_type": "SeedNode"
      },
      "55": {
        "inputs": {
          "mode": "melody",
          "audio_encoder": [
            "56",
            0
          ],
          "audio": [
            "45",
            0
          ]
        },
        "class_type": "SheetSage2AudioToABC"
      },
      "56": {
        "inputs": {
          "audio_encoder_name": "sheetsage2_bf16.safetensors"
        },
        "class_type": "AudioEncoderLoader"
      },
      "57": {
        "inputs": {
          "source": [
            "55",
            0
          ]
        },
        "class_type": "PreviewAny"
      }
    };

    const promptRes = await this.tool.fetch(`${COMFY_URL}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow }),
      signal,
    });

    if (!promptRes.ok) {
      throw new Error(submitFailure(promptRes.status, await promptRes.text()));
    }

    const promptResult = (await promptRes.json()) as { prompt_id: string };
    const promptId = promptResult.prompt_id;
    if (!promptId) {
      throw new Error("未获取到 ComfyUI 的任务 ID");
    }

    let audioUrl = "";
    try {
      while (!signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const historyRes = await this.tool.fetch(`${COMFY_URL}/history/${promptId}`, { signal });
        if (!historyRes.ok) continue;

        const historyData = (await historyRes.json()) as Record<string, any>;
        if (historyData && historyData[promptId]) {
          const outputs = historyData[promptId].outputs;
          if (outputs) {
            for (const nodeId of Object.keys(outputs)) {
              const nodeOutput = outputs[nodeId];
              if (nodeOutput.audio && nodeOutput.audio.length > 0) {
                const audioInfo = nodeOutput.audio[0];
                audioUrl = `${COMFY_URL}/view?filename=${encodeURIComponent(audioInfo.filename)}&subfolder=${encodeURIComponent(audioInfo.subfolder || "")}&type=${encodeURIComponent(audioInfo.type || "output")}`;
                break;
              }
            }
          }
          break;
        }
      }
      signal.throwIfAborted();
    } catch (error) {
      // 中止后主 signal 已失效，撤任务与报错都得走不受中止影响的通道。
      if (this.signal?.aborted) await cancelComfyTask(this.tool, promptId);
      throw error;
    }

    if (!audioUrl) {
      throw new Error("未能获取生成的音乐结果");
    }

    return [{ mediaType: "audio", type: "url", url: audioUrl }];
  }
};
