/// <reference types="bun" />

type ModelType = "text" | "image" | "video" | "audio";

type ImageMode = "text" | "singleImage" | "multiReference";
type VideoMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  | (`${"video" | "image" | "audio"}Reference:${number}`)[];

interface ProviderModel {
  id: string;
  label: string;
  type: ModelType;
  think?: boolean;
  mode?: (ImageMode | VideoMode)[];
  associationSkills?: string;
  audio?: "optional" | boolean;
  // 【音频能力声明】以下字段服务于音频节点（复刻音色、语音指令分离）。图片与视频节点不消费它们，
  // 纯类型声明、运行时无副作用——若不需要音频节点，这几项可以整组移除而不影响其它媒体类型。
  /**
   * 音频模型归属：`speech` 语音合成（TTS，ComfyUI-音频生成用）、
   * `music` 音乐生成（ComfyUI-音乐生成用）。
   * 未声明时按 `speech` 处理——历史音频供应商全是 TTS 工作流，
   * 不声明的老供应商不需要改就能继续出现在音频节点里。
   */
  audioCategory?: "speech" | "music";
  /** 该音频模型是否消费接入的参考音频（复刻音色类工作流用得到）；未声明即不支持，节点据此提示而非静默丢弃。 */
  referenceAudio?: boolean;
  /**
   * 该音频模型是否**必须**消费接入的参考音频（音乐翻唱类：靠参考音频转谱才能出曲）。
   * 声明为 true 时，节点在缺少参考音频时直接拦住生成，而不是提交一个必然失败的任务。
   */
  requiresReferenceAudio?: boolean;
  imageSizes?: string[];
  imageRatios?: string[];
  durationResolutionMap?: { duration: number[]; resolution: string[] }[];
  /**
   * 该模型是「放大/超分」类：只接一张图、没有提示词与 LoRA 通道，画布据此收起
   * 不适用的控件（LoRA、分辨率、比例、玩法按钮），只留放大倍数。
   */
  upscale?: boolean;
  /** 放大倍数的可选档位；缺省时画布用 [1.5, 2, 3, 4]。 */
  upscaleMultipliers?: string[];
  voices?: { title: string; voice: string }[];
}

interface ProviderFormRule {
  field: string;
  value: unknown;
}

type ProviderConfig<TRules extends readonly ProviderFormRule[]> = {
  [TRule in TRules[number] as TRule["field"]]: TRule["value"];
};

interface ProviderContext<TConfig = Record<string, unknown>> {
  config: TConfig;
  signal?: AbortSignal;
  /** 宿主直接注入工具，供应商无需 import；FFmpeg 为按需安装的插件能力。 */
  tool: ProviderTools;
}

interface MediaRequest {
  model: string;
  /** 仅放供应商专属参数；公共字段的映射与支持范围由供应商校验。 */
  other?: Record<string, unknown>;
}

/** 抽象层的媒体来源；供应商负责转换为平台需要的 URL、文件或字节。 */
type MediaInput =
  | { type: "url"; url: string; mimeType?: string; name?: string; text?: string }
  | { type: "base64"; data: string; mimeType: string; name?: string; text?: string }
  | { type: "binary"; data: Uint8Array; mimeType: string; name?: string; text?: string };

type MediaAsset = MediaInput & { mediaType: "image" | "video" | "audio" };

type MediaImageInfo = { width: number; height: number; format: string };
type MediaImageResizeOptions = { width?: number; height?: number; format?: "jpeg" | "png" | "webp"; quality?: number };

interface AudioConvertOptions {
  format: "wav" | "mp3";
  /** 裁剪起点，单位秒，含边界；缺省为 0。 */
  startSeconds?: number;
  /** 裁剪终点，单位秒，不含边界；缺省为音频末尾。 */
  endSeconds?: number;
  /** 目标采样率；缺省保持原采样率。 */
  sampleRate?: number;
  /** mp3 比特率，单位 kbps；缺省 128，仅 format 为 mp3 时生效。 */
  bitrateKbps?: number;
}

/** 缺少可用 FFmpeg 时抛出；由宿主前端询问下载安装，供应商应继续向上抛出。 */
interface FfmpegRequiredError extends Error {
  name: "FfmpegRequiredError";
  code: "FFMPEG_REQUIRED";
  status: 424;
}

