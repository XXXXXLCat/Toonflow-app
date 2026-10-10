// 本地 ComfyUI 工作流用 SaveAudioAdvanced 落盘，其 format 只声明了 mp3 / flac / opus；
// 其余格式能通过 ComfyUI 的提交校验却会在执行时报错，因此这里只列这三种。
export const formatOptions = ["mp3", "flac", "opus"];

export const formatLabels: Record<string, string> = {
  mp3: "MP3",
  flac: "FLAC",
  opus: "Opus",
};

// 各格式的 quality 子入参档位，与 ComfyUI「保存音频（高级）」节点里列出的完全一致。
// mp3 的 V0 是 LAME 的 VBR 可变码率预设（约 245 kbps），其余是固定码率；flac 无损，没有这个入参。
export const qualityOptions: Record<string, string[]> = {
  mp3: ["V0", "128k", "320k"],
  opus: ["64k", "96k", "128k", "192k", "320k"],
  flac: [],
};

// 各格式的默认档位（ComfyUI 节点里的默认值）；没有音质入参的格式返回空串。
export const defaultQualities: Record<string, string> = { mp3: "V0", opus: "128k", flac: "" };

export function defaultQuality(format: string) {
  return defaultQualities[format] ?? defaultQualities.mp3;
}

// Breeze TTS 2 的 seed 是 32 位 INT，越界会被 ComfyUI 判为 prompt_outputs_failed_validation（HTTP 400），
// 不能照搬 KSampler 那种 1e12 的取值范围。
export const maxSeed = 2147483647;

export function randomSeed() {
  return Math.floor(Math.random() * maxSeed) + 1;
}
