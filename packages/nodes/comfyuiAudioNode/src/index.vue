<template>
  <nodeSkeleton
    v-bind="nodeProps"
    :topVisible="node.selected"
    :bottomVisible="node.selected"
    :bottomWidth="actions?.mode === 'speed' ? 440 : 660"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    :fullscreenVisible="false"
    style="width: 360px">
    <template #topActions>
      <el-button :icon="IconScissors" :disabled="busy || !previewUrl" text title="截取音频" aria-label="截取音频" @click.stop="actions?.open('clip')">截取</el-button>
      <el-button :icon="IconGauge" :disabled="busy || !previewUrl" text title="音频变速" aria-label="音频变速" @click.stop="actions?.open('speed')">变速</el-button>
      <el-button :icon="IconTransfer" :loading="uploading" :disabled="busy" text title="替换音频" aria-label="替换音频" @click.stop="fileInput?.click()">替换音频</el-button>
      <input ref="fileInput" type="file" accept="audio/*" hidden aria-label="选择替换音频" :disabled="busy" @change="replaceOutput" />
    </template>
    <div v-loading="generating || uploading" class="audioContent nopan" :aria-busy="generating || uploading">
      <audioPlayer v-if="previewUrl" ref="player" class="audioPreview" :src="previewUrl" @loadedmetadata="updateNodeInternals" />
      <div v-else class="audioEmpty" role="img" aria-label="暂无生成音频"><icon-music-bolt :size="48" stroke="1.25" aria-hidden="true" /></div>
    </div>
    <template #bottom>
      <div v-if="actions?.mode === 'speed'" ref="speedTarget" />
      <el-card v-else class="promptCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <referenceItem v-if="refList.length" v-model="refList" @preview="setReferencePreview" @remove="removeReference" />
        <!-- 接入的文本去了哪条通道，光看连线看不出来。 -->
        <div v-if="referenceHint" class="referenceHint">{{ referenceHint }}</div>
        <!-- 接了音频但当前模型不消费它（语音设计类从文字描述造音色）：说出来，否则用户会以为已经生效。 -->
        <div v-if="hasReferenceAudio && !supportsReferenceAudio" class="referenceHint">当前模型不使用参考音频，接入的音频会被忽略</div>
        <!-- 两条独立的文本通道：待朗读文本进供应商的 text，语音指令进供应商的 instruction（声音设计）。
             语音指令放在上面：接入的第 1 条文本并入它，与卡片上的引用顺序一致。 -->
        <div class="fieldSection">
          <span class="fieldLabel">语音指令</span>
          <promptInput
            v-model="data.instructionModel"
            v-model:text="data.instruction"
            :references="referenceMentions"
            placeholder="描述音色、性别、语气与口音，如 gender: Male. pitch: Low."
            expandable />
        </div>
        <div class="fieldSection">
          <span class="fieldLabel">待朗读文本</span>
          <promptInput
            v-model="data.textModel"
            v-model:text="data.text"
            :references="referenceMentions"
            placeholder="输入要朗读的文本，输入 @ 引用参考"
            expandable />
        </div>
        <div class="promptFooter">
          <el-select
            v-model="data.model"
            class="modelSelect"
            filterable
            :loading="modelsLoading"
            :disabled="busy"
            placeholder="选择模型"
            aria-label="音频生成模型"
            noDataText="没有可用的语音合成模型，请在设置中添加 TTS 模型"
            placement="top-start"
            @visible-change="visible => visible && loadModels().catch(error => showNodeError(error, '模型读取失败'))">
            <template #prefix><icon-music-bolt :size="17" /></template>
            <el-option-group v-for="provider in modelGroups" :key="provider.id" :label="provider.label">
              <el-option v-for="item in provider.models" :key="item.modelId" :label="item.label" :value="JSON.stringify([item.providerId, item.modelId])" />
            </el-option-group>
          </el-select>
          <generationSettings
            v-model:format="data.format"
            v-model:quality="data.quality"
            v-model:seed-mode="data.seedMode"
            v-model:seed-value="data.seedValue"
            v-model:reference-text="data.referenceText"
            :formats="formatOptions"
            :has-reference-audio="hasReferenceAudio"
            :supports-reference-audio="supportsReferenceAudio"
            :disabled="busy || !selectedModel" />
          <el-button
            class="sendButton"
            :icon="generating ? IconPlayerStop : IconArrowUp"
            :disabled="deleting || uploading || actions?.processing || (!generating && (!generationText || !selectedModel))"
            :title="generating ? '停止生成' : '生成音频'"
            :aria-label="generating ? '停止生成' : '生成音频'"
            @click="generating ? generationController?.abort() : startGeneration().catch(error => showNodeError(error, '音频生成失败'))" />
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
  <audioActions ref="actions" :file="outputFile" :src="previewUrl" :target="speedTarget" :disabled="generating || deleting || uploading" @pause="player?.pause()" />