interface ProviderTools {
  fetch: typeof globalThis.fetch;
  /**
   * 不绑定取消信号的 fetch，只用于**取消之后**必须发出的一次性善后请求。
   * 典型场景：用户中止生成时，远端任务不会自己停（云端仍在计费、本地工作流仍在占显存），
   * 需要通知远端中止已提交的任务；此时普通 fetch 已随取消抛错，只有这个通道能发出去。
   * 正常业务请求一律用 fetch，不要用它绕过取消。
   */
  fetchDetached(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** 提取供应商错误正文中的可读原因，并隐藏配置中的密钥和 URL 查询参数。 */
  errorMessage(value: unknown): string;
  hash: typeof Bun.hash;
  image: typeof Bun.Image;
  /** 公共图片基础处理工具；供应商可在 processMedia 中按自身模型能力使用。 */
  media: {
    inspectImage(input: MediaInput): Promise<MediaImageInfo>;
    resizeImage(input: MediaInput, options: MediaImageResizeOptions): Promise<MediaInput>;
  };
  /**
   * 音频裁剪转码；仅接受 WAV 格式的内存字节并返回处理后的内存字节，不支持文件路径、URL 或其他压缩格式输入。
   */
  audio: {
    convert(input: Uint8Array, options: AudioConvertOptions): Promise<{ data: Uint8Array; mimeType: string }>;
  };
  /**
   * 获取绑定当前工作区的原生 @renmu/fluent-ffmpeg 工厂，沿用链式调用、事件、流和 ffprobe 回调。
   * 仅显式文件路径经过工作区边界检查；原始参数、滤镜及清单中的间接 I/O 不是沙箱。
   * 宿主始终注入此入口，调用时检查 FFmpeg/FFprobe；没有工作目录的调试上下文不能使用。
   * 缺失时抛出 FfmpegRequiredError，并通知在线前端询问下载；不会后台自动安装。
   * 安装后由用户重新发起操作，供应商不要捕获此错误后自动重试完整生成请求。
   * 输出覆盖行为沿用原生库；调用方负责文件命名、处理 end/error 及通过 command.kill 取消运行。
   * @throws {FfmpegRequiredError} 未安装或当前设置未找到可用的 FFmpeg。
   * @example const ffmpeg = await this.tool.ffmpeg(); const command = ffmpeg("assets/input.mp4").videoCodec("libx264");
   */
  ffmpeg(): Promise<import("@toonflow/ffmpeg/types").FfmpegFactory>;
}

interface ImageRequest extends MediaRequest {
  prompt: string;
  /** 参考图。 */
  images?: MediaInput[];
  mask?: MediaInput;
  /** 生成数量。 */
  n?: number;
  /** 画面宽高比，如 16:9。 */
  ratio?: string;
  /** 输出尺寸，如 1K、2K、4K 或 1024x1024；具体格式由供应商转换。 */
  size?: string;
  /**
   * 可叠加的 LoRA，按数组顺序依次应用。name 是宿主侧的全路径标识（如 ComfyUI 的「目录\文件名」），
   * strength 缺省为 1、负值表示反转。上限随宿主工作流的可堆叠槽位数（ComfyUI 堆叠节点为 12）。
   */
  loras?: { name: string; strength?: number }[];
  /** 放大倍数，只放大/超分类模型消费（如 SeedVR2 的 resize_type.multiplier）；范围 1.5~4。 */
  multiplier?: number;
  /** 画质档位，如 low、medium、high，由供应商映射。 */
  quality?: string;
  /** 输出编码格式，如 png、jpeg、webp。 */
  outputFormat?: string;
}

interface VideoRequest extends MediaRequest {
  prompt: string;
  /** 当前生成模式；参考模式数组声明各类参考媒体数量上限。 */
  mode?: VideoMode;
  /** 参考图；首尾帧通过 firstFrame、lastFrame 单独传入。 */
  images?: MediaInput[];
  videos?: MediaInput[];
  audios?: MediaInput[];
  firstFrame?: MediaInput;
  lastFrame?: MediaInput;
  /** 输出时长，单位秒；支持范围由供应商按模型校验。 */
  duration?: number;
  /** 画面宽高比，如 16:9。 */
  ratio?: string;
  /** 分辨率档位，如 720p、1080p。 */
  resolution?: string;
  generateAudio?: boolean;
  watermark?: boolean;
}

/** 基础音频生成参数；text、prompt 至少提供一项，非空校验与模型能力检查由供应商负责。 */
type AudioRequest = MediaRequest & {
  /** 待朗读的文本，用于文本转语音。 */
  text?: string;
  /** 音频创作或语音风格提示词，可与待朗读的 text 分开传入。 */
  prompt?: string;
  /** 参考音频，可附带该段音频的准确转写文本；上传或复刻流程由供应商处理。 */
  audios?: (MediaInput & { text?: string })[];
  /** 音频创作参考图；数量以及能否与参考音频同传，由供应商按模型校验。 */
  images?: MediaInput[];
  /** 系统或已复刻的音色标识，由供应商映射到平台的音色参数。 */
  voice?: string;
  /** 语速倍率，1 为正常语速；供应商负责转换平台的语速刻度。 */
  speed?: number;
  /** 音量增益，单位 dB，0 为原始音量；供应商负责转换平台的音量刻度。 */
  volume?: number;
  /** 抽象层以半音表示音调偏移，0 为原音调；供应商负责映射平台刻度并校验支持范围。 */
  pitch?: number;
  /** 情绪，如 happy、sad、angry；由供应商映射并校验模型及音色是否支持。 */
  emotion?: string;
  /** 合成语言或方言，如 zh-CN、en、yue；由供应商映射，缺省沿用模型默认行为。 */
  language?: string;
  /** 是否规范化数字等文本的读法；支持语种与处理规则由供应商按模型校验。 */
  normalizeText?: boolean;
  /** 输出编码格式，如 mp3、wav、pcm、flac、opus；由供应商映射平台的格式名称。 */
  format?: string;
  /** 输出编码质量档位或预设，如 V0、320k；由供应商按格式校验支持范围，缺省沿用其默认档位。 */
  quality?: string;
  /** 输出采样率，单位 Hz。 */
  sampleRate?: number;
  /** 输出编码码率，单位 kbps；仅适用于支持配置码率的格式，由供应商转换平台单位。 */
  bitrateKbps?: number;
  /** 采样随机种子；不传时由供应商自行随机。取值范围由供应商按宿主节点的类型校验（部分节点是 32 位 INT）。 */
  seed?: number;
} & ({ text: string } | { prompt: string });

/**
 * 三种生成函数统一返回最终媒体数组，不能返回任务 ID 或原始平台响应。
 * ACT: 本层只约定完整结果；供应商内部处理轮询/流读取，失败时抛出异常。
 */
type GenerateMedia<TRequest, TConfig = Record<string, unknown>> = (
  this: ProviderContext<TConfig>,
  request: TRequest,
) => Promise<MediaAsset[]>;

interface ProviderUpdateInfo {
  hasUpdate: boolean;
  latestVersion: string;
  notice: string;
}

interface ProviderDefinition<TRules extends readonly ProviderFormRule[] = readonly ProviderFormRule[]> {
  id: string;
  label: string;
  /** 供应商品牌图标，支持图片 URL 或 data:image/...;base64,...。 */
  icon?: string;
  /** 适配文件版本，独立于模型版本；新增供应商应填写，缺省仅兼容旧文件。 */
  version?: string;
  apiUrl?: string;
  /**
   * 媒体模型列表 GET 地址，使用配置的 apiKey 作为 Bearer 凭据，返回 { data: 模型数组 }。
   * 模型须含 id，type 可由 URL 的 type 参数或同名已有模型补全。
   * 可选 modelInfo 对象提供模型能力（如 mode、audio、durationResolutionMap、imageSizes、imageRatios），获取时合并至模型顶层。
   * 提供此字段后可手动获取；TF-Router 手动获取图片、视频、音频，并在有 key 的程序启动时自动更新。
   */
  modelsUrl?: string;
  protocol?: "openai-completions" | "openai-responses" | "anthropic-messages";
  /** 厂商说明的 Markdown 内容。 */
  readme?: string;
  rules: TRules;
  models: ProviderModel[];
  /** 检查供应商适配文件是否有更新。 */
  checkForUpdates?: (this: ProviderContext<ProviderConfig<TRules>>) => Promise<ProviderUpdateInfo>;
  /** 获取更新文件的完整源码；写入与应用由宿主负责。 */
  updateVendor?: (this: ProviderContext<ProviderConfig<TRules>>) => Promise<string>;
  /** 未实现的方法保持缺省，调用方据此判断能力是否可用。 */
  generateImage?: GenerateMedia<ImageRequest, ProviderConfig<TRules>>;
  generateVideo?: GenerateMedia<VideoRequest, ProviderConfig<TRules>>;
  generateAudio?: GenerateMedia<AudioRequest, ProviderConfig<TRules>>;
  /** 可选的供应商媒体预处理；未实现时保持原请求。 */
  processMedia?: (this: ProviderContext<ProviderConfig<TRules>>, request: ImageRequest | VideoRequest | AudioRequest) => Promise<ImageRequest | VideoRequest | AudioRequest>;
}
