# Toonflow 插件开发指南

**DEVELOPER GUIDE**　工具 · 画布节点 · 技能

本文面向 Toonflow 插件开发者，介绍 tools、nodes、skill 的开发契约、最小示例、构建与安装流程。**teams 当前处于测试阶段，尚未开放。**

示例依据当前仓库实现，在 Toonflow 的 Bun Workspaces 中开发。脚手架使用 workspace:\* 引用；版本与依赖应跟随所开发的 Toonflow 版本。

> **阅读路线**　首次开发先读「01 开发总览」，再按扩展类型进入 Tools、Nodes 或 Skill；完成后对照「06 交付前检查」。
>
> **开放状态**　Tools / Nodes / Skill 可开发；A2A Teams 暂未开放。

---

# 01 · 开发总览

## 1\. 选择扩展类型

| **类型** | **适用场景**                                                  | **运行方式与交付物**                                           |
| -------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| tools    | 为 Agent 增加搜索、文件操作、网络请求、媒体处理等可调用能力。 | Bun 服务端执行；分发 \<name\>\.tool\.js，可附带 Vue 消息组件。 |
| nodes    | 增加画布交互组件、输入输出端口和节点操作。                    | 浏览器或桌面 WebView 执行；分发 \<name\>\.umd\.js。            |
| skill    | 约定任务流程、专业方法、输出要求与参考资料。                  | 按需读取 SKILL\.md 和资源，无需编译。                          |
| teams    | 组织多 Agent 的职责和协作。                                   | 未开放，见本文第五章。                                         |

需要可执行操作时开发 tools，需要画布界面时开发 nodes，已有操作能力足够、只需明确流程时开发 skill。三类扩展可配合使用。

## 2\. 开发环境与目录

使用根目录 package\.json 指定的 Bun 版本。以下命令在仓库根目录运行：

```Bash
bun install
bun run dev:plugins
bun run dev
```

dev:plugins 构建工具和节点，并同步到开发用 data/。dev 启动 Web 与 Server，不会自动重新构建插件。开发页面默认为 http://localhost:5173，Server 默认监听 3000。

```Plain Text
packages/
  toolScaffold/        工具构建器与运行时类型
  nodeScaffold/        节点构建器与运行时接口
  tools/<toolName>/    工具源码
  nodes/<nodeName>/    节点源码
  skills/<skillName>/  SKILL.md 与附属资源
build/
  tools/              <toolName>.tool.js
  nodes/              <nodeName>.umd.js
  skills/             内置技能副本
data/
  tools/              已安装工具
  nodes/              已安装节点
  skills/             已安装全局技能
  settings.json       设置与插件配置
```

build/ 是构建产物，data/ 是运行时安装目录。生产数据位置由宿主决定，不要假定是终端当前目录。工作区局部技能放在当前项目的 skill/，注意这里是单数。

## 3\. 命名与版本

- 插件标识、源码目录、自有函数、变量和组件使用小驼峰，例如 echoTool、noteNode、storyReview。Vue 文件按 template → script → style 排列。

- 工具文件名为 \<toolName\>\.tool\.js，节点文件名为 \<nodeName\>\.umd\.js，必须与构建标识一致；不要在文件名中追加版本。

- SKILL\.md 是协议固定名称，保留大写。

- tools、nodes 的版本来自插件 package\.json\.version；skill 的版本来自 frontmatter 的 metadata\.version。

- 使用完整 SemVer，例如 1\.0\.0、1\.1\.0\-beta\.1。正常覆盖安装要求新版本高于旧版本。

## 4\. 安装、更新与调试

1. 构建产物，或准备 Skill 主文件与资源包。

2. 打开“设置 → 插件市场 → 已安装 → 安装插件”。

3. 检查插件名称、版本与加载错误；有配置时填写并保存，工具和节点需处于启用状态。

4. 执行一次实际操作，检查输出、失败反馈与取消行为。

同版本反复调试、降级或旧版本无有效版本号时，在“设置 → 开发者选项 → 手动安装插件”勾选“强制安装（允许覆盖同版本或降级）”。强制安装仍会校验格式。

安装管理要求从桌面端或 Server 本机发起。开发者选项支持本地文件和 HTTP/HTTPS 文件直链；直链不能包含 URL 用户名密码，也不能返回登录页或 HTML 预览页。下载最多等待 30 秒，最多跟随 5 次重定向。

| **类型** | **安装格式**                         | **限制**                                      |
| -------- | ------------------------------------ | --------------------------------------------- |
| tools    | \.tool\.js                           | 非空，最多 20 MiB，保留构建元数据和默认导出。 |
| nodes    | \.umd\.js                            | 非空，最多 20 MiB，导出名必须匹配文件名。     |
| skill    | \.md、\.zip、\.tar、\.tar\.gz、\.tgz | 包及解包总量最多 20 MiB；恰好一个 SKILL\.md。 |

桌面客户端也支持网页唤起安装，应用会展示信息并要求用户确认：

```TypeScript
const installUrl = new URL("toonflow://install");
installUrl.searchParams.set("type", "tool");
installUrl.searchParams.set("url", "https://example.com/plugins/echoTool.tool.js");
window.location.href = installUrl.href;
```

本文开放类型使用 tool、node、skill。普通浏览器开发模式不注册桌面协议。

## 5\. 运行边界

