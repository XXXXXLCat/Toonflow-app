<template>
  <el-popover trigger="click" placement="top" width="min(360px, calc(100vw - 24px))" :disabled="disabled" :showArrow="false" :popperStyle="{ padding: '14px' }">
    <template #reference>
      <el-button class="loraButton" text size="small" :disabled="disabled" aria-label="LoRA 设置">
        <icon-stack-2 :size="16" aria-hidden="true" />
        <span>LoRA{{ appliedCount ? ` · ${appliedCount}` : "" }}</span>
        <icon-chevron-up :size="14" aria-hidden="true" />
      </el-button>
    </template>
    <div class="loraStack nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop @wheel.stop>
      <div class="loraHeader">
        <span class="sectionLabel">LoRA</span>
        <span v-if="loading" class="sectionHint">正在读取 ComfyUI 的 LoRA 列表…</span>
        <span v-else-if="loadError" class="sectionHint error">{{ loadError }}</span>
        <span v-else-if="!options.length" class="sectionHint">未找到适用的 LoRA</span>
        <span v-else-if="!rows.some(row => row.name)" class="sectionHint">未启用 LoRA</span>
        <span v-else class="sectionHint">{{ appliedCount }} 条已启用</span>
        <el-button v-if="rows.length < ROW_LIMIT" text :disabled="disabled" @click="addRow">添加一条</el-button>
      </div>

      <div v-if="rows.length" class="loraRows">
        <div v-for="(row, index) in rows" :key="index" class="loraRow">
          <el-select
            v-model="row.name"
            class="loraSelect"
            filterable
            :disabled="disabled"
            :placeholder="index === 0 ? '选择 LoRA' : `第 ${index + 1} 条（留空跳过）`"
            :aria-label="`第 ${index + 1} 条 LoRA`">
            <el-option-group v-for="group in groups" :key="group.folder" :label="group.folder">
              <el-option v-for="item in group.items" :key="item" :label="shortName(item)" :value="item" />
            </el-option-group>
          </el-select>
          <el-input-number
            v-model="row.strength"
            class="loraStrength"
            :min="-10"
            :max="10"
            :step="0.05"
            :precision="2"
            controls-position="right"
            :disabled="disabled || !row.name"
            :aria-label="`第 ${index + 1} 条 LoRA 强度`" />
          <el-button
            text
            :disabled="disabled"
            :title="row.name ? '移除这条' : '删除该行'"
            :aria-label="`移除第 ${index + 1} 条 LoRA`"
            @click="removeRow(index)">
            <icon-trash :size="16" aria-hidden="true" />
          </el-button>
        </div>
        <div class="sectionHint">只列出与当前底模匹配的 LoRA。</div>
      </div>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import { ElButton, ElInputNumber, ElOption, ElOptionGroup, ElPopover, ElSelect } from "element-plus";
import { IconChevronUp, IconStack2, IconTrash } from "@tabler/icons-vue";

const props = defineProps<{
  modelValue?: { name: string; strength: number }[];
  disabled?: boolean;
  /**
   * 允许的 LoRA 目录（= 底模归属）。目录名即底模，跨底模的 LoRA 会让 ComfyUI 直接报错，
   * 所以只显示匹配当前工作流底模的那一组。缺省是 Qwen Image 2.1。
   */
  folders?: string[];
}>();
const emit = defineEmits<{ "update:modelValue": [value: { name: string; strength: number }[]] }>();

/** 堆叠节点有 12 槽，画布默认只摆 4 行，按需再加。 */
const ROW_LIMIT = 12;
/** 缺省强度：1（ComfyUI 的默认权重，100% 效果）。 */
const DEFAULT_STRENGTH = 1;

type Row = { name: string; strength: number };

const COMFY_URL = "http://127.0.0.1:8188";
/** 堆叠节点的真实类名（带零宽字符，必须原样使用）。 */
const STACK_NODE = "🐈‍⬛StackLoras";

// 当前工作流底模对应的 LoRA 目录。其它目录的 LoRA 是给别的底模用的，混进来会直接报错，
// 所以只按目录过滤——ComfyUI 的枚举里名称就是「目录\文件名」，目录名即底模归属。
// 缺省是 Qwen Image 2.1；视频节点传 MiniMax-H3。
const DEFAULT_FOLDERS = ["Qwen-Image-2.1", "qwen"];
const folders = computed(() => props.folders?.length ? props.folders : DEFAULT_FOLDERS);

const rows = ref<Row[]>([]);
const loading = ref(false);
const loadError = ref("");
const options = ref<string[]>([]);
let controller: AbortController | undefined;
let disposed = false;

const appliedCount = computed(() => rows.value.filter(row => row.name).length);

// 目录名即分组名，组内按文件名排序；同名文件在不同目录下不会混淆（值是完整路径）。
const groups = computed(() => {
  const buckets = new Map<string, string[]>();
  for (const name of options.value) {
    const separator = name.lastIndexOf("\\");
    const folder = separator === -1 ? "" : name.slice(0, separator);
    const label = folder || "未分类";
    const bucket = buckets.get(label);
    if (bucket) bucket.push(name);
    else buckets.set(label, [name]);
  }
  return [...buckets].map(([folder, items]) => ({ folder, items: items.toSorted((left, right) => left.localeCompare(right)) }));
});

