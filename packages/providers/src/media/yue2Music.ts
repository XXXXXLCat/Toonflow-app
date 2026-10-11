type AudioRequest = {
  model: string;
  text?: string;
  prompt?: string;
  format?: string;
  quality?: string;
  seed?: number;
  // 工作流专属参数：max_duration（秒）。
  other?: { maxDuration?: number };
};

// 模式（YuE2GenerateMusic.mode）：固定 full——从风格描述直接出完整编曲（旋律 + 和弦）。
// 画布不提供模式选择：melody 只在有 ABC 记谱时才有意义，那属于翻唱工作流（见 yue2Cover）。
const MODE = "full";

// 时长上限（YuE2GenerateMusic.max_duration）：秒。节点声明 0.04~900、默认 360，超出收敛。
function readMaxDuration(value?: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 360;
  return Math.min(900, Math.max(10, Math.round(number)));
}

// 种子（SeedNode.seed）：固定值时用请求里的，保证同一份输入能复现同一首曲子。
function readSeed(value?: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return Math.floor(Math.random() * 4294967295) + 1;
  return Math.floor(number);
}

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
    if (reasons.length) return `提交音乐生成任务到 ComfyUI 失败，HTTP ${status}：${reasons.join("；")}`;
    if (payload.error?.message) return `提交音乐生成任务到 ComfyUI 失败，HTTP ${status}：${payload.error.message}`;
  } catch {}
  return `提交音乐生成任务到 ComfyUI 失败，HTTP ${status}${body.trim() ? `：${body.trim().slice(0, 300)}` : ""}`;
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
  id: "yue2Music",
  label: "YuE2 文本生成音乐工作流",
  version: "2.2.0",
  apiUrl: COMFY_URL,
  readme: "接入本地 ComfyUI 的 YuE2 文本与歌词生成音乐工作流。风格描述走 prompt（工作流的 style），歌词走 text（lyrics），固定走 full 模式（旋律 + 和弦完整编曲）；时长上限通过 other 下发，种子固定后可复现同一首曲子。输出走 SaveAudioAdvanced，仅支持 flac / mp3 / opus。停止生成时会撤销已提交到 ComfyUI 的任务（执行中的中断、排队中的移除），不会继续占用显存。",
  rules: [],
  models: [
    {
      id: "yue2_text2music",
      label: "YuE2 音乐生成",
      type: "audio",
      audio: "optional",
      // 归属音乐生成节点：ComfyUI-音频生成只列 speech，这里不会被它看到。
      audioCategory: "music"
    }
  ],
  async generateAudio(this: Context, request: AudioRequest): Promise<MediaAsset[]> {
    this.signal?.throwIfAborted();
    if (request.model !== "yue2_text2music") {
      throw new Error("模型选择无效");
    }

    const maxDuration = readMaxDuration(request.other?.maxDuration);
    const seed = readSeed(request.seed);
    const { format, "format.quality": quality } = audioFormat(request.format, request.quality);

    const workflow = {
      "10": {
        "inputs": {
          "filename_prefix": "audio/YuE2",
          "format": format,
          ...(quality ? { "format.quality": quality } : {}),
          "audio": [
            "52",
            0
          ]
        },
        "class_type": "SaveAudioAdvanced"
      },
      "41": {
        "inputs": {
          "ckpt_name": "YuE2\\yue2_3b_bf16.safetensors"
        },
        "class_type": "CheckpointLoaderSimple"
      },
      "42": {
        "inputs": {
          "style": [
            "54",
            0
          ],
          "lyrics": [
            "55",
            0
          ],
          "seed": [
            "53",
            0
          ],
          "mode": MODE,
          "max_abc_tokens": 8192,
          "temperature": 0.7,
          "top_p": 0.9,
          "top_k": 30,
          "repetition_penalty": 1.005,
          "penalty_window": 100,
          "clip": [
            "41",
            1
          ]
        },
        "class_type": "YuE2GenerateABC"
      },
      "43": {
        "inputs": {
          "source": [
            "44",
            0
          ]
        },
        "class_type": "PreviewAny"
      },
      "44": {
        "inputs": {
          "switch": [
            "47",
            0
          ],
          "on_false": [
            "45",
            0
          ],
          "on_true": [
            "42",
            0
          ]
        },
        "class_type": "ComfySwitchNode"
      },
      "45": {
        "inputs": {
          "value": ""
        },
        "class_type": "PrimitiveString"
      },
      "46": {
        "inputs": {
          "style": [
            "54",
            0
          ],
          "lyrics": [
            "55",
            0
          ],
          "abc": [
            "43",
            0
          ],
          "seed": [
            "53",
            0
          ],
          "mode": MODE,
          "max_duration": maxDuration,
          "temperature": 1,
          "top_p": 0.95,
          "top_k": 100,
          "repetition_penalty": 1.2,
          "cfg_scale": 1,
          "clip": [
            "41",
            1
          ]
        },
        "class_type": "YuE2GenerateMusic"
      },
      "47": {
        "inputs": {
          "value": true
        },
        "class_type": "PrimitiveBoolean"
      },
      "48": {
        "inputs": {
          "conditioning": [
            "46",
            0
          ]
        },
        "class_type": "ConditioningZeroOut"
      },
      "49": {
        "inputs": {
          "source": [
            "46",
            1
          ]
        },
        "class_type": "PreviewAny"
      },
      "50": {
        "inputs": {
          "seed": [
            "53",
            0
          ],
          "steps": 32,
          "cfg": 1,
          "sampler_name": "dpm_2",
          "scheduler": "sgm_uniform",
          "denoise": 1,
          "model": [
            "41",
            0
          ],
          "positive": [
            "46",
            0
          ],
          "negative": [
            "48",
            0
          ],
          "latent_image": [
            "51",
            0
          ]
        },
        "class_type": "KSampler"
      },
      "51": {
        "inputs": {
          "seconds": [
            "46",
            1
          ],
          "batch_size": 1
        },
        "class_type": "EmptyYuE2LatentAudio"
      },
      "52": {
        "inputs": {
          "samples": [
            "50",
            0
          ],
          "vae": [
            "41",
            2
          ]
        },
        "class_type": "VAEDecodeAudio"
      },
      "53": {
        "inputs": {
          "seed": seed
        },
        "class_type": "SeedNode"
      },
      "54": {
        "inputs": {
          "value": request.prompt || "Upbeat indie pop with warm female vocals, bright electric guitars..."
        },
        "class_type": "PrimitiveStringMultiline"
      },
      "55": {
        "inputs": {
          "value": request.text || "[Verse]\nMorning light across the window..."
        },
        "class_type": "PrimitiveStringMultiline"
      }
    };

    const signal = AbortSignal.any([AbortSignal.timeout(900000), ...(this.signal ? [this.signal] : [])]);

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