工具拥有 Server 进程权限；节点在宿主页面执行。优先复用宿主文件、模型、画布与 FFmpeg 能力，不打包真实密钥或本机数据。界面交互和画布操作需要对应页面保持连接。

配置表单统一使用 @form\-create/element\-ui 的 JSON 规则。工具配置在 context\.config；节点配置在 useNode\(\)\.config。分别保存于 settings\.json 的 toolConfigs 与 nodeConfigs。当前 FFmpeg 使用 ffmpeg\(signal?\) 工厂接口，具体边界见后文。

---

# 02 · Tools 工具插件开发

一个工具插件可以提供多个 Agent 工具，并可为工具消息附带 Vue 界面。工具由 Bun 动态加载，源码可使用 Bun、Node 内置模块和已声明依赖。插件标识与实际工具调用名是两个概念：下面插件为 echoTool，调用名为 echoText。

## 1\. 创建最小工具

新建 packages/tools/echoTool/，包含 package\.json、tsconfig\.json、build\.ts、src/index\.ts；可选 readme\.md 在构建时嵌入插件说明。

**package\.json**

```JSON
{
  "name": "@toonflow/tool-echo",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "bun build.ts",
    "typecheck": "tsc"
  },
  "dependencies": { "zod": "^4.6.2" },
  "devDependencies": { "@toonflow/tools-scaffold": "workspace:*" }
}
```

**tsconfig\.json**

```JSON
{
  "extends": "../../../tsconfig.base.json",
  "include": ["build.ts", "src"]
}
```

**build\.ts**

```TypeScript
import { createToolConfig } from "@toonflow/tools-scaffold";

await createToolConfig({
  name: "echoTool",
  displayName: "文本回声",
  description: "给输入文本添加前缀并返回结果。",
  author: "示例作者",
  github: "",
  prompt: "用户需要测试工具调用或明确要求返回带前缀的文本时，使用 echoText。",
  configRules: [{
    type: "input",
    field: "prefix",
    title: "文本前缀",
    value: "回声：",
    props: { maxlength: 100 },
  }],
}, import.meta.url);
```

**src/index\.ts**

```TypeScript
import { z } from "zod";
import type { ToolDefinition, ToolPlugin } from "@toonflow/tools-scaffold/runtime";

const configSchema = z.object({
  prefix: z.string().max(100).default("回声："),
}).strict();

const inputSchema = z.object({
  text: z.string().min(1).max(2000).describe("需要添加前缀的文本"),
}).strict();

const plugin: ToolPlugin = {
  validateConfig(config) {
    return configSchema.parse(config);
  },
  createTools(context) {
    const config = configSchema.parse(context.config);
    const tool: ToolDefinition = {
      name: "echoText",
      label: "文本回声",
      description: "在输入文本前添加用户配置的前缀，返回完整文本。",
      promptSnippet: "给文本添加已配置的前缀。",
      parameters: z.toJSONSchema(inputSchema, { io: "input", target: "draft-07" }),
      async execute(toolCallId, params, signal) {
        signal?.throwIfAborted();
        const { text } = inputSchema.parse(params);
        const result = config.prefix + text;
        return {
          content: [{ type: "text", text: result }],
          details: { text: result },
        };
      },
    };
    return [tool];
  },
};

export default plugin;
```

在仓库根目录执行：

```Bash
bun install
bun run --cwd packages/tools/echoTool typecheck
bun run --cwd packages/tools/echoTool build
```

产物为 build/tools/echoTool\.tool\.js。安装并启用后，在选择工作区的 Agent 对话中要求“调用 echoText，输入 hello”，应返回“回声：hello”。修改配置前缀后，再发一条消息验证。

## 2\. 插件与工具契约

| **接口**                 | **职责**                                                                 |
| ------------------------ | ------------------------------------------------------------------------ |
| validateConfig\(config\) | 同步校验并返回规范化配置；保存和加载时调用，失败抛错。                   |
| createTools\(context\)   | 返回 ToolDefinition\[\] 或其 Promise；可返回空数组，表示本轮不提供能力。 |

| **ToolDefinition 字段** | **说明**                                                                      |
| ----------------------- | ----------------------------------------------------------------------------- |
| name                    | 实际调用名，使用小驼峰；同一轮所有插件之间必须唯一。                          |
| label / description     | 界面名称及供模型理解的用途、输入和限制。                                      |
| parameters              | JSON Schema，通常由 z\.toJSONSchema 生成。                                    |
| execute                 | 异步执行，返回 content 与 details；文本 content 为 \{ type: "text", text \}。 |
| promptSnippet           | 系统提示中的简短用途摘要。                                                    |
| promptGuidelines        | 运行时规则字符串数组。                                                        |
| executionMode           | 可选 sequential 或 parallel。                                                 |

执行签名为 execute\(toolCallId, params, signal, onUpdate, ctx\)。onUpdate 可上报中间结果；最后的 ctx 是 Pi 执行上下文，与 createTools\(context\) 的 Toonflow 上下文不同。

parameters 不替代执行时校验。execute 中仍用 Zod parse 校验输入，将 signal 传给支持取消的请求，长任务在阶段边界检查取消。失败时抛出明确错误。

build\.ts 的 prompt 用于插件共享静态规则，promptSnippet 用于单个工具摘要，promptGuidelines 用于动态约束。宿主只汇总本轮实际加载工具的规则并去重。

