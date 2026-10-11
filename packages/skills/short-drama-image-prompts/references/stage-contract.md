# 图片提示词阶段契约

本阶段只拥有 `剧集/<EP>/图片提示词.md` 中的 `IMG-...` 项：用途、参考边界和可复制正文。它继承
视觉设定与项目视觉方向，不改写资产身份、地理、剧情状态或镜头边界。

每项参考都写清可以控制什么、不能控制什么；没有获授权的像素观察时保持未知。局部修改直接写目标、
变化、保持项和连续性影响，不建立 prompt spec、QA 或接受记录。

## 本阶段规则

### `IMG`

| ID | Class | Knowledge |
|---|---|---|
| IMG-01 | structural_invariant | Each `IMG-...` item names the exact visual-setting item and current variant it depicts. |
| IMG-02 | craft_default | Put distinguishing identity, geometry, scale, or state before generic quality language. |
| IMG-03 | reviewed_invariant | Character sheets preserve identity while depicting one coherent Look. |
| IMG-04 | reviewed_invariant | Location plates preserve geography, orientation, anchors, material, and light, normally without cast. |
| IMG-05 | reviewed_invariant | Prop plates preserve scale, shape, material, wear, function, and text policy. |
| IMG-06 | structural_invariant | Edit prompts declare exact target, changes, preserve set, and expected continuity impact. |
| IMG-07 | structural_invariant | Readable text cannot coexist with a global no-text constraint. |
| IMG-08 | reviewed_invariant | A claim about reference pixels requires a creator/reference-owner description or authorized input-reference observation bound to the inspected bytes; otherwise admission stays unresolved, and a negative prompt cannot stand in for evidence. |
| IMG-09 | reviewed_invariant | Each reference states its purpose, what may be copied, and what must not be copied; a composition-, scale-, or effect-only reference cannot redefine identity, content, text, or story state. |
| IMG-10 | reviewed_invariant | Views of one Location in the same time/weather state share key-light source, colour-temperature relation, and contrast direction; any difference cites a recorded cause and its delta. |
| IMG-11 | reviewed_invariant | A lookdev frame binds accepted visual direction and production profile across a declared character-expression, core-location, or high-pressure test axis; a high-pressure frame also binds exact screenplay blocks for story state and information permission, while style references may control only declared surface treatment and never identity, fixed geography, story state, cast count, or prop text. |
| IMG-12 | reviewed_invariant | Each real input reference has a stable `REF-...` slot binding explicit order, a visible project-relative path or other unambiguous artifact locator, a Chinese label, and may-control/must-not-control scope. Reordering preserves slot identity; replacing media explicitly revises that slot's locator. `IMG-...` remains reserved for image-prompt headings. |
| IMG-13 | structural_invariant | An `IMG-...` item named by a continuity lock in `视觉设定.md` carries that lock's surface verbatim in its copyable prompt. |
| IMG-14 | structural_invariant | Every `REF-...` slot an image-prompt item declares carries one 用途 from the closed set 身份/造型状态/地理/构图/尺度/效果/起始帧/结束帧/风格, the same vocabulary the storyboard uses, so one picture answers one question. An asset board normally uses the first six; 起始帧 and 结束帧 belong to a shot. |

### `QWN`

Qwen 文生图正文方言，只用于**首次从零生成、无参考图**的单张资产图。
正文见 [Qwen 文生图方言](qwen-dialect.md)；跟随参考图的资产板与参考图编辑不适用本表。

| ID | Class | Knowledge |
|---|---|---|
| QWN-01 | craft_default | 本文只改变正文的组织方式，不改变要固定的内容；同时适用时先按 A 套配方锁定身份/状态/空间/禁止项，再按本文顺序写成一段英文描述；锁面原样出现时照旧逐字。 |
| QWN-02 | structural_invariant | 正文是一段英文单行连续段落，不含 JSON/键名/标签/标题/代码块/前后语；默认只有一段；段首即第一个字符；不把比例、分辨率、像素数、时间戳写进正文。成品正文入 `setPrompt` 后应把 `rewritePrompt` 关掉（流程批量导出的节点默认已是 `false`）。 |
| QWN-03 | structural_invariant | 比例由节点配置决定，完全不经过文字；只能取节点 `getConfig` 返回的 8 个档位之一，纯文生图不用「自适应」。 |
| QWN-04 | craft_default | 按八步书写：读 brief 分两类 → 定画幅 → 写开篇句 → 先清点位置与文字 → 走一遍画面 → 逐段设定文字 → 给光单独一句 → 以整幅画面收束；每步锁定一个决定，后面的步不回头改前面的。 |
| QWN-05 | craft_default | 贯穿要求：约四五百词；只观察不指令；不确定处留余地；颜色必带修饰词；给材质不只给名词；逐个列举不概括；人物年龄写生命阶段；物件按类别不按品牌；物理自洽。 |
| QWN-06 | structural_invariant | 描述永远用英文，无论请求用什么语言到来；唯一例外是画面内显示的文字，保持自身语言。 |
| QWN-07 | structural_invariant | 交稿前逐项核对自检清单（位置短语 8–14 个、约三分之一句以位置短语开头、结尾只有一句收束、无质量词、年龄不写岁数等）。 |

规则分级由高到低：`structural_invariant`（结构缺陷，阻断）、
`reviewed_invariant`（需证据判断）、`craft_default`（常用做法，可覆盖）、
`taste_option`（创作者选择，不作缺陷）。创作者已接受的事实优先于本表。
