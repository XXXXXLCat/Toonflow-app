# 多角度分段角色板

角色资产板的默认版式：一块横屏板，左右两段。左段占约 3/4 画幅（单头 2/3），三个等宽竖栏放
**无头躯干与完整背面**；右段占约 1/4 画幅（单头 1/3），等高横栏放**脸与颈**，**格数由版式决定**
（一个 / 两个 / 三个头）。**画幅跟着版式走**：单头 16:9，双头与三头 4:3。

这套版式的目的只有一个：让下游同时拿到「角色长什么样」和「衣服在每个角度怎么裁」两组
互相独立、又必定属于同一个人的事实。具体做法是把**头部与躯干拆到两段**，各自用最适合
的比例说话——脸需要竖向的近景，躯干需要完整的横向轮廓。

## 目录

- [一、两阶段流程](#一两阶段流程)
- [二、版式](#二版式)
- [三、左栏为什么刻意无头](#三左栏为什么刻意无头)
- [四、左侧 90° 的方向约定](#四左侧-90-的方向约定)
- [五、各视图的共同要求](#五各视图的共同要求)
- [六、提示词写法](#六提示词写法)
- [七、画幅与落法](#七画幅与落法)
- [八、失败征兆](#八失败征兆)

## 一、两阶段流程

角色板不是一步到位的，分两步走：

1. **先出立绘**：一张 **9:16 竖版单人图**，画这个角色本人（正面、自然站姿）。
   这是**素材**，不是资产板——它的职责只是把「这个人长什么样」确定下来。
   **必须先在画布上确认这张立绘可用**，再往下走：立绘错了，各格只会错几遍。
2. **再转成板**：用这张立绘本作为参考图，通过**图生图**转成一张横版多角度板
   （单头 16:9，双头与三头 4:3）。

第二步在画布上**一键完成**：选中放立绘的图片节点，点节点顶部工具条里的
**「制作资产」**按钮，面板里选好版式（右段放几个头）与模型/分辨率，点「生成角色板」。
节点会在右侧自动建一个子节点、连好参考图线并开始生成——不需要手动搭节点。
**比例不用手选**：它跟着版式自动变（单头 16:9、双头与三头 4:3），与所选灰模一致。

**为什么立绘要 9:16、板是横版**：立绘是单人近全身照，竖版才装得下人；板要左右两段并排，
只能是横版。两个方向的转换由图生图完成，模型负责把竖版里的人物重新排进各格，这是
刻意跨向，不是失误。

### 与节点上「多角度」按钮的区别

图像节点顶部同时有两个按钮，做的事**不一样**，不要混用：

- **多角度**：绕相机环绕，出**一张新视角的单图**。参数是方位角/俯仰角/距离，用来「再拍一张
  从另一个方向看的图」。
- **制作资产**：出**一张板**，板内视图数量与排布由版式写死（左段三格 + 右段 1/2/3 格）。
  没有可调机位——用户选版式与输出设置。

要补一个侧面特写用「多角度」；要一次性拿到整块多角度资产板用「制作资产」。

**「制作资产」不开启「重写提示词」**：它下发的正文是逐字写死的版式结构（段宽、`- Panel LX:`
条目、`Global Requirements`），交给工作流重写器会被改乱、版式直接废掉。所以发出去的子节点
`rewritePrompt` 被钉成 `false`——面板里那个开关默认关，也不要手动打开。
（多角度/局部重绘/打光相反：它们下发的是含 `{{ref N}}` 的短指令，默认开重写、交由重写器扩写。）

### 版式：右段放几个头

面板里有一项**版式**，本质是选**右段放几个头**。三张空白灰模版式图可选，选哪个就把哪张
作为**第二参考图**（提示词里的 `<image2>`，节点会自动追加一条映射说明它是第几张图）接进去，
同时提示词里的右段段宽、`- Layout:` 行与 `- Panel RX:` 条目也按同一版式写死——
**图与文同时说同一件事**，是双保险引导。

| 选项 | 右段内容 | 画幅 | 顺带效果 |
| --- | --- | --- | --- |
| 单头 | 一格：正面脸 + 颈（大特写） | **16:9** | 脸的五官能画得最细，脸是主要识别点时用 |
| 双头 | 两格：正面脸 + 严格 90° 左侧脸 | **4:3** | 兼顾正脸细节与侧脸轮廓 |
| **三头**（默认） | 三格：正面 + 45° 右三分之四 + 严格 90° 左侧 | **4:3** | 角度信息最全，资产板最完整 |

**画幅跟着版式走，不用手选**：右段格数越多、整板越方——单头一格是竖长大脸，给 16:9；
双头与三头是两三个横栏，给 4:3。这个比例就是三张灰模原图的比例（单头原图 1376×768、
双头与三头原图 1200×896），出图画布与灰模对齐，模型照图排布时不会被拉伸。

**三张图只有右段不同，左段完全一致**（三竖栏无头躯干 + 背面全身）。三张都是**空白灰模**——
没有服装、没有个人特征，所以**不会污染角色身份**：它们讲的是「各格怎么排、右段放几个头」，
不是「这个人长什么样」。提示词里已明确要求身份、发型、服装一律取自第一张参考图（立绘），
灰模的表面、道具与光照都不得抄进结果。

面板的版式缩略图会跟着所选项把右段画成对应的格数、整体按该版式的真实画幅给形状，
点生成前就能看出差别。

技能自带这三张图（`assets/references/multiview-sheet-one-head.jpg`、
`multiview-sheet-two-heads.jpg`、`multiview-sheet-three-heads.jpg`），节点侧已内联，
**不需要创作者另外准备**。


## 二、版式

**横屏。画幅按版式给（单头 16:9，双头与三头 4:3）。** 画面切成左右两段，两段之间有一条
干净的空白分隔，不画分隔线、不加版式边框。

**两段的宽度按版式分**：单头 **2/3 + 1/3**；双头与三头 **3/4 + 1/4**。左段永远放三格，
但右段每格的宽度随格数增长——单头只有一格大脸，若还只给 1/4，那格会被压得比左段三格里的
任何一格都窄，脸就画不细了，所以单头把右段放大到 1/3。

### 左段（单头约占 2/3、双头与三头约占 3/4 画幅）：三个等宽竖栏

**横排从左到右**（`Panel L1` / `L2` / `L3`）：

1. **Panel L1 — 正面无头躯干**：从锁骨上方利落裁断，向下到鞋底；完全没有头、下巴、颈，
   裁剪处只留完整领口与纯背景；
2. **Panel L2 — 左侧 90° 无头躯干**：同样从锁骨上方裁断到鞋底，同样的「完全没有头、下巴、颈」；
3. **Panel L3 — 背面完整全身**：从完整头顶与头发，一直向下到鞋底。

三个竖栏等高、等宽，**站在同一条地平线上、人物高度一致**。

### 右段（单头约占 1/3、双头与三头约占 1/4 画幅）：等高横栏，格数看版式

**格数由面板的「版式」决定**，三种（`Panel R1` / `R2` / `R3`）：

- **单头**：一格——**Panel R1**：正面脸 + 颈；
- **双头**：两格——**Panel R1**：正面脸 + 颈 / **Panel R2**：严格 90° 左侧脸 + 颈；
- **三头**（默认）：三格——**Panel R1**：正面脸 + 颈 / **Panel R2**：45° 右三分之四脸 + 颈 /
  **Panel R3**：严格 90° 左侧脸 + 颈。

横栏**从上到下纵向堆叠**，等宽、等高，头部的尺度一致，都露出颈根。
「严格 90° 左侧」指真正的正交侧向，不是三分之四角度——提示词里对这两格都追加
`a true orthogonal side view, not a three-quarter angle`。

### 两段的对应关系

左栏与右栏描述**同一个角色的同一时刻**。左栏没有头，不代表另一个没有头的人；
右侧那几格就是左栏被裁掉的那个头，角度与左栏的视图对应。写提示词时要把这层对应
说清楚，否则模型容易把各格画成几个人。

## 三、左栏为什么刻意无头

角色板的通用要求是**保留头顶、身体、四肢及脚部，不裁切**（见 [人物与造型](character-and-look.md) 的
构图方法）。本版式左栏的两个躯干视图是这条规则的**明确例外**，理由如下：

- 左栏要回答的是**服装剪裁与躯干轮廓**：领口开合、肩线、袖长、腰线位置、衣摆长度、
  靴筒高度。这些事实在全身竖栏里会被压缩到很小的像素范围，看不清裁片结构。
- 左栏刻意去掉头，是为了让躯干在竖栏里占满整个高度，把裁片结构放大到可比较的尺度。
- **头部信息不丢**：它由右栏三格完整承接——正面、45° 右、严格 90° 左。

因此判定方式是：**这张板的两段合起来看，头部与身体信息都不缺，就不构成裁切缺陷。**
只有一种情况算缺陷：右栏没画全头部（缺发际、缺发顶、缺下颌），却声称头部信息已由右栏给出。

写提示词时必须写死两件事：

- 左栏裁剪线的确切位置（「just above the collarbone」，锁骨上方），以及**不得出现**
  头、下巴、颈三样东西中的任何一样；
- 裁剪处**留下什么**——只有完整的领口开口和背景，不能留下半截脖子或一团模糊的过渡。

## 四、左侧 90° 的方向约定

本版式统一用**左侧 90°**（`exact 90° left profile`）作为唯一的严格侧向，左栏和右栏都取左侧。

- 左栏第 2 格（`Panel L2`）：`exact 90° left-side headless torso`；
- 右栏最后一格（双头的 `Panel R2`、三头的 `Panel R3`）：`exact 90° left profile face and neck close-up`。

两格的朝向必须一致——同一个角色从同一侧看过去。若左栏用了左、右栏用了右，两段就不
对应同一个观察事实，下游按侧脸做关键帧时会拿到一个不存在的朝向。

**为什么统一取左而不取右**：这只是本项目的产线约定，为的是让所有角色板的侧向可预期。
角色真正的识别标记若只在右脸（右颊旧疤、右眉缺口等），不要改掉版式侧向，而是在
右栏第 2 格的 45° 右三分之四视图里看清它——45° 右能同时给出右侧面特征与正面比例。
只有当创作者明确要求「本角色的识别标记只能从右侧看清」时，才把整张板的侧向改为右侧，
并在条目里写明改了哪一侧、为什么。

## 五、各视图的共同要求

以下六条对板上每一个视图都成立，缺一条就会退化成几张互不相干的图：

1. **同一身份**：脸型、发型、五官、体态、肤色一致。左栏看不到脸，但发型剪影、
   颈肩比例、体态重心必须与右栏对得上。
2. **同一套造型**：服装款式、层次、配色、材质、配饰位置完全一致，各视图之间
   不换衣、不错位。袖长、腰带、扣件在正侧背三个角度的连续性尤其要写清。
3. **角度准确**：正面就是正面，90° 就是严格正交的侧面，45° 就是标准三分之四。
   不要出现「大概转了一点」的模糊角度。
4. **比例一致**：左栏三格的躯干高度、肩宽、靴筒高度一致；右栏三格的头部大小一致。
5. **干净白底**：统一纯白背景，不出现环境、道具、地面阴影纹理。
6. **无文字**：画面内不出现视图标签、引线箭头、尺寸标注、图注、水印、logo。

另外：**自然静态姿态、中性表情**。右栏三格的眼睑开合与眼神方向可以一致化，便于
比较脸型；不要在其中一格做表情表演。

## 六、提示词写法

正文用英文。骨架**按段落加粗标题分块**，段内先一行 `- Layout:` 再逐格 `- Panel LX:`。
按以下顺序写，段落标题独立成行、不要打散重排：

```text
1. 首段（不加标题）：用途句 + 画幅与参考图分工 + 身份一致性 + 姿态。
   Generate a professional multi-view character asset reference sheet on a <比例> canvas.
   身份全取自 <image1>；<image2> 只当版式与取景参考，丢弃灰模表面/道具/打光。
   随后写身份一致性（脸/发型/体型/服装/配饰/颜色/材质）与自然站姿。
2. **Left Section — approx. <左段宽> of the frame width**
   - Layout: three equally sized vertical full-body panels, arranged side by side from
     left to right, on the same ground line and at the same figure height.
   - Panel L1: 正面无头躯干（锁骨上方裁断到鞋底；完全没有头、下巴、颈；裁剪处只留领口与背景）。
   - Panel L2: 严格 90° 左侧无头躯干（同样裁法）。
   - Panel L3: 完整背面全身（从头顶头发到鞋底）。
3. **Right Section — approx. <右段宽> of the frame width**
   - Layout: <右段排布句，按版式 1/2/3 格，纵向堆叠、头部等大、露颈根>。
   - Panel R1: 正面脸 + 颈。
   - Panel R2: 45° 右三分之四脸 + 颈。（仅三头）
   - Panel R3: 严格 90° 左侧脸 + 颈——真正的正交侧视。（双头时为 R2）
4. **Global Requirements**（四条）
   - 左段缺的那个头，就是右段对应角度的同一个头。
   - 纯白背景、均匀柔光、细而一致的分隔缝。
   - 角度准确、比例一致、五官与身体解剖正确不变形、各格装束细节完全一致。
   - 无文字，无水印。
```

正文里不写「三视图」「参考板」这类会与既有四视图横排混淆的词，改用**多角度分段板**。
**段宽**与**画幅**都按版式取，不能写死（见下方差异一览）。

### 正文里的画幅短语与 `qwen-image-prompt` 的关系

`qwen-image-prompt` 规定「不把比例写进提示词正文，比例走节点配置」，那是**文生图**（纯文字
出图，无参考图）的写法。本版式是**跟随参考图**的资产板（正文首句就是
`Generate a professional multi-view character asset reference sheet on a <比例> canvas`），
画幅比例属于画面版式的组成部分，写进正文不违反那条规则——两者管的通道不同。

两处都要写、且必须一致：

- 正文首句写 `on a 16:9 landscape canvas` 或 `on a 4:3 landscape canvas`（按版式，让模型知道两段怎么切）；
- 条目「画幅」字段写同一个比例（让 `board_plan.py` 把节点 `ratio` 定成它而不是自适应）。

**两处不一致是缺陷**：正文说 4:3、字段写 16:9，会让节点参数与画面描述打架。

⚠️ **不能走「自适应」**：自适应 = 出图比例跟随参考图，而参考图是 **9:16 竖版立绘**，
走自适应会把板拉成竖版、版式全废。用「制作资产」按钮时这一点已由面板处理（比例随版式
自动锁定，且下拉里不出现「自适应」档）。

### 与既有四视图横排的关系

本版式是**新建角色的默认**。「头部特写 + 正面全身 + 右侧 90° 全身 + 背面全身」的四视图横排
退为**创作者明确指定时**才使用的备选版式（例如快速识别卡、只需要少量视图的次要角色）。
两套版式不要混在一张板里。

### 条目骨架

```markdown
## IMG-<NAME>-SHEET · <角色名>角色板

- 用途：锁定<角色名>的身份、<造型要点>与体态，供<使用范围>做 identity reference。
- 参考：本板由前一步的 9:16 竖版单人立绘经「制作资产」图生图而来，参考图即那张立绘；
  版式灰模用面板自带的对应那张（作为第二参考图，见[版式：右段放几个头](#版式右段放几个头)）。
- 版式：三头（右段三格）
- 画幅：4:3

### 可复制提示词

以下按**三头**版式（默认，画幅 4:3）写；改版式时要同时替换**画幅短语**、**左右两段的段宽**、
**右段 `- Layout:` 行**、**右段的 `- Panel RX:` 条目**。
两张参考图有明确分工：`<image1>` 是连线进来的立绘（身份来源），`<image2>` 是所选版式的引导灰模
（只给版式与取景）——这个 `<imageN>` 记号与供应商的图片顺序一一对应，节点会自动追加一条
`Image reference mapping` 说明它们各自是第几张图。
注意「制作资产」按钮下发的正文**不含**身份锚点与造型 delta（那两项由本条目在选题/复核阶段看）。

> Generate a professional multi-view character asset reference sheet on a 4:3 landscape
> canvas. Take the character exclusively from <image1>, and use <image2> only as a layout
> and framing guide for panel sizes, head scale, and crop positions, while discarding its
> bald, featureless mannequin surface, props, and lighting. All identity traits of the
> character—including face, hairstyle, body type, clothing, accessories, colors, and
> materials—must remain fully consistent across every panel and be rendered exactly as in
> <image1>. Pose the character in a relaxed, upright standing stance with arms hanging
> naturally at the sides.
> **Left Section — approx. 3/4 of the frame width**
> - Layout: three equally sized vertical full-body panels, arranged side by side from left
>   to right, on the same ground line and at the same figure height.
> - Panel L1: front-view headless torso, cleanly cropped just above the collarbone down to
>   the soles; no head, chin, or neck at all; at the crop only the intact collar opening
>   and the plain background remain.
> - Panel L2: exact 90° left-side headless torso with the same collarbone-to-sole crop; no
>   head, chin, or neck at all; at the crop only the intact collar opening and the plain
>   background remain.
> - Panel L3: exact rear full-body view, shown from the complete head and hair down to the
>   soles.
> **Right Section — approx. 1/4 of the frame width**
> - Layout: three equally sized close-up panels, stacked vertically from top to bottom, all
>   at the same head scale, all showing the neck down to its base.
> - Panel R1: front-facing face and neck close-up.
> - Panel R2: 45° right three-quarter face and neck close-up.
> - Panel R3: exact 90° left profile face and neck close-up — a true orthogonal side view,
>   not a three-quarter angle.
> **Global Requirements**
> - The head absent from the Left Section is the identical head shown in the Right Section
>   at the corresponding angle.
> - Use a clean white background, even soft studio lighting, and thin uniform gutters.
> - Accurate angles, consistent proportions, anatomically correct and undistorted faces
>   and bodies, and identical outfit details across all panels.
> - No text, no watermark.
> <这里插入本角色的身份锚点与造型 delta，逐项点名袖长、腰带、扣件、配饰位置。>

**三个版式的差异一览**（改版式时照此五处同改）：

| 版式 | 画幅短语 | 左段段宽 | 右段段宽 | 右段 `- Layout:` 行 | 右段 `- Panel RX:` 条目 |
| --- | --- | --- | --- | --- | --- |
| 单头 | `16:9 landscape` | `2/3` | `1/3` | `exactly one close-up panel, showing the face and neck down to its base, at the same head scale as the other views.` | 只有 `Panel R1: front-facing face and neck close-up.` |
| 双头 | `4:3 landscape` | `3/4` | `1/4` | `two equally sized close-up panels, stacked vertically from top to bottom, all at the same head scale, all showing the neck down to its base.` | `R1` 正面 + `R2` 严格 90° 左侧 |
| 三头 | `4:3 landscape` | `3/4` | `1/4` | `three equally sized close-up panels, stacked vertically from top to bottom, all at the same head scale, all showing the neck down to its base.` | `R1` 正面 + `R2` 45° 右三分之四 + `R3` 严格 90° 左侧 |

**左段三格三张版式完全一致**，只有段宽随版式变（单头 2/3，双头与三头 3/4）。
`- Layout:` 行与 `- Panel L1/L2/L3` 条目是共用的固定文案，不随版式改。

**版式骨架的固定顺序**（`buildMultiviewAssetPrompt()` 逐段生成，不要打散重排）：
首段（画幅 + 两图分工 + 身份一致性 + 姿态）→ `**Left Section…**` 块（Layout 行 + L1–L3）→
`**Right Section…**` 块（Layout 行 + R1–R3）→ `**Global Requirements**` 四条。
**没有**独立的「格数约束句」了——右段格数已由 `- Layout:` 行与 Panel 条目写死。

节点上的「制作资产」按钮用的就是与所选版式配套的固定提示词（不再逐项目手写）；条目里保留
可复制正文，是为了让选题与复核时能看见这版式到底规定了什么。

拆两段（`-TORSOS` / `-FACE`）时，两份条目共用上面同一段身份锚点与造型 delta，只替换
「版式块」：`-TORSOS` 只保留 `**Left Section…**` 那一段，`-FACE` 只保留 `**Right Section…**`
那一段；两份都要带上位置句（左段写 `approx. 2/3 of the frame`（单头）或 `3/4`（双头、三头），
右段写 `approx. 1/3`（单头）或 `1/4`），并在「参考」字段里互相点名，让下游知道两段必须合并使用。

## 七、画幅与落法

**画幅随版式**：单头 **16:9**、双头与三头 **4:3**，都是横屏。落在画布上时：

- 条目自身在「画幅」字段写实际比例（`board_plan.py` 的 `detect_ratio` 会用显式字段覆盖）；
- 不写该字段时，`IMG-*` 资产板走 `自适应`——由版式决定出图比例，不受成片画幅约束。

**⚠️ 但「制作资产」这类两阶段板绝不能留空走自适应**：它的参考图是 9:16 竖版立绘，
自适应会让出图跟着立绘变竖版、版式全废。用按钮时面板已自动锁定比例，走文本流程则必须
在「画幅」字段显式写出比例。

**各格怎么落**：一块板的所有视图，靠的是**提示词描述版式 + 灰模引导图**，不是靠单节点一次出多张。
平台的图片生成请求**每次只出一张图**（没有「张数」参数），所有格都是这张图内部的画面分区。
所以：

- **首选**：用节点上的「制作资产」按钮，一次点出整块板（左段三格 + 右段按版式 1/2/3 格），
  比例由面板随版式锁定，不用手选。生成后的新节点底栏会在连线立绘旁边**再显示一张「引导」
  卡片**（虚线边框 + 版式名），那就是本次下发的版式灰模——它不走连线，没有这张卡片的话
  画布上看不出它存在；
- **拆两段**（`-TORSOS` / `-FACE`）：需要两段分开复用、或模型老是把某一段画崩时，
  拆成两个 `IMG-*` 条目各出一个节点，两个节点各管一半；
- **减少视图**：只在角色确实不需要这么多角度时使用（例如只在远景出现一次的角色），
  按需保留更少的格，并相应改写版式句。

选哪种由创作者的复用需求决定，不是用量上限倒推。

## 八、失败征兆

- 各格被画成**几个不同的人**——身份没锁住，多半是没写「同一角色同一时刻」这层对应关系；
- 左栏真的**长出了头**——「无头」这个否定约束太弱，要写成「完全没有头、下巴或颈，
  裁剪处只留完整领口与背景」；
- 左栏裁剪处**留下半截脖子**或模糊过渡——没说清裁剪处只剩领口和背景；
- 左栏第 2 格（`Panel L2`）与右栏侧向格（`Panel R2` 或 `R3`）**侧向不一致**——一个左一个右，两段对不上；
- 左右栏**服装错位**——袖长、腰带、扣件在正侧背之间漂移，要在一致性句里逐项点名；
- 右栏三格**头部大小不一**或**缺发顶/发际**——需要写明三格等大、露出颈根；
- 画面上出现了**视图标签、箭头、尺寸标注**——禁止项写漏。
