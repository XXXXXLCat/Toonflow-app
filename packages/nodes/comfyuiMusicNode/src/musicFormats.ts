// 音乐生成的格式与参数档位。对齐 ComfyUI 的 YuE2 节点与 SaveAudioAdvanced。

// SaveAudioAdvanced 只声明了 mp3 / flac / opus，其余格式能过提交校验却在执行时报错。
export const formatOptions = ["mp3", "flac", "opus"];

export const formatLabels: Record<string, string> = {
  mp3: "MP3",
  flac: "FLAC",
  opus: "Opus",
};

// 各格式的 quality 档位，与 ComfyUI「保存音频（高级）」节点列出的完全一致；flac 无损没有这个入参。
export const qualityOptions: Record<string, string[]> = {
  mp3: ["V0", "128k", "320k"],
  opus: ["64k", "96k", "128k", "192k", "320k"],
  flac: [],
};

export const defaultQualities: Record<string, string> = { mp3: "V0", opus: "128k", flac: "" };

export function defaultQuality(format: string) {
  return defaultQualities[format] ?? defaultQualities.mp3;
}

// max_duration（YuE2GenerateMusic.max_duration）：秒。节点声明 0.04~900、步长 0.04、默认 360，
// 提示词过长时会自动缩短，实际也可能提前结束。界面上限取节点声明的 900。
export const minDuration = 10;
export const maxDuration = 900;
export const durationStep = 5;
export const defaultDuration = 360;

// 种子上限跟着节点走：YuE2 的 seed 是 64 位无符号整数（不是 Breeze TTS 的 32 位 INT），
// 用 2^32-1 会在界面上显示成一长串数字。
export const maxSeed = 4294967295;

export function randomSeed() {
  return Math.floor(Math.random() * maxSeed) + 1;
}