</template>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from "vue";
import { ElButton, ElCard, ElLoading, ElOption, ElOptionGroup, ElSelect } from "element-plus";
import { IconArrowUp, IconGauge, IconMusicBolt, IconPlayerStop, IconScissors, IconTransfer } from "@tabler/icons-vue";
import { nodeSkeleton, nodeTools, useNode, z, type NodeAudioRequest, type NodeHandle, type NodeMediaModel } from "@toonflow/nodes-scaffold/runtime";
import { groupNodeModels } from "@toonflow/node-shared/groupNodeModels";
import { showNodeError } from "@toonflow/node-shared/showNodeError";
import { useNodeGeneration } from "@toonflow/node-shared/useNodeGeneration";
import { useNodeReferences } from "@toonflow/node-shared/useNodeReferences";
import audioPlayer from "@toonflow/node-audio/audioPlayer";
import audioActions from "@toonflow/node-audio/audioActions";
import promptInput from "@toonflow/node-shared/promptInput";
import referenceItem from "@toonflow/node-shared/referenceItem";
import generationSettings from "./components/generationSettings.vue";
import { defaultQuality, formatOptions, maxSeed, qualityOptions, randomSeed } from "./audioFormats";

defineOptions({
  inheritAttrs: false,
  icon: IconMusicBolt,
  // 文本进工作流的 text / instruction。音频只有语音方向控制这类复刻音色的供应商消费（作为参考音频），
  // 语音设计供应商会忽略它，因此没有接音频时不展示相关参数，避免给出空控件。
  handles: [
    { id: "in", type: "target", dataType: ["STRING", "AUDIO"], label: "文本、音频输入" },
    { id: "audio", type: "source", dataType: "AUDIO", label: "音频输出" },
  ] satisfies NodeHandle[],
});
const vLoading = ElLoading.directive;
const { id, node, nodeProps, nodeEvent, outputs, files, ai, updateNodeInternals } = useNode({ label: "ComfyUI 音频生成" });
type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const data = computed(() => node.data as {
  text: string; textModel: PromptModel;
  instruction: string; instructionModel: PromptModel;
  model: string; format: string; quality: string;
  seedMode: string; seedValue: number; referenceText: string;
});
data.value.text ??= "";
data.value.textModel ??= [];
data.value.instruction ??= "";
data.value.instructionModel ??= [];
data.value.model ??= "";
data.value.format ??= "mp3";
// 旧文档可能存着工作流不支持的格式（SaveAudioAdvanced 只认 mp3 / flac / opus），
// 这类值提交后必然失败，直接回落默认格式，而不是让用户在生成时报错。
if (!formatOptions.includes(data.value.format)) data.value.format = "mp3";
// 音质是格式的二级入参：格式变了、或旧文档里的档位已不适用，就落回该格式的默认档位。
data.value.quality ??= "";
if (!qualityOptions[data.value.format]?.includes(data.value.quality)) data.value.quality = defaultQuality(data.value.format);
// 种子：缺省每次随机；旧文档里存了越界值（Breeze 只接受 1 ~ 2147483647）就重新摇一个。
data.value.seedMode ??= "random";
data.value.seedValue = Math.floor(Number(data.value.seedValue));
if (!Number.isFinite(data.value.seedValue) || data.value.seedValue < 1 || data.value.seedValue > maxSeed) data.value.seedValue = randomSeed();
data.value.referenceText ??= "";
const { refList, referenceMentions, setReferencePreview, removeReference } = useNodeReferences();
const models = ref<NodeMediaModel[]>([]);
const modelsLoading = ref(false);
const uploading = ref(false);
const deleting = ref(false);
const fileInput = ref<HTMLInputElement>();
const player = ref<InstanceType<typeof audioPlayer>>();
const actions = ref<InstanceType<typeof audioActions>>();
const speedTarget = ref<HTMLElement>();
let disposed = false;
let generationController: AbortController | undefined;
let generation: Promise<void> | undefined;
let modelsRequest: Promise<void> | undefined;
const generationState = useNodeGeneration(outputs, () => generationController?.abort());
const { generating } = generationState;
const busy = computed(() => generating.value || uploading.value || deleting.value || !!actions.value?.processing);
const selectedModel = computed(() => models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === data.value.model));
const modelGroups = computed(() => groupNodeModels(models.value));
// 接入的文本按先后顺序分配到两条通道：第 1 条并入语音指令，第 2 条及以后并入待朗读文本。
// 编号沿用引用在列表中的位置，与 @ 提及的「参考 N」对得上。
const stringRefs = computed(() => refList.value.flatMap((item, index) =>
  item.dataType === "STRING" && item.value?.trim() ? [{ label: `参考 ${index + 1}`, text: item.value.trim() }] : []));