function shortName(name: string) {
  const separator = name.lastIndexOf("\\");
  return separator === -1 ? name : name.slice(separator + 1);
}

function publish() {
  if (disposed) return;
  // 只上报已启用的条目，保持存档干净；供应商侧会把空位补成 None + on=false。
  emit("update:modelValue", rows.value.filter(row => row.name).map(row => ({ name: row.name, strength: row.strength })));
}

function normalize(value: { name: string; strength: number }[] | undefined) {
  const list = (value ?? []).filter(item => item?.name).slice(0, ROW_LIMIT);
  // 空行只留一条：点「添加一条」加出来的行是空的，publish 只上报已启用的条目，
  // 若这里再补满 4 行，加行就会被父组件回传的旧值立刻抹掉（表现为点了没反应）。
  // 空行不足时补一条，用户想加再点。
  const size = Math.min(ROW_LIMIT, Math.max(list.length + 1, list.length));
  rows.value = Array.from({ length: size }, (_, index) => {
    const item = list[index];
    return { name: item?.name ?? "", strength: normalizeStrength(item?.strength) };
  });
}

/** 缺省 1（ComfyUI 的默认权重）。越界值收敛到 -10~10，不静默改写其它字段。 */
function normalizeStrength(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_STRENGTH;
  return Math.max(-10, Math.min(10, value));
}

// 只有「外部真的改了值」才重建行。行数变化不视为外部改动，否则刚加的空行会被弹回去。
watch(() => props.modelValue, value => {
  const enabled = rows.value.filter(row => row.name).map(row => `${row.name}|${row.strength}`).join(";");
  const incoming = (value ?? []).map(item => `${item?.name ?? ""}|${normalizeStrength(item?.strength)}`).join(";");
  if (enabled !== incoming) normalize(value);
}, { immediate: true, deep: true });

async function load() {
  if (disposed || loading.value) return;
  controller?.abort();
  const current = controller = new AbortController();
  loading.value = true;
  loadError.value = "";
  try {
    const response = await fetch(`${COMFY_URL}/object_info/${encodeURIComponent(STACK_NODE)}`, { signal: current.signal });
    if (!response.ok) throw new Error(`ComfyUI 返回 ${response.status}`);
    const data = (await response.json()) as Record<string, { input?: { required?: Record<string, unknown> } }>;
    const node = data[STACK_NODE];
    // 枚举可能挂在 lora_01，也可能因版本差异落在别的槽位号上——取第一个带 options 的 COMBO。
    const slots = Object.entries(node?.input?.required ?? {});
    const names: string[] = [];
    for (const [, spec] of slots) {
      const options = Array.isArray(spec) ? (spec[1] as { options?: unknown } | undefined)?.options : undefined;
      if (Array.isArray(options)) {
        names.push(...options.filter((item): item is string => typeof item === "string"));
        break;
      }
    }
    if (!names.length) throw new Error("堆叠节点未返回 LoRA 列表，确认 ComfyUI 已加载该自定义节点");
    const wanted = folders.value.map(item => item.toLowerCase());
    options.value = names.filter(name => {
      const separator = name.lastIndexOf("\\");
      const folder = (separator === -1 ? "" : name.slice(0, separator)).toLowerCase();
      return wanted.includes(folder);
    });
  } catch (error) {
    if (!current.signal.aborted && !disposed) loadError.value = `读取 LoRA 列表失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (!disposed) loading.value = false;
  }
}

function addRow() {
  if (rows.value.length >= ROW_LIMIT) return;
  rows.value = [...rows.value, { name: "", strength: DEFAULT_STRENGTH }];
}

function removeRow(index: number) {
  rows.value = rows.value.filter((_, position) => position !== index);
  publish();
}

// 换了别的 LoRA 就把强度收回默认：上一个 LoRA 的权重不一定适用于新的（0 会让这条完全不生效）。
watch(() => rows.value.map(row => row.name), (names, previous) => {
  names.forEach((name, index) => {
    if (name && previous[index] !== name && rows.value[index]!.strength === 0) rows.value[index]!.strength = DEFAULT_STRENGTH;
  });
});

watch(rows, publish, { deep: true });
onScopeDispose(() => {
  disposed = true;
  controller?.abort();
});
void load();

defineExpose({ load });
</script>

<style scoped lang="scss">
.loraButton {
  flex-shrink: 0;
  // 与参数按钮（settingsButton）同一套间距：图标、文字段、箭头之间各 6px，
  // 文字段内部的「 · 」紧贴（靠 · 自带的留白），与「1:1 · 1MP · 1张」一致。
  :deep(> span) { gap: 6px; }
  > span { white-space: nowrap; }
}

.loraStack {
  display: grid;
  gap: 8px;

  .loraHeader {
    display: flex;
    align-items: center;
    gap: 8px;

    .sectionLabel { margin: 0; }
    .sectionHint { margin: 0; }
    .sectionHint.error { color: var(--el-color-danger); }
    > :last-child { margin-left: auto; }
  }

  .loraRows { display: grid; gap: 6px; }

  .loraRow {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 108px 28px;
    align-items: center;
    gap: 6px;

    // 强度是数字输入框，给固定宽度避免长数字把删除按钮挤出去。
    .loraStrength { width: 108px; }
  }
}
</style>
