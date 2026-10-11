type ImageRequest = {
  model: string;
  prompt?: string;
  images?: unknown[];
  ratio?: string;
  size?: string;
  // 放大倍数，1.5 / 2 / 4 等；缺省 2。写进 #82 的 resize_type.multiplier。
  multiplier?: number;
  other?: Record<string, unknown>;
};

type Context = {
  config: Record<string, unknown>;
  signal?: AbortSignal;
  tool: { fetch: typeof fetch; fetchDetached?: typeof fetch };
};

type MediaAsset = { mediaType: "image"; type: "url"; url: string };

// 放大倍数：画布只暴露一个数字，范围 1.5~4（再小就没有放大意义，再大显存容易爆）。
// 缺省 2×：质量与耗时较平衡；4× 更慢且显存压力大。
function readMultiplier(value?: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 1) return 2;
  return Math.min(4, Math.max(1.5, Math.round(number * 10) / 10));
}

function extensionOf(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.toLowerCase() ?? "";
  if (subtype === "jpeg" || subtype === "jpg") return "jpg";
  if (/^[a-z0-9]{2,5}$/.test(subtype)) return subtype;
  return "png";
}

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

/** 把画布给的 base64 图片上传到 ComfyUI 的 input 目录，返回 LoadImage 可引用的文件名。 */
async function uploadSourceImage(tool: Context["tool"], image: { data?: string; mimeType?: string } | undefined, signal: AbortSignal) {
  const base64 = typeof image?.data === "string" ? image.data.replace(/^data:[^;]+;base64,/, "") : "";
  if (!base64) return "";
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length) return "";
  const mimeType = image?.mimeType?.startsWith("image/") ? image.mimeType : "image/png";
  const filename = `toonflow_upscale_${Date.now()}.${extensionOf(mimeType)}`;
  const form = multipartImage("image", filename, mimeType, bytes);
  const response = await tool.fetch("http://127.0.0.1:8188/upload/image", {
    method: "POST",
    headers: { "Content-Type": form.contentType },
    body: form.body,
    signal,
  });
  if (!response.ok) throw new Error(`上传待放大图片到 ComfyUI 失败，HTTP ${response.status}`);
  const result = (await response.json()) as { name?: string; subfolder?: string };
  // LoadImage 接受「文件名」或「子目录/文件名」，这里带上前缀避免与 input 根目录的同名文件冲突。
  return result.subfolder ? `${result.subfolder}/${result.name ?? filename}` : (result.name ?? filename);
}