const instructionRefs = computed(() => stringRefs.value.filter((_, index) => index === 0));
const textRefs = computed(() => stringRefs.value.filter((_, index) => index !== 0));
const generationText = computed(() => [data.value.text.trim(),
  ...textRefs.value.map(item => `${item.label}：\n${item.text}`)].filter(Boolean).join("\n\n"));
const generationInstruction = computed(() => [data.value.instruction.trim(),
  ...instructionRefs.value.map(item => `${item.label}：\n${item.text}`)].filter(Boolean).join("\n\n"));
// 接入的文本去了哪条通道，光靠顺序看不出来，显式说出来。
const referenceHint = computed(() => {
  if (!stringRefs.value.length) return "";
  return stringRefs.value.length === 1 ? "接入的文本并入语音指令" : "第 1 条接入的文本并入语音指令，第 2 条及以后并入待朗读文本";
});
// 接了参考音频才显示「参考音频文本」：只有复刻音色的供应商（语音方向控制）消费它。
const hasReferenceAudio = computed(() => refList.value.some(item => item.dataType === "AUDIO"));
// 参考音频只有复刻音色的模型会消费（如语音方向控制）：语音设计类从文字描述造音色，工作流里根本没有
// 加载音频的节点，接了也会被丢弃。模型用 referenceAudio 声明这项能力，未声明即不支持——
// 据此提示并把音频从请求里剔除，而不是让用户填完再静默丢掉。
const supportsReferenceAudio = computed(() => selectedModel.value?.referenceAudio === true);
const outputFile = computed(() => outputs.value.audio?.dataType === "AUDIO" ? outputs.value.audio.value : undefined);
const previewUrl = files.useFileUrl(outputFile, error => showNodeError(error, "音频读取失败"));

onMounted(() => loadModels().catch(error => showNodeError(error, "模型读取失败")));
onScopeDispose(() => {
  disposed = true;
  generationController?.abort();
});

function loadModels() {
  if (modelsRequest) return modelsRequest;
  modelsLoading.value = true;
  modelsRequest = ai.getMediaModels().then(items => {
    if (disposed || busy.value) return;
    // ACT: 只列语音合成模型。未声明 audioCategory 的按 speech 处理——历史音频供应商都是 TTS 工作流，
    // 不声明的老供应商不需要改就能继续用。音乐生成（audioCategory: "music"）归 ComfyUI-音乐生成。
    models.value = items.filter(item => item.type === "audio" && item.audioCategory !== "music");
    // ACT: 仅空配置选择默认模型，临时不可用的模型保持原选择，避免静默换供应商。
    if (!data.value.model) {
      const first = models.value[0];
      data.value.model = first ? JSON.stringify([first.providerId, first.modelId]) : "";
    }
  }).finally(() => {
    modelsLoading.value = false;
    modelsRequest = undefined;
  });
  return modelsRequest;
}

async function startGeneration() {
  if (busy.value || disposed) throw new Error("音频正在处理或节点已关闭，请稍后重试");
  const choice = selectedModel.value;
  if (!choice) throw new Error("请先选择音频模型");
  if (!generationText.value) throw new Error("请输入待朗读的文本");
  if (refList.value.some(item => item.value === undefined)) throw new Error("引用节点暂无内容，请先补充引用内容");
  if (!formatOptions.includes(data.value.format)) throw new Error("请重新选择有效的输出格式");
  const workspace = files.getWorkspaceFiles();
  const controller = new AbortController();
  // 随机模式在每次生成前现摇一个种子并留在节点上——听到满意的声音后切到「固定」就能复现它。
  if (data.value.seedMode !== "fixed") data.value.seedValue = randomSeed();
  const referenceText = data.value.referenceText.trim() || undefined;
  // 模型不支持参考音频时不带它：读了文件也只是被供应商丢掉，白耗一次 IO。界面上已明确提示。
  const audios = supportsReferenceAudio.value ? refList.value.flatMap(item => item.dataType === "AUDIO" && item.value
    ? [{ path: item.value.url, mimeType: item.value.mimeType, ...(referenceText ? { text: referenceText } : {}) }] : []) : [];
  const input: Omit<NodeAudioRequest, "directory"> = {
    providerId: choice.providerId,
    modelId: choice.modelId,
    // 平台把 prompt 映射为供应商的 text，instruction 映射为供应商的 prompt；
    // quality 与 format 配套，交给供应商按工作流声明的档位校验（flac 没有音质入参）。
    prompt: generationText.value,
    instruction: generationInstruction.value || undefined,
    format: data.value.format,
    quality: data.value.quality || undefined,
    // 接入的参考音频交给复刻音色的供应商上传并替换默认参考音频，转写文本一并带上。
    audios: audios.length ? audios : undefined,
    seed: data.value.seedValue,
    outputDirectory: `assets/${id}`,
  };
  generationController = controller;
  generation = generationState.run(async () => {
    const { directory } = await workspace.list();
    controller.signal.throwIfAborted();
    const [result] = await ai.generateAudio({ ...input, directory }, controller.signal);
    controller.signal.throwIfAborted();
    if (!result) throw new Error("供应商未返回音频");
    outputs.value.audio = { dataType: "AUDIO", value: { url: result.path, mimeType: result.mimeType } };
  }).catch(error => showNodeError(error, "音频生成失败")).finally(() => {
    generationController = undefined;
  });
  return { status: "generating" };
}

