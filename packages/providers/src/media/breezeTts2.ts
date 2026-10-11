type AudioRequest = {
  model: string;
  text?: string;
  prompt?: string;
  speed?: number;
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

// SaveAudioAdvanced 只声明了 flac / mp3 / opus（comfy_api 的 AudioSaveHelper._FORMATS = {flac, mp3, opus}）。
// 别的格式（wav / ogg）能通过 ComfyUI 的提交校验，却会在**执行时**抛 "Unsupported audio format"，
// 结果是没有产物、一直等到超时——所以这里按白名单收口，不认的一律回落 mp3。
// quality 是 format 的子入参，只对 mp3（V0 / 128k / 320k）与 opus（64k / 96k / 128k / 192k / 320k）存在，
// flac 没有这个入参；档位与 ComfyUI 节点里看到的一致，传了不支持的档位就回落该格式的默认值。
const AUDIO_FORMATS: Record<string, { preset: string | null; options: string[] }> = {
  mp3: { preset: "V0", options: ["V0", "128k", "320k"] },
  opus: { preset: "128k", options: ["64k", "96k", "128k", "192k", "320k"] },
  flac: { preset: null, options: [] },
};

// BreezeTTS2VoiceDesign 的 seed 是 32 位 INT（max 2147483647），不能照搬 KSampler 那种 1e12 的取值范围，
// 越界会被 ComfyUI 直接判为 prompt_outputs_failed_validation（HTTP 400）。
// 平台没给种子时（节点「每次随机」）这里现摇一个；给了就收进 INT32 区间，保证同种子可复现。
function seedValue(value?: number) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const seed = Math.floor(value);
    if (seed >= 1 && seed <= 2147483647) return seed;
  }
  return Math.floor(Math.random() * 2147483647) + 1;
}

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
    if (reasons.length) return `提交音频生成任务到 ComfyUI 失败，HTTP ${status}：${reasons.join("；")}`;
    if (payload.error?.message) return `提交音频生成任务到 ComfyUI 失败，HTTP ${status}：${payload.error.message}`;
  } catch {}
  return `提交音频生成任务到 ComfyUI 失败，HTTP ${status}${body.trim() ? `：${body.trim().slice(0, 300)}` : ""}`;
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
  id: "breezeTts2",
  label: "Breeze TTS 2 语音设计工作流",
  version: "2.1.3",
  apiUrl: COMFY_URL,
  readme: "接入本地 ComfyUI 的 Breeze TTS 2 语音生成与声音设计工作流。平台把待朗读文本传成 text、语音指令传成 instruction（节点上的「待朗读文本」与「语音指令」两个输入区）。输出格式走 SaveAudioAdvanced，仅支持 flac / mp3 / opus。停止生成时会撤销已提交到 ComfyUI 的任务（执行中的中断、排队中的移除），不会继续占用显存。",
  rules: [],
  models: [
    {
      id: "breeze_tts_2",
      label: "Breeze TTS 2 语音生成",
      type: "audio",
      audio: "optional"
    }
  ],
  async generateAudio(this: Context, request: AudioRequest): Promise<MediaAsset[]> {
    this.signal?.throwIfAborted();
    if (request.model !== "breeze_tts_2" || (!request.text?.trim() && !request.prompt?.trim())) {
      throw new Error("模型或文本/提示词无效");
    }

    const workflow = {
      "1": {
        "inputs": {
          "model": "bf16 (best quality)",
          "dtype": "auto",
          "device": "auto",
          "attention": "auto",
          "decode_mode": "cuda_graphs",
          "download_if_missing": true
        },
        "class_type": "BreezeTTS2LoadModel"
      },
      "2": {
        "inputs": {
          "text": request.text || "Life is like an unscripted movie...",
          "instruction": request.prompt || "gender: Male.\npitch: Extremely low...",
          "cfg_scale": 4,
          "max_new_tokens": 1500,
          "temperature": 0.9,
          "top_k": 50,
          "top_p": 1,
          "repetition_penalty": 1.1,
          "depth_temperature": 0.9,
          "depth_top_k": 50,
          "depth_top_p": 1,
          "seed": seedValue(request.seed),
          "breeze_model": ["1", 0]
        },
        "class_type": "BreezeTTS2VoiceDesign"
      },
      "3": {
        "inputs": {
          "filename_prefix": "Breeze/Breeze_TTS2",
          ...audioFormat(request.format, request.quality),
          "audio": ["2", 0]
        },
        "class_type": "SaveAudioAdvanced"
      }
    };

    const signal = AbortSignal.any([AbortSignal.timeout(300000), ...(this.signal ? [this.signal] : [])]);
    
    const promptRes = await this.tool.fetch(`${COMFY_URL}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow }),
      signal,
    });

    if (!promptRes.ok) {
      throw new Error(submitFailure(promptRes.status, await promptRes.text().catch(() => "")));
    }

    const promptResult = (await promptRes.json()) as { prompt_id: string };
    const promptId = promptResult.prompt_id;
    if (!promptId) {
      throw new Error("未获取到 ComfyUI 的任务 ID");
    }

    let audioUrl = "";
    try {
      while (!signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
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
      if (!audioUrl) {
        throw new Error("未能获取生成的音频结果");
      }
    } finally {
      // 用户中止时任务仍留在 ComfyUI 里（节点「停止生成」只是断开了请求）：主动撤销，
      // 别让它白占显存跑完。已经拿到结果的不撤销——它本来就要结束了。
      if (this.signal?.aborted && !audioUrl) await cancelComfyTask(this.tool, promptId);
    }

    return [{ mediaType: "audio", type: "url", url: audioUrl }];
  }
};