## 3\. 构建元数据与配置

| **字段**        | **规则**                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------ |
| name            | 必填小驼峰，最长 96 字符。                                                                       |
| displayName     | 去除首尾空白后 1–100 字符。                                                                      |
| description     | 必填字符串，最多 2000 字符。                                                                     |
| author / github | 必填字符串，可为空；GitHub 链接须为无账号密码的 [https://github\.com](https://github.com) 地址。 |
| prompt          | 可选，最多 20000 字符。                                                                          |
| configRules     | 必填纯 JSON 数组，最多 100 项，无配置传 \[\]。                                                   |
| components      | 可选，“实际工具名 → Vue 源文件路径”映射。                                                        |

version 自动读取 package\.json，readme 自动读取子包 readme\.md，无需再次写入构建参数。

configRules 使用 FormCreate 规则：field 对应 context\.config 属性，value 为默认值，选项放 options，组件属性放 props。例如密码输入可使用 props: \{ type: "password", showPassword: true \}。

宿主提取顶层规则的 field/value 默认值，以已保存配置覆盖，再调用 validateConfig。配置保存于 toolConfigs\.\<插件名\>。规则不得包含函数或回调；前端表单校验不能替代服务端校验。API Key 由用户填写，不写入源码或返回给模型。

## 4\. 宿主上下文

| **API**                        | **用途与边界**                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cwd                            | 本次绑定的工作区绝对路径。                                                                                                                                     |
| config                         | 仅当前插件已校验配置，不是全局设置。                                                                                                                           |
| resolvePath\(path, readOnly?\) | 检查工作区边界和符号链接后返回绝对路径；readOnly=true 还允许读取全局技能目录。                                                                                 |
| writeFile\(path, content\)     | 带锁的原子文本写入；输出父目录应先存在。                                                                                                                       |
| sdk                            | 注入 defineTool、createReadToolDefinition、createWriteToolDefinition、createEditToolDefinition、createLsToolDefinition、detectSupportedImageMimeTypeFromFile。 |
| ffmpeg\(signal?\)              | 获取绑定工作区的原生 FFmpeg 工厂。                                                                                                                             |
| media?                         | listModels、generateImage、generateVideo、generateAudio。                                                                                                      |
| canvas?                        | 当前画布 id、节点工具 tools、call\(request, signal?\) 和可选 getNodeLabel。                                                                                    |
| question?                      | ask\(toolCallId, request, signal?\)，等待用户作答或跳过；需要配套交互组件。                                                                                    |
| skills?                        | list、read、create、update；请求使用 name、scope?、path?，写入提供 content。                                                                                   |

可选能力先判断是否存在，缺少所需上下文时可以返回 \[\]。复用 SDK 文件工具时，通过 operations 接入宿主 resolvePath/writeFile，参考 packages/tools/workspace/src/index\.ts，不把整套 Pi SDK 打入插件。

媒体请求使用 providerId、modelId、prompt，其余字段见 packages/toolScaffold/src/runtime\.ts；结果数组提供工作区资源 path、mimeType、mediaType。

## 5\. FFmpeg

context\.ffmpeg\(\) 返回原生 @renmu/fluent\-ffmpeg 工厂，支持链式调用、事件、流、run/save/pipe/clone 和 ffprobe 回调。以下片段用于 execute 内，输入和输出父目录应已存在：

```TypeScript
const ffmpeg = await context.ffmpeg();
await new Promise<void>((resolve, reject) => {
  ffmpeg("assets/input.mp4")
    .videoCodec("libx264")
    .on("error", reject)
    .on("end", () => resolve())
    .save("assets/output.mp4");
});
```

路径必须位于工作区。原始参数、复杂滤镜与媒体清单的间接 I/O 不做完整解析，可信工具接口不是文件系统沙箱。处理用户素材时使用新输出文件名。

> **取消边界：**context\.ffmpeg\(signal\) 只覆盖获取工厂的准备阶段。启动后由调用方监听取消并 command\.kill\("SIGKILL"\)，处理启动前取消并清理监听器。缺少 FFmpeg/FFprobe 时抛出 FFMPEG\_REQUIRED（HTTP 424），用户安装或配置后重试，不会自动安装或重跑。

## 6\. 可选消息界面

在 build\.ts 添加 components: \{ echoText: "src/resultCard\.vue" \}，键是实际工具名。组件示例：

```Plain Text
<template>
  <div class="resultCard">
    <span>{{ tool.status }}</span>
    <pre v-if="tool.result">{{ tool.result }}</pre>
  </div>
</template>

<script setup lang="ts">
import type { ToolCall } from "@toonflow/tools-scaffold/runtime";

defineProps<{ tool: ToolCall; directory?: string }>();
</script>
```

子包声明所用 Vue/UI 依赖；组件显式导入 UI 组件，不能依赖主应用自动导入。构建器将界面与 CSS 嵌入同一个 \.tool\.js；Vue、Element Plus、Axios、form\-create 复用 toonflowToolHost 实例。

宿主传入 tool 与可选 directory。tool 包括 id、name、args?、result?、question?、status；状态为 running、success、error、interrupted。历史消息可能没有实时 question，界面应兼容。提问交互参考 packages/tools/askUser，不要遗漏作答界面。

## 7\. 构建与常见问题

普通单包 build 只写 build/tools。仅 NODE\_ENV=dev 时同步 data/tools。PowerShell 中可按下面方式单包同步并恢复环境变量：

```PowerShell
$previousNodeEnv = $env:NODE_ENV
try {
  $env:NODE_ENV = "dev"
  bun run --cwd packages/tools/echoTool build
} finally {
  $env:NODE_ENV = $previousNodeEnv
}
```

bun run build:tools 清理 build/tools 后构建全部工具，不修改安装目录。产物首行 toonflowTool 元数据、可选第二行 toonflowToolClient 由脚手架生成，不能删除或重排。

安装器会清除 Bun 对该模块的缓存；直接复制覆盖 data/tools 不经过缓存清理，仍执行旧代码时重启 Server 或通过安装入口重装。配置和启停用于后续加载，不替换执行中的函数。

精确的 import \{ z \} from "zod" 构建时映射为宿主 toonflow:tool\-zod；产物应通过兼容宿主加载。普通依赖随构建打包，但原生模块、动态资源和外部文件仍需验证分发完整性。

| **现象**         | **检查方向**                                                        |
| ---------------- | ------------------------------------------------------------------- |
| 构建后没有变化   | 是否只更新 build，是否同步/安装，模块是否仍有缓存。                 |
| 元数据或导出错误 | 文件名与 name 是否一致；默认导出是否有 validateConfig/createTools。 |
| 工具名称重复     | 调整 ToolDefinition\.name，同步组件映射和提示词。                   |
| 启用后不可用     | 配置是否有效，createTools 是否因上下文缺失返回 \[\]。               |
| 界面加载失败     | 检查组件映射、客户端依赖与历史消息兼容。                            |

参考源码：packages/toolScaffold/index\.ts、packages/toolScaffold/src/runtime\.ts、apps/server/src/utils/plugins/tools\.ts、apps/server/src/agent/tools/index\.ts。

---

# 03 · Nodes 节点插件开发

节点是 Vue 3 \+ TypeScript 工作区包。createNodeConfig 定义构建元数据，defineOptions 声明组件与端口，useNode 取得实例状态。浏览器运行时代码统一从 @toonflow/nodes\-scaffold/runtime 导入；包根入口只用于构建配置。

## 1\. 创建最小节点

新建 packages/nodes/noteNode/，包含 package\.json、tsconfig\.json、vite\.config\.ts、readme\.md、src/index\.vue。根 workspace 已包含 packages/nodes/\*，无需手工注册主应用。

**package\.json**

```JSON
{
  "name": "@toonflow/node-note",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite build --watch",
    "typecheck": "vue-tsc --noEmit"
  },
  "peerDependencies": {
    "vue": "^3.5.42",
    "@vue-flow/core": "^1.48.2",
    "element-plus": "^2.14.5"
  },
  "devDependencies": {
    "@toonflow/nodes-scaffold": "workspace:*",
    "typescript": "~6.0.3",
    "vite": "^8.2.2",
    "vue-tsc": "^3.3.11"
  }
}
```

**tsconfig\.json**

```JSON
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
```

**vite\.config\.ts**

```TypeScript
import { createNodeConfig } from "@toonflow/nodes-scaffold";

export default createNodeConfig({
  name: "noteNode",
  displayName: "便签",
  author: "你的名字",
  github: "",
}, import.meta.url);
```

readme\.md 写入插件用途与用法，例如“在画布中编辑短文本，通过 text 端口向其他节点提供文本”。

**src/index\.vue**

```Plain Text
<template>
  <nodeSkeleton v-bind="nodeProps">
    <textarea
      v-model="outputs.text.value"
      class="noteEditor nodrag nopan nowheel"
      aria-label="便签文本"
      @pointerdown.stop
      @mousedown.stop
      @dblclick.stop
      @keydown.stop />
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { nodeSkeleton, useNode, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";

defineOptions({
  inheritAttrs: false,
  handles: [
    { id: "text", type: "source", dataType: "STRING", label: "文本输出" },
  ] satisfies NodeHandle[],
});

const { nodeProps, outputs } = useNode({
  label: "便签",
  outputs: { text: { dataType: "STRING", value: "" } },
});
</script>

<style scoped>
.noteEditor {
  box-sizing: border-box;
  width: 280px;
  min-height: 120px;
  resize: vertical;
}
</style>
```

nodeSkeleton 将端口与输出同步到 node\.data，由画布保存流程持久化；重新打开后 useNode 恢复匹配的输出。短文本可直接存画布 JSON；长正文或媒体使用工作区文件。

inheritAttrs: false 避免 Vue Flow 属性覆盖骨架参数。nodrag、nopan、nowheel 是 Vue Flow 约定交互类名，配合事件阻止冒泡，避免编辑时触发画布拖动或快捷键。

## 2\. 开发与安装

```Bash
bun install
bun run --filter '@toonflow/node-note' typecheck
bun run --filter '@toonflow/node-note' dev
```

保持监听进程运行，另一终端执行 bun run dev，打开画布后从添加节点菜单选择“便签”。新建 workspace 后重新 bun install，建立依赖链接。

| **命令**            | **行为**                                                            |
| ------------------- | ------------------------------------------------------------------- |
| 单包 dev            | 监听构建，生成 build/nodes/noteNode\.umd\.js 并同步 data/nodes。    |
| 单包 build          | 默认只生成 build；NODE\_ENV=dev、Vite development 或 watch 时同步。 |
| bun run dev:plugins | 构建所有 tools/nodes，并同步开发目录。                              |
| bun run build:nodes | 清理 build/nodes 后构建全部节点，不更新 data。                      |

构建完成后点击节点标题栏刷新，或刷新宿主页面。watch 是构建监听，不是独立网页服务器；刷新前宿主会通知同类型实例保存。开发同步不会清除禁用标记。

分发原始 \.umd\.js，保留元数据与 toonflowNodes\.\<name\> 导出。宿主从 /api/nodes/get 读取列表，从 /api/nodes/files?name=noteNode 获取脚本，注册画布类型 remote\-noteNode。

当前 UMD 会注入组件样式，安装和加载以单 JS 文件为单位。不要假定独立字体、图片或动态资源文件会自动随插件安装；发布前检查产物的资源引用。

## 3\. 元数据与配置

| **createNodeConfig 字段** | **说明**                                                                 |
| ------------------------- | ------------------------------------------------------------------------ |
| name                      | 唯一小驼峰标识，决定文件名与导出名。                                     |
| displayName               | 非空显示名称。                                                           |
| author / github           | 可为空；非空 GitHub 链接须为 [https://github\.com](https://github.com)。 |
| configRules?              | 最多 100 项 FormCreate JSON 规则。                                       |

版本来自 package\.json\.version，说明来自 readme\.md，写入首行 toonflowNode 元数据。配置在 useNode\(\)\.config 中读取，脚本使用 config\.value\.\<field\>，只读且响应式。同类型实例共用配置，默认值取规则 value，不写入画布 JSON。

必填字段可用 validate: \[\{ required: true, message: "请填写" \}\]。配置会提供给浏览器节点，不应当作只在服务器可见的秘密存储。

## 4\. 状态与端口

useNode\(options?\) 必须在 setup 中调用，选项支持 label、icon、handles、outputs。图标和默认端口通常放 defineOptions，供创建节点前菜单与连线筛选使用。

| **返回成员**                           | **用途**                                                        |
| -------------------------------------- | --------------------------------------------------------------- |
| id / node                              | 节点 ID 与 Vue Flow 节点；业务状态可写入可序列化的 node\.data。 |
| nodeProps                              | 传入 nodeSkeleton 的计算属性。                                  |
| handles / outputs                      | 可修改 ref，脚本使用 \.value，模板自动解包。                    |
| config                                 | 同类型节点的只读配置。                                          |
| nodeEvent / nodeTools                  | 节点事件和对 Agent 暴露的操作。                                 |
| files / ai / ffmpeg                    | 工作区文件、模型与媒体处理。                                    |
| previewReady / updateNodeInternals\(\) | 预览挂载状态与端口位置重测。                                    |

端口格式为 \{ id, type, dataType, label? \}。target 是输入，source 是输出；ID 在节点内唯一且稳定。outputs 的键必须匹配 source 端口 ID。dataType 可为字符串或字符串数组，\* 表示通配；禁止自连接，并要求方向、存在性与类型相容。

| **输出类型**                 | **value**                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| STRING                       | 字符串。                                                                                 |
| INT / FLOAT                  | 安全整数 / 有限数值。                                                                    |
| BOOLEAN                      | 布尔值。                                                                                 |
| IMAGE / MASK / VIDEO / AUDIO | \{ url: "assets/\.\.\.", mimeType: "image/png" \}，MIME 主类型须匹配；MASK 使用 image/。 |

端口可声明自定义类型名，但当前输出校验只支持上表。增加类型名本身不会实现新的输出协议。

给示例增加 id="in"、type="target"、dataType="STRING" 端口，并从原有 useNode 解构取得 nodeEvent 后，可订阅输入：

```TypeScript
nodeEvent.on("input:in", values => {
  const input = values.find(item => item.dataType === "STRING" && typeof item.value === "string");
  if (input?.dataType === "STRING" && typeof input.value === "string") {
    outputs.value.text.value = input.value;
  }
});
```

输入是数组；连接尚无输出时仍有来源记录，value 为 undefined。订阅会立即执行并随连接/内容变化更新，不自动运行上游节点。主动查询使用 useNodeInputs 的 getTargetValues、getTargetSources、getSourceValue。

## 5\. 事件与 Agent 节点操作

在 setup 中同步注册 nodeEvent\.on，返回注销函数，卸载时自动清理。

| **事件**                     | **职责**                                               |
| ---------------------------- | ------------------------------------------------------ |
| input:\<id\> / output:\<id\> | 监听输入数组 / 单个输出，避免回写循环。                |
| save                         | 等待文件保存；参数为 reload 时将重载，可抛错阻止刷新。 |
| copy                         | 返回合并到副本 data 的对象，例如文本快照。             |
| delete                       | 清理节点任务；删除前会调用已有 save 回调。             |
| canConnect                   | 同步返回 true 才通过，不能放宽基础端口校验。           |

将 z 加入运行时 import，在原有 useNode 解构加入 nodeTools，注册修改文本的操作：

```TypeScript
nodeTools.register({
  name: "setText",
  description: "修改便签的文本内容",
  parameters: z.strictObject({ text: z.string().max(10000) }),
  execute({ text }, { signal }) {
    signal?.throwIfAborted();
    outputs.value.text.value = text;
    return { text };
  },
});
```

函数名为最多 64 字符的小驼峰，暴露为 node:setText。启用画布操作工具后，Agent 通过 getCanvas 查询，再用 nodeTools 调用 \{ nodeId, name: "node:setText", args: \{ text: "新内容" \} \}。

参数应为可转换 JSON Schema 的 Zod 对象，执行前用原 schema 的 parseAsync 校验。返回值可 JSON 序列化，失败抛错；异步操作传递 signal，更新状态前再检查取消。单次最多等待 120 秒，忽略信号的代码不会被自动强制终止。节点操作依赖正在挂载的画布实例。

## 6\. 文件与媒体持久化

files\.uploadFile\(file\) 自动在 assets/\<节点 ID\>/ 下创建随机文件，返回工作区相对路径。媒体输出的 url 保存这个路径；Blob URL 只用于预览，不写进画布 JSON。

以下示例用于已声明 image source 端口（IMAGE）的节点：

```TypeScript
import { useNode, type NodeOutputs } from "@toonflow/nodes-scaffold/runtime";

const { outputs, files } = useNode<NodeOutputs>();
const imageUrl = files.useFileUrl(() => outputs.value.image?.value as
  { url: string; mimeType: string } | undefined, error => console.error(error));

async function uploadImage(file: File) {
  if (!file.type.startsWith("image/") || !file.size || file.size > 20 * 1024 * 1024) {
    throw new Error("请选择 20 MiB 以内的非空图片");
  }
  const path = await files.uploadFile(file);
  outputs.value.image = { dataType: "IMAGE", value: { url: path, mimeType: file.type } };
}
```

imageUrl 可绑定 img src。useFileUrl 随值变化、预览状态和卸载释放临时 URL；界面捕获上传错误并展示，避免重复上传。

files\.getWorkspaceFiles\(\) 返回绑定工作区的文件对象，支持 list/read/readText/readJson/write/writeJson/rename/remove/mkdir。路径使用工作区相对路径，mkdir 不递归创建父目录。多步操作开始时取得一个实例并复用，避免切换项目后写错目录。

长文本参考 packages/nodes/textNode/src/index\.vue：正文写 assets/\<节点 ID\>/content\.md，node\.data 保存引用，save 等待写入，copy 提供快照。写入成功前不删除原正文，不吞掉错误。支持撤销的宿主会保留素材，替换输出时不要直接删除可能被副本引用的文件。

## 7\. 模型与 FFmpeg

从原有 useNode 中取得 ai，使用已配置模型：

```TypeScript
async function generateText(prompt: string, signal?: AbortSignal) {
  const model = (await ai.getModels(signal))[0];
  if (!model) throw new Error("请先在设置中添加模型");
  const result = await ai.generate({
    providerId: model.providerId,
    modelId: model.modelId,
    prompt,
    signal,
  });
  return result.text;
}
```

onEvent 可接收文本、推理增量和工具事件；references 支持文本、图片、视频。媒体引用使用工作区相对路径，并传 directory 绝对路径快照，可从 files\.getWorkspaceFiles\(\)\.list\(\) 取得。ai\.getMediaModels/generateImage/generateVideo 提供媒体能力，结果包含已落盘 path、mimeType。

FFmpeg 在 setup 取得 const \{ ffmpeg: loadFfmpeg \} = useNode\(\)，执行时 await loadFfmpeg\(signal\)。输入文件和输出父目录应存在：

```TypeScript
async function convertVideo(signal?: AbortSignal) {
  const ffmpeg = await loadFfmpeg(signal);
  const outputPath = "assets/" + crypto.randomUUID() + ".mp4";
  await new Promise<void>((resolve, reject) => {
    ffmpeg("assets/input.mp4")
      .videoCodec("libx264")
      .audioCodec("aac")
      .on("error", reject)
      .on("end", () => resolve())
      .save(outputPath);
  });
  return { url: outputPath, mimeType: "video/mp4" };
}
```

save 返回命令对象，不是完成 Promise，需监听 end/error。调用经 /api/ffmpeg/execute 在宿主执行，工厂取得时固定工作区目录。支持多输入输出、滤镜、截图、拼接、clone、ffprobe 与能力查询。

节点卸载、外部 signal 或 command\.kill 可取消转换。命令开始后不能改配置，并行任务用独立命令或 clone。浏览器接口不接受 Node\.js Stream、子进程、logger、执行程序路径 setter 或 pipe；ffprobe/能力查询取消仅停止等待。缺少 FFmpeg 时按宿主提示安装后重试。

## 8\. 排查与规范

- 菜单没有节点：检查实际安装目录、启用状态和 /api/nodes/get 的 loadError。

- 仍加载旧代码：确认 dev/watch 已同步，再刷新节点；普通生产构建不更新安装目录。

- 连线无输出：核对端口 ID、outputs 键与数据类型，处理 undefined。

- 重开后媒体丢失：核对相对路径与实际文件，避免持久化 Blob URL。

- 刷新失败：检查 save\("reload"\) 是否等待写入或拒绝正在运行的任务。

Vue、Vue Flow、Element Plus 与相关 Pi SDK 复用宿主实例，不创建另一份 Vue app。第三方组件保留原始导入名，如 ElInput，模板可用 el\-input；自有组件使用小驼峰。样式优先 scoped，不加入全页 reset。节点预览槽位按视口挂载，工具注册与任务逻辑放节点本身 setup。

参考源码：packages/nodeScaffold/index\.ts、src/runtime\.ts、src/useNode\.ts、src/nodeAi\.ts、src/nodeTools\.ts，以及 packages/ffmpeg/src/browser\.ts。

---

# 04 · Skill 技能插件开发

Skill 用 Markdown 描述特定任务的方法、步骤和输出要求，可附参考资料、模板和素材。Skill 不需要编译，也不会自行增加工具、节点或执行权限；程序能力由本轮已启用的 tools/nodes 提供。

## 1\. 目录与加载范围

```Plain Text
storyReview/
  SKILL.md
  references/
    reviewChecklist.md
  templates/
    reviewReport.md
```

SKILL\.md 大小写不可改；新建技能名称、目录和资源文件使用小驼峰。references/templates 只是组织约定，不会自动加载。

| **位置**                              | **用途**                                        |
| ------------------------------------- | ----------------------------------------------- |
| 当前项目 skill/storyReview/SKILL\.md  | 工作区技能，仅当前项目使用；目录为单数 skill。  |
| 数据目录 skills/storyReview/SKILL\.md | 全局安装技能，开发环境通常为 data/skills。      |
| packages/skills                       | 内置技能源码，不是 Agent 直接扫描的运行时目录。 |

Agent 扫描工作区 skill/ 与数据目录 skills/，同名时工作区优先。宿主关闭 SDK 默认目录扫描，放入 \.agent/skills 或 \.claude/skills 不会自动生效。

内置技能在初始化时补入数据目录；已有初始化标记后，修改源码或更新应用不会持续覆盖已安装技能。调试优先用工作区目录，或重新安装全局版本。

## 2\. SKILL\.md 字段

文件使用 UTF\-8，以 \-\-\- 包围 YAML frontmatter，后接 Markdown 正文。

| **字段**                   | **要求与用途**                                                               |
| -------------------------- | ---------------------------------------------------------------------------- |
| name                       | 唯一标识，建议与目录名一致；新技能为不超过 64 字符、以小写字母开头的小驼峰。 |
| description                | 必填非空字符串，最多 1024 字符；明确做什么、何时使用。                       |
| disable\-model\-invocation | 可选布尔值。true 表示用户明确指定时使用；省略/false 可自动匹配。             |
| metadata\.displayName      | 插件市场显示名，缺省使用 name。                                              |
| metadata\.version          | 展示和更新比较，发布用完整 SemVer，例如 "1\.0\.0"。                          |
| metadata\.author           | 作者；Toonflow 被卸载逻辑作为内置标记，自定义技能不要使用该值。              |
| metadata\.github           | 可选、无账号密码的 [https://github\.com](https://github.com) 链接。          |

disable\-model\-invocation 是 SDK 固定协议字段，保留短横线；SDK 列表中的 disableModelInvocation 是解析后的属性，不可混写。其他字段如 allowed\-tools、model 不会开通授权或模型能力。

安装器兼容已有短横线名称，新技能遵循宿主小驼峰规则。当前 SDK 可能对小驼峰产生诊断但仍加载；不要依赖缺失 name 的回退或宽松加载。

## 3\. 最小可用示例

在当前项目创建 skill/storyReview/SKILL\.md：

```Markdown
---
name: storyReview
description: 检查短篇剧本中的人物动机、因果关系和情节连续性。用户要求审阅剧本、查找剧情漏洞或提出修改意见时使用。
metadata:
  version: "1.0.0"
  displayName: 剧本审阅
  author: exampleStudio
---

# 剧本审阅

只审阅用户本次提供或指定的剧本，不擅自改写原文。

1. 确认审阅范围；未提供剧本时，请用户补充正文或文件位置。
2. 阅读完整目标内容，再读取 [审阅检查项](references/reviewChecklist.md)。
3. 按检查项识别问题，为每个问题引用原文中的具体情节。
4. 按“位置、问题、依据、建议”输出结果，建议与原文事实分开。
5. 未发现明确问题时直接说明，不为了凑数制造剧情缺陷。
```

再创建 skill/storyReview/references/reviewChecklist\.md：

```Markdown
# 审阅检查项

- 人物是否有足以支持当前行动的动机？
- 关键事件之间是否存在明确因果关系？
- 同一人物、物品和事件的状态是否前后一致？
- 信息不足时标记“待确认”，不要当作已证实的错误。
```

本例只需两个文本文件，无需 package\.json、构建脚本或 JavaScript 导出。没有附属资料时，可直接分发单个 SKILL\.md。

## 4\. 自动与显式调用

启用 skillOperator 时，Agent 通过 action=list 查询目录，action=read 按需读取正文与资料。没有该工具时，SDK 提供可自动调用技能的名称、描述和位置，由可用 read 工具读取。可见不代表全文已加载，Skill 不会补齐缺失的操作能力。

显式调用在输入框开头使用：

```Plain Text
/skill:storyReview 请审阅下面这段剧本：……
```

也可从技能菜单选择。宿主将主文件正文及位置加入本次消息；附属资料仍按需读取。disable\-model\-invocation=true 的技能也可显式调用。

普通新一轮请求会重新创建技能资源，skillOperator 目录查询实时扫描。修改后等待当前回复结束，再发新消息验证。运行中的子 Agent 补充消息是文本引导，不展开 /skill: 命令。

## 5\. skillOperator 调试

以下为调用参数：

```JSON
{ "action": "list", "scope": "workspace" }

{ "action": "read", "name": "storyReview", "scope": "workspace" }

{
  "action": "read",
  "name": "storyReview",
  "scope": "workspace",
  "path": "references/reviewChecklist.md"
}
```

| **操作** | **行为**                                                       |
| -------- | -------------------------------------------------------------- |
| list     | 查询目录，可选 scope。                                         |
| read     | 读取正文或资料；必填 name，可选 scope/path。                   |
| create   | 新建不覆盖，提供 name 与完整 content，新技能先创建 SKILL\.md。 |
| update   | 完整替换文件，修改前先读取。                                   |

scope 支持 workspace/global；新建默认工作区。读写省略范围时按工作区优先选取。要访问被同名工作区覆盖的全局技能，显式传 scope=global。

读取、新建、修改开关默认开启，可分别关闭，目录查询保留。content 单次最多 200000 字符，path 必须在技能内。这些开关只约束 skillOperator，不是所有工具的统一权限控制。

## 6\. 参考资料与脚本

Markdown 相对链接以当前文档目录为基准。skillOperator 的 path 始终相对技能根目录，读取时需换算路径并去掉章节锚点。跨技能先查询真实名称与 scope，不假定全局/工作区技能在同一父目录。

包内脚本不会被安装器或技能加载过程自动执行。若需要脚本，正文说明用途、输入输出与环境，并确认本轮已有可执行它的工具；稳定程序能力建议独立 tools 插件。

## 7\. 打包、安装与更新

仅主文件可安装 \.md，保存时统一为 SKILL\.md；有资源推荐 ZIP：

```Plain Text
storyReview.zip
  storyReview/
    SKILL.md
    references/
      reviewChecklist.md
```

也支持 SKILL\.md 与 references 直接位于包根目录。必须恰好一个准确命名的 SKILL\.md，所有资源在其目录内；不要附带同级其他技能、说明文件或整个仓库。安装目录取自 frontmatter\.name。

在 storyReview 的父目录执行 PowerShell：

```PowerShell
Compress-Archive -LiteralPath .storyReview -DestinationPath .storyReview.zip -Force
```

从插件市场已安装页或“设置 → 开发者选项 → 手动安装插件”选择技能安装。正常同名更新要求 metadata\.version 更高；开发调试可强制安装。**更新会替换整个技能目录**，新版未包含的旧资料不保留。

- 上传/下载包与解包总量均最多 20 MiB，最多 2000 个文件和目录。

- ZIP 支持普通存储或 Deflate，不支持加密和 ZIP64。

- TAR 使用普通 USTAR，不支持 PAX/GNU 扩展条目。

- 拒绝链接、设备等特殊文件、越界路径、重名、大小写冲突和系统保留名称。

- SKILL\.md 必须为有效 UTF\-8；二进制资源可随包保存，但文本编辑器不用于编辑二进制文件。

插件市场可导出全局技能为 ZIP。编辑主文件不能修改 name；保存不会自动升级 metadata\.version。移动资料后同步修正正文链接，排序仅影响显示。

## 8\. 验证与排查

1. 放入工作区 skill/，在技能菜单或 skillOperator 确认目录信息。

2. 显式调用 /skill:storyReview，检查正文要求和引用资料被使用。

3. 用匹配描述的自然语言验证自动选择，手动技能不应被主动套用。

4. 打包安装全局版本，用 scope=global 查询，避免同名工作区覆盖造成误判。

5. 升级后核对版本、正文和全部附属资源。

不显示时检查目录、大小写、YAML、name/description；旧内容优先检查同名覆盖与运行中会话。修改 packages/skills 不等于更新安装副本。

参考源码：apps/server/src/agent/skills/index\.ts、apps/server/src/agent/runtime/resources\.ts、apps/server/src/utils/plugins/install\.ts、apps/server/src/routes/skills，以及 packages/tools/skillOperator。

---

# 05 · A2A Teams 团队插件（未开放）

> **团队插件目前处于测试阶段，尚未开放。** 本章只说明用途与状态，不作为正式开发、安装或发布教程。

团队插件用于组织多个 Agent 的职责、指令和协作关系，并配套技能、知识资料及工具。

- 插件市场中的 Agent 分类与团队安装入口尚未开放。

- 开发者选项中的“Agent（暂未开放）”不可选择。

- 常规 Server 构建与启动目前不打包、初始化内置团队。

- 仓库保留脚手架和示例，但不代表已对外提供稳定插件协议。

现阶段可用 skill 定义流程与专业资料、tools 提供操作、nodes 提供画布交互。主 Agent 的临时子 Agent 能力不等同于团队插件开放。开放范围和契约以之后正式文档为准。

---

# 06 · 交付前检查

- 名称、导出名、产物文件名一致；发布更新递增有效版本。

- 代码示例按所在 Toonflow 版本完成类型检查与构建。

- 从最终分发文件安装，验证最小流程与配置合法/非法输入。

- 工具检查实际调用、失败反馈与取消；节点检查添加、连线、保存重开与异步任务。

- Skill 检查扫描范围、显式/自动调用与引用资源完整性。

- 目标平台与宿主内实际验证独立进行；构建通过不等于网络服务、模型或媒体转换已经验证。