async function replaceOutput(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || busy.value || disposed) return;
  if (!file.type.startsWith("audio/")) return void showNodeError("请选择音频文件", "音频替换失败");
  if (!file.size || file.size > 100 * 1024 * 1024) return void showNodeError("音频不能为空且不能超过 100 MB", "音频替换失败");
  uploading.value = true;
  try {
    const workspace = files.getWorkspaceFiles();
    const url = await files.uploadFile(file);
    if (disposed) {
      await workspace.remove(url);
      return;
    }
    // ACT: 替换不删除旧音频，保留复制节点与撤销记录的文件引用。
    outputs.value.audio = { dataType: "AUDIO", value: { url, mimeType: file.type } };
  } catch (error) {
    showNodeError(error, "音频替换失败");
  } finally {
    uploading.value = false;
  }
}

nodeEvent.on("save", reason => {
  if (uploading.value || (reason === "reload" && busy.value)) throw new Error("音频处理中，请完成或取消后再刷新节点");
});
nodeEvent.on("delete", async () => {
  if (uploading.value) throw new Error("音频正在替换，请稍后删除节点");
  deleting.value = true;
  generationController?.abort();
  try {
    await Promise.all([generation, actions.value?.cancelAndWait()]);
    await files.removeNodeFiles();
  } finally {
    deleting.value = false;
  }
});

function getConfig() {
  return {
    config: {
      providerId: selectedModel.value?.providerId ?? "",
      modelId: selectedModel.value?.modelId ?? "",
      instruction: data.value.instruction,
      format: data.value.format,
      quality: data.value.quality,
      seedMode: data.value.seedMode === "fixed" ? "fixed" : "random",
      seedValue: data.value.seedValue,
      referenceText: data.value.referenceText,
    },
    models: models.value,
    formats: formatOptions,
    qualityOptions,
    maxSeed,
    inputLimits: { text: 1, instruction: 1, audio: 1 },
  };
}