export default {
  id: "seedvr2Upscale",
  label: "SeedVR2 图像超分辨率放大工作流",
  version: "2.1.0",
  apiUrl: "http://127.0.0.1:8188",
  readme: "接入本地 ComfyUI 的 SeedVR2 图像超分辨率放大工作流。只接一张图，倍率通过 resize_type.multiplier 下发（1.5–4，缺省 2）。超分不改画面内容，因此没有 LoRA 与提示词通道。",
  rules: [],
  models: [
    {
      id: "seedvr2_upscale",
      label: "SeedVR2 图像超分",
      type: "image",
      mode: ["singleImage"],
      // 放大类模型：画布据此只显示放大倍数，隐藏 LoRA、分辨率、比例与玩法按钮。
      upscale: true,
      // 放大倍数的可选档位；画布用这个渲染下拉，缺省时用第一项。
      upscaleMultipliers: ["1.5", "2", "3", "4"]
    }
  ],
  async generateImage(this: Context, request: ImageRequest): Promise<MediaAsset[]> {
    this.signal?.throwIfAborted();
    if (request.model !== "seedvr2_upscale") {
      throw new Error("模型选择无效");
    }

    const multiplier = readMultiplier(request.multiplier);
    const signal = AbortSignal.any([AbortSignal.timeout(300000), ...(this.signal ? [this.signal] : [])]);

    // 待放大的图：画布给的是 base64（服务端已读工作区文件转的），先上传到 ComfyUI 的 input 目录，
    // 拿回 LoadImage 能引用的文件名。没给图就没什么可放大的。
    const source = Array.isArray(request.images) ? request.images.find(item => item && typeof item === "object") : undefined;
    const sourceName = await uploadSourceImage(this.tool, source as { data?: string; mimeType?: string } | undefined, signal);
    if (!sourceName) throw new Error("请先接入要放大的图片");

    const workflow = {
      "1": {
        "inputs": {
          "image": sourceName
        },
        "class_type": "LoadImage"
      },
      "9": {
        "inputs": {
          "filename_prefix": "seedvr2_after/image",
          "images": [
            "84",
            0
          ]
        },
        "class_type": "SaveImage"
      },
      "76": {
        "inputs": {
          "tile_size": 512,
          "overlap": 128,
          "temporal_size": 4096,
          "temporal_overlap": 8,
          "pixels": [
            "83",
            0
          ],
          "vae": [
            "78",
            0
          ]
        },
        "class_type": "VAEEncodeTiled"
      },
      "77": {
        "inputs": {
          "image": [
            "1",
            0
          ],
          "alpha": [
            "1",
            1
          ]
        },
        "class_type": "JoinImageWithAlpha"
      },
      "78": {
        "inputs": {
          "vae_name": "seedvr2_ema_vae_fp16.safetensors"
        },
        "class_type": "VAELoader"
      },
      "79": {
        "inputs": {
          "unet_name": "SeedVR2\\seedvr2_7b_fp16.safetensors",
          "weight_dtype": "default"
        },
        "class_type": "UNETLoader"
      },
      "80": {
        "inputs": {
          "seed": 959948902156062,
          "steps": 1,
          "cfg": 1,
          "sampler_name": "euler",
          "scheduler": "simple",
          "denoise": 1,
          "model": [
            "79",
            0
          ],
          "positive": [
            "85",
            0
          ],
          "negative": [
            "85",
            1
          ],
          "latent_image": [
            "76",
            0
          ]
        },
        "class_type": "KSampler"
      },
      "81": {
        "inputs": {
          "tile_size": 512,
          "overlap": 128,
          "temporal_size": 4096,
          "temporal_overlap": 8,
          "samples": [
            "80",
            0
          ],
          "vae": [
            "78",
            0
          ]
        },
        "class_type": "VAEDecodeTiled"
      },
      "82": {
        "inputs": {
          "resize_type": "scale by multiplier",
          // 放大倍数来自画布（upscaleMultipliers 声明的档位），缺省 2。
          "resize_type.multiplier": multiplier,
          "scale_method": "lanczos",
          "input": [
            "77",
            0
          ]
        },
        "class_type": "ResizeImageMaskNode"
      },
      "83": {
        "inputs": {
          "resized_images": [
            "82",
            0
          ]
        },
        "class_type": "SeedVR2Preprocess"
      },
      "84": {
        "inputs": {
          "color_correction_method": "none",
          "images": [
            "81",
            0
          ],
          "original_resized_images": [
            "82",
            0
          ]
        },
        "class_type": "SeedVR2PostProcessing"
      },
      "85": {
        "inputs": {
          "model": [
            "79",
            0
          ],
          "vae_conditioning": [
            "76",
            0
          ]
        },
        "class_type": "SeedVR2Conditioning"
      }
    };

    const promptRes = await this.tool.fetch("http://127.0.0.1:8188/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow }),
      signal,
    });

    if (!promptRes.ok) {
      throw new Error(`提交图像超分任务到 ComfyUI 失败，HTTP ${promptRes.status}`);
    }

    const promptResult = (await promptRes.json()) as { prompt_id: string };
    const promptId = promptResult.prompt_id;
    if (!promptId) {
      throw new Error("未获取到 ComfyUI 的任务 ID");
    }

    let imageUrl = "";
    while (!signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const historyRes = await this.tool.fetch(`http://127.0.0.1:8188/history/${promptId}`, { signal });
      if (!historyRes.ok) continue;

      const historyData = (await historyRes.json()) as Record<string, any>;
      if (historyData && historyData[promptId]) {
        const outputs = historyData[promptId].outputs;
        if (outputs) {
          for (const nodeId of Object.keys(outputs)) {
            const nodeOutput = outputs[nodeId];
            if (nodeOutput.images && nodeOutput.images.length > 0) {
              const imgInfo = nodeOutput.images[0];
              imageUrl = `http://127.0.0.1:8188/view?filename=${encodeURIComponent(imgInfo.filename)}&subfolder=${encodeURIComponent(imgInfo.subfolder || "")}&type=${encodeURIComponent(imgInfo.type || "output")}`;
              break;
            }
          }
        }
        break;
      }
    }

    signal.throwIfAborted();
    if (!imageUrl) {
      throw new Error("未能获取超分处理后的图片结果");
    }

    return [{ mediaType: "image", type: "url", url: imageUrl }];
  }
};