nodeTools.register({
  name: "getConfig",
  description: "读取此 ComfyUI 音频生成节点的当前配置、可选音频模型、输出格式与音质档位及种子设置，不含密钥；待朗读文本与语音指令各一条，文本与参考音频可接上游节点；接入的文本按顺序分配，第 1 条并入语音指令、第 2 条及以后并入待朗读文本；模型带 referenceAudio 才表示它会使用接入的参考音频，未带的模型接了音频也会被忽略",
  parameters: z.strictObject({}),
  async execute(_args, { signal }) {
    signal?.throwIfAborted();
    await loadModels();
    signal?.throwIfAborted();
    return getConfig();
  },
});
nodeTools.register({
  name: "setConfig",
  description: "修改此 ComfyUI 音频生成节点的模型、语音指令、输出格式、音质档位、种子或参考音频文本；先用 getConfig 查询选项，providerId 与 modelId 必须同时提供；音质必须与格式匹配，改格式会重置音质；不修改待朗读文本、不启动生成",
  parameters: z.strictObject({
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    instruction: z.string().optional(),
    format: z.string().optional(),
    quality: z.string().optional(),
    seedMode: z.enum(["random", "fixed"]).optional(),
    seedValue: z.number().int().min(1).max(maxSeed).optional(),
    referenceText: z.string().optional(),
  }).refine(args => (args.providerId === undefined) === (args.modelId === undefined), "providerId 与 modelId 必须同时提供"),
  async execute(args, { signal }) {
    signal?.throwIfAborted();
    if (busy.value || disposed) throw new Error("音频正在处理或节点已关闭，请稍后修改配置");
    await loadModels();
    signal?.throwIfAborted();
    if (busy.value || disposed) throw new Error("音频正在处理或节点已关闭，请稍后修改配置");
    const choice = args.modelId === undefined ? selectedModel.value : models.value.find(item => item.providerId === args.providerId && item.modelId === args.modelId);
    if (!choice) throw new Error("请选择 getConfig 返回的有效音频模型");
    if (args.format !== undefined && !formatOptions.includes(args.format)) throw new Error("请选择 getConfig 返回的有效输出格式");
    if (args.quality !== undefined) {
      // 音质挂在格式下面，按生效后的格式校验：换到 flac 时任何档位都不适用。
      const options = qualityOptions[args.format ?? data.value.format] ?? [];
      if (!options.includes(args.quality)) throw new Error(`请选择 getConfig 返回的音质档位（${options.join(" / ") || "当前格式没有音质选项"}）`);
    }
    data.value.model = JSON.stringify([choice.providerId, choice.modelId]);
    if (args.instruction !== undefined) {
      data.value.instruction = args.instruction;
      data.value.instructionModel = args.instruction.split("\n").map(text => [{ type: "Write", text }]);
    }
    if (args.format !== undefined) {
      data.value.format = args.format;
      data.value.quality = defaultQuality(args.format);
    }
    if (args.quality !== undefined) data.value.quality = args.quality;
    // 固定种子时值必须一起给，否则节点会拿着旧的种子却以为是新填的。
    if (args.seedMode !== undefined) data.value.seedMode = args.seedMode;
    if (args.seedValue !== undefined) {
      data.value.seedValue = args.seedValue;
      data.value.seedMode = args.seedMode ?? "fixed";
    } else if (args.seedMode === "fixed" && (!Number.isFinite(data.value.seedValue) || data.value.seedValue < 1)) {
      data.value.seedValue = randomSeed();
    }
    if (args.referenceText !== undefined) data.value.referenceText = args.referenceText;
    return getConfig();
  },
});
nodeTools.register({
  name: "setText",
  description: "修改此 ComfyUI 音频生成节点的待朗读文本，支持 {{ref 1}} 等参考标记；只修改文本，不启动生成",
  parameters: z.strictObject({ text: z.string() }),
  execute({ text }) {
    if (deleting.value || disposed) throw new Error("节点正在删除或已关闭，请稍后修改");
    data.value.text = text;
    data.value.textModel = text.split("\n").map(line => [{ type: "Write", text: line }]);
    return { text };
  },
});
nodeTools.register({
  name: "generateAudio",
  description: "使用当前待朗读文本、语音指令、模型与输出格式启动后台生成；立即返回已开始，用 getGenerationStatus 查询结果、cancelGeneration 停止（会一并撤销 ComfyUI 上已提交的任务）",
  parameters: z.strictObject({}),
  execute(_args, { signal }) {
    signal?.throwIfAborted();
    return startGeneration();
  },
});
</script>

<style scoped lang="scss">
.audioContent {
  position: relative;
  min-height: 144px;
  display: flex;
  align-items: center;

  .audioPreview {
    display: block;
    width: 100%;
    border-radius: var(--el-border-radius-base);
  }

  .audioEmpty {
    display: grid;
    place-items: center;
    width: 100%;
    min-height: 144px;
    color: var(--el-text-color-placeholder);
  }

  :deep(.el-loading-mask) {
    pointer-events: none;
  }
}

.promptCard {
  .referenceHint {
    margin-top: 8px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .fieldSection {
    .fieldLabel {
      display: block;
      margin-top: 12px;
      color: var(--el-text-color-secondary);
      font-size: 12px;
      font-weight: 500;
    }

    :deep(.promptInputWrap) {
      margin: 8px 0 0;
    }
  }

  .promptFooter {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 16px;

    .modelSelect {
      width: 190px;
      min-width: 0;

      &:deep(.el-select__wrapper) {
        gap: 6px;
        padding: 0;
        box-shadow: none;
        background: transparent;
      }
    }

    .sendButton {
      width: 32px;
      height: 32px;
      margin-left: auto;
      padding: 0;
      --el-button-bg-color: var(--el-text-color-primary);
      --el-button-border-color: transparent;
      --el-button-text-color: var(--el-bg-color);
      --el-button-hover-bg-color: var(--el-text-color-regular);
      --el-button-hover-border-color: transparent;
      --el-button-hover-text-color: var(--el-bg-color);
    }
  }
}
</style>
