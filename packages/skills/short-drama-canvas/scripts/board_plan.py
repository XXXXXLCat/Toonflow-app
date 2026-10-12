#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把短剧项目的创作文档解析成画布施工计划。

读四份 creator-first 文档，输出结构化节点清单与连线清单：
  - 图片提示词.md 的 IMG-*  -> 图片节点（资产图）
  - 分镜.md       的 SHOT-* -> 图片节点（冻结关键帧）
  - 视频提示词.md 的 MOTION-* -> 视频节点
  - 视频提示词.md 的时间线音乐章节 MUS-* -> 音乐节点

连线依据取自文档已有的事实，不做推断：
  - SHOT 的「图片提示词项」  -> IMG 节点连到该 SHOT 节点
  - MOTION 的「分镜」        -> SHOT 节点连到该 MOTION 节点
  - 参考槽位里的 PLAN-*      -> 定位符是条目 ID，那个条目连到目标节点

「输入参考图」（IMG 条目里叫「参考」，同一套语法）只承载**图片**素材，一条声明有三种来源：
  - `REF-`：定位符是项目内的真实文件路径。画布上没有对应条目，由 board_apply 另建文件节点再连；
  - `PLAN-`：定位符是 `IMG-`/`SHOT-` 条目 ID，直接连到那个条目；
  - 视频片段不作参考输入，本计划不解析它（`REF-VIDEO-` 槽位会被忽略并计入报告）。
音色不在这个字段里——它登记在 `MOTION-*` 的「参考音频」行上（VID-27），按行内写的
「角色」接到该人物的对白节点，不接 MOTION 的音频输入。

时间线音乐章节（`MUS-*`）属时间线层（VID-14）：乐段写在《视频提示词.md》的独立章节里，
它是**产出物**，供剪辑铺轨，**不与任何节点连线**——单镜产物不自带配乐音轨，音乐节点也不接受
任何参考输入。这一层只把它读成节点，乐段怎么切由创作者在章节里定（方法见
references/segment-design.md），本脚本不替它划分。

本脚本只读文档、只输出计划，不写任何文件，也不调用画布或供应商。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

EPISODE_DIR = re.compile(r"^EP\d+$", re.IGNORECASE)
ENTRY_HEADING = re.compile(r"^##\s+(?P<id>(?:IMG|SHOT|MOTION)-[A-Za-z0-9-]+)\s*(?:·\s*(?P<title>.*))?$")
SUB_HEADING = re.compile(r"^###\s+(?P<title>.+?)\s*$")
FIELD = re.compile(r"^-\s*(?P<key>[^：:]+)[：:]\s*(?P<value>.*)$")
DURATION = re.compile(r"(\d+(?:\.\d+)?)\s*s\b")
RATIO = re.compile(r"(?<!\d)(\d{1,2}:\d{1,2})(?!\d)")
# 槽位名里既有 ASCII 也有汉字：音色槽按所属人物命名，中文项目没有 ASCII 拼写可退。
# locator 与《中文名称》都可选——写得残缺的声明也要作为「值得报告的槽位」出现在计划里，
# 而不是消失。定位符与名称分开捕获，是因为它们是两件事：定位符写「文件在哪」或「哪一条
# 条目」，名称写「这张图叫什么」。认节点只看名字，见 resolve_reference_target()。
REF_SLOT = re.compile(
    r"(?P<kind>REF|PLAN)-(?P<slot>[A-Z0-9\u3400-\u9fff][A-Z0-9\u3400-\u9fff-]*)"
    r"\s*（顺序：(?P<order>\d+)）"
    r"(?:\s*·\s*(?P<locator>[^；《\n]*)(?:《(?P<name>[^》\n]*)》)?)?"
)
IMG_ITEM = re.compile(r"(?P<id>IMG-[A-Za-z0-9-]+)")
# 条目 ID 的通用形态。参考槽位的名字里会带上它指的那个条目（上游样例
# `《SHOT-EP001-002 起始帧》`），路径的文件主名也会（`制作成果/images/SHOT-EP001-002.png`）。
ENTRY_ID = re.compile(r"(?:IMG|SHOT|MOTION)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*")
# 一个槽位指向哪类文件。后缀判定与校验器同一套规则，计划和校验器不会对不上。
IMAGE_SUFFIXES = ("png", "jpg", "jpeg", "webp")
VIDEO_SUFFIXES = ("mp4", "mov", "webm", "mkv", "m4v", "avi")
AUDIO_SUFFIXES = ("wav", "mp3", "m4a", "aac", "flac")
MEDIA_ORDER = {"image": 0, "audio": 1}
# 目标模型对一次生成能挂多少素材有硬上限（H3：最多 9 张 `reference_image`、3 段
# `reference_video`、3 段 `reference_audio`；见 video-prompts 的 minimax-h3.md）。超了要回
# 分镜阶段按重要性取舍，所以在计划里就报出来，别等提交时才发现。画布不去替创作者砍参考。
REFERENCE_LIMITS = {"image": 9, "video": 3, "audio": 3}

PROMPT_HEADINGS = ("可复制提示词", "冻结关键帧提示词", "收尾关键帧提示词")
NONE_PREFIXES = ("无", "待补", "-")

# 对白的唯一来源是上游 $short-drama-write 的录音表。剧本是台词权威，录音表是它的投影——
# 本技能不自己从剧本切对白：上游为这件事连修了两版（按段落读、注释读到 -->、场景外不算、
# 缺分隔不算，且要与 screenplay_index.py 逐条一致），自己写正则必然与之错开。
# 录音表没有生成器（上游只给了模板与 voice_sheet_check.py 校验器），所以它可能不存在；
# 不存在时本技能只报告缺失，把它交回 $short-drama-write，不猜。
RECORD_SHEET = "voice-record-sheet.jsonl"
# MOTION 的「参考音频」行里，角色写在括号的最后一段：`（用途：音色；角色：<人物名>；…）`。
CHARACTER_IN_AUDIO = re.compile(r"角色：\s*(?P<name>[^；\n）)]+)")
# 参考槽位后面跟着的括号是它的语义声明：`（用途：…；控制：…；不得控制：…）`，音色槽另带
# `角色：…`。这三段说的是「这张图允许决定什么、不允许决定什么」，是参考图唯一不越权的依据。
# 生产端（`short-drama-produce` 的 provider_adapters）把它们编译成附在正文后的「参考约束」块；
# 画布走同一条编译（见 board_apply.reference_contract），两边执行端收到的保留要求一致。
SLOT_PAREN = re.compile(r"（(?P<body>[^）\n]*)）")
SLOT_CONTRACT_MARK = "用途"

# 时间线音乐章节写在《视频提示词.md》里（VID-14），乐段项是章节之下的 `### MUS-<EP>-<nn>`（H3）。
# 它属时间线层，与逐镜的 MOTION 项不同层：音乐节点是产出物，不与任何节点连线。
MUSIC_HEADING = re.compile(r"^#{2,3}\s+(?P<id>MUS-[A-Za-z0-9-]+)\s*(?:·\s*(?P<title>.*))?$")
# 任何别的标题都判定一项到此结束，免得把紧随的 MOTION 项字段吃进乐段。
ANY_HEADING = re.compile(r"^#{2,3}\s+\S")
MUSIC_FENCE = re.compile(r"^```(?:text)?\s*$")
# 乐段的「时长」可能写 `48s` 也可能写 `48 秒`：只取数字部分，两种都认。
MUSIC_DURATION = re.compile(r"(\d+(?:\.\d+)?)")
# 同一含义的字段可能有两种写法，都认；主名是时间线音乐章节的措辞。
MUSIC_FIELD_ALIASES = {
    "style": ("风格描述", "风格"),
    "duration": ("时长", "长度"),
    "scope": ("使用区间", "区间"),
    "lyrics": ("歌词", "歌词文本"),
}
# 乐段的歌词也只有一个来源：创作者提供或明确接受的文本（上游 $short-drama-video-prompts
# 原文）。主题曲与纯配乐是两种决定，画布必须分清：
#   - `- 歌词：无（纯旋律）`（或 `无`、`纯配乐`…）：纯配乐，节点 lyrics 留空；
#   - `- 歌词：<一句>`：行内写下的歌词，原样带进节点；
#   - `- 歌词：见下` + 紧随其后的围栏块：多行歌词（围栏块只有两个时，紧跟歌词行的那一个是
#     歌词，另一个是风格描述）；
#   - `- 歌词：待补…`：还没定稿，报进 stats，不替它编。
# 无论哪种，画布都不代写歌词，也不放开供应商代写。
LYRICS_BELOW = re.compile(r"^(?:见下|如下|见下方|见代码块|见块)\s*$")
LYRICS_NONE = re.compile(
    r"^(?:无|纯旋律|纯配乐|无歌词|不适用|不需要|—|-|N/?A)(?:\s*（[^）]*）)?$",
    re.IGNORECASE,
)
LYRICS_PENDING = re.compile(r"^(?:待补|待定|TBD)", re.IGNORECASE)
# 上游章节的字段表里没有「时长」（它列的是使用区间、剧情功能、进入/退出、动态曲线、禁用项），
# 所以乐段的时长上限有两个来源，都不靠猜：
#   1. 显式写 `- 时长：`（画布侧约定，见 references/segment-design.md）；
#   2. 从上游字段「使用区间」机械换算——写时间码（`00:00–00:12`）取秒数，写条目区间
#      （`MOTION-… ~ MOTION-…`）取覆盖镜头的时长之和。
# 换成秒后向上取到节点步长 5 秒（segment-design.md「时长宁长勿短」）。都换不出来就照实报告。
MUSIC_TIME_RANGE = re.compile(r"(?<!\d)(\d+):([0-5]\d)(?::([0-5]\d))?(?!\d)")
MUSIC_SHOT_RANGE = re.compile(r"MOTION-[A-Za-z0-9-]+")
MUSIC_STEP = 5

# 「输入参考图」/「参考」这一行有四种准备结果，语义不同，不能混（判定与上游
# scripts/creator_markdown_check.py 同一套，画布与之不会对不上）：
#   - `无（创作者已明确选择文生视频）`：创作者明确不用图，**已就绪**；
#   - `无（待补参考图：…）`、绑了 REF-/PLAN- 后仍带 `；待补参考图：…`、以及光秃秃的「无」：
#     **未准备好**，都不是文生视频授权（《视频提示词.md》SKILL.md 原文）；
#   - IMG 条目「参考」写 `无` / `无外部参考`：这张资产图本就不需要外部参考，**已就绪**。
EXPLICIT_TEXT_TO_VIDEO = "无（创作者已明确选择文生视频）"
PENDING_HEAD = "无（待补参考图："
PENDING_SUFFIX = re.compile(r"；待补参考图：[^；。\n]+。?$")
PENDING_GAP = re.compile(r"(?:IMG|SHOT)-[A-Za-z0-9-]+")
SLOT_TOKEN = re.compile(r"(?:REF|PLAN)-[A-Za-z0-9]", re.IGNORECASE)
NO_EXTERNAL_REFERENCE = re.compile(r"无(?:外部参考)?(?:；[^\n]*)?。?")


def read_text(path: Path) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    raise SystemExit(f"无法解码文件：{path}")


def strip_quote(body: str) -> str:
    lines = [re.sub(r"^>\s?", "", line) for line in body.splitlines()]
    return "\n".join(lines).strip()


def parse_entries(markdown: str) -> List[Dict[str, Any]]:
    """按 H2 切条目，收集字段区与 H3 正文块。"""
    entries: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    block_title: Optional[str] = None
    block_lines: List[str] = []

    def flush_block() -> None:
        nonlocal block_title, block_lines
        if current is not None and block_title:
            current["blocks"][block_title] = strip_quote("\n".join(block_lines))
        block_title = None
        block_lines = []

    for line in markdown.splitlines():
        heading = ENTRY_HEADING.match(line)
        if heading:
            flush_block()
            if current is not None:
                entries.append(current)
            current = {
                "id": heading.group("id"),
                "title": (heading.group("title") or "").strip(),
                "fields": {},
                "blocks": {},
            }
            continue
        if current is None:
            continue
        sub = SUB_HEADING.match(line)
        if sub:
            flush_block()
            block_title = sub.group("title")
            continue
        if block_title is not None:
            block_lines.append(line)
            continue
        field = FIELD.match(line)
        if field:
            key = field.group("key").strip()
            value = field.group("value").strip()
            if key in current["fields"]:
                current["fields"][key] += "；" + value
            else:
                current["fields"][key] = value
    flush_block()
    if current is not None:
        entries.append(current)
    return entries


def pick_prompt(entry: Dict[str, Any]) -> str:
    for name in PROMPT_HEADINGS:
        value = entry["blocks"].get(name)
        if value:
            return value
    return ""


def is_absent(value: Optional[str]) -> bool:
    if not value:
        return True
    return value.lstrip().startswith(NONE_PREFIXES)


def plain_value(value: Optional[str]) -> str:
    return (value or "").strip().rstrip("。")


def has_pending_references(value: Optional[str]) -> bool:
    """这一行是否声明了「还有图没到」。

    两种写法：一张都没有时整行是 `无（待补参考图：……）`；只缺一部分时已有槽位后面追加
    `；待补参考图：……`。两者都表示视频提示词尚未就绪。
    """
    text = (value or "").strip()
    return plain_value(text).startswith(PENDING_HEAD) or bool(PENDING_SUFFIX.search(text))


def pending_items(value: Optional[str]) -> List[str]:
    """「待补参考图」缺口里点名的 `IMG-`/`SHOT-` 条目，就是这一镜还差的图。

    缺口也可能只写中文名（如「夜间走廊地理」），那种没有条目可查，只作为文本留在原行里。
    """
    text = value or ""
    matched = PENDING_SUFFIX.search(text)
    if matched:
        tail = matched.group(0)
    elif plain_value(text).startswith(PENDING_HEAD):
        tail = text
    else:
        return []
    return sorted(set(PENDING_GAP.findall(tail)))


def is_explicit_text_to_video(value: Optional[str]) -> bool:
    """只有整行就是这一句，才是「创作者明确选择文生视频」。

    光秃秃的「无」不算——它在《视频提示词.md》里表示未准备好（SKILL.md 原文）。
    """
    return plain_value(value) == EXPLICIT_TEXT_TO_VIDEO


def is_no_external_reference(value: Optional[str]) -> bool:
    """IMG 条目的「参考」写 `无` / `无外部参考`：这张资产图本就不需要外部参考。

    这是就绪状态，与分镜侧「无 = 未准备好」不是一回事。
    """
    text = (value or "").strip()
    return not SLOT_TOKEN.search(text) and bool(NO_EXTERNAL_REFERENCE.fullmatch(text))


def is_no_slot_none(value: Optional[str]) -> bool:
    """分镜/视频侧不带槽位的「无」（含 `无（…）`）：未准备好，不是文生视频授权。"""
    text = plain_value(value)
    return not SLOT_TOKEN.search(value or "") and bool(re.fullmatch(r"无(?:（.+）)?", text, re.DOTALL))


def classify_reference(field: str, pictures: set, *, asset: bool) -> Dict[str, Any]:
    """把「输入参考图」/「参考」这一行判成准备状态。

    返回四个值：状态名、这一行是否已就绪、是否带「待补」缺口、缺口里点名的条目。
    已就绪的判据是「有图且没有缺口」或「明确选择无参考」——前者看图在不在，后者才是授权。
    """
    pending = has_pending_references(field)
    if pictures:
        state = "已绑定真实图" if pictures == {"REF"} else (
            "挂图计划" if pictures == {"PLAN"} else "真实图与挂图计划混用")
    elif is_explicit_text_to_video(field):
        state = "创作者选择无参考"
    elif asset and is_no_external_reference(field):
        state = "创作者选择无参考"
    elif pending or is_absent(field) or is_no_slot_none(field):
        state = "待补参考图"
    else:
        state = "待解析"
    return {
        "state": state,
        "ready": state == "创作者选择无参考" or bool(pictures and not pending),
        "pending": pending,
        "pending_items": pending_items(field),
    }


def slot_media(kind: str, slot: str, locator: Optional[str]) -> str:
    """一个输入参考槽指向图片、视频还是音色。

    由 locator 后缀判定，它正是区分几种写法的依据：图片指 png/jpg/webp，视频指
    mp4/mov/…，音色指 wav/mp3/…。locator 写不出来时退回槽位名自带的
    `VIDEO-` / `VOICE-` 前缀。只有图片会进计划；视频与音色由调用方另行处置
    （视频不接、音色走「参考音频」行）。
    """
    tail = (locator or "").strip().lower()
    suffix = tail.rsplit(".", 1)[-1] if "." in tail else ""
    if suffix in VIDEO_SUFFIXES:
        return "video"
    if suffix in AUDIO_SUFFIXES:
        return "audio"
    if suffix in IMAGE_SUFFIXES:
        return "image"
    head = slot.split("-", 1)[0].upper() if "-" in slot else ""
    if kind == "REF" and head == "VIDEO":
        return "video"
    if kind == "REF" and head == "VOICE":
        return "audio"
    return "image"


def parse_slot_contract(segment: str) -> Dict[str, str]:
    """取一条参考槽位自带的语义声明（`（用途：…；控制：…；不得控制：…）`）。

    声明写在《中文名称》之后、与槽位同属一段文本；音色槽多一个 `角色：…`。找不到声明时
    返回空表，由调用方按「声明不全」如实报出——画布不替创作者编一个用途。
    """
    for matched in SLOT_PAREN.finditer(segment or ""):
        body = matched.group("body")
        if SLOT_CONTRACT_MARK not in body:
            continue
        fields: Dict[str, str] = {}
        for piece in body.split("；"):
            key, separator, value = piece.partition("：")
            if separator:
                fields[key.strip()] = value.strip()
        return fields
    return {}


def parse_reference_slots(field: str) -> List[Dict[str, Any]]:
    """把一行参考声明解析成逐条槽位，每条带上自己的语义声明。

    每条的右边界是下一条的起点，所以 `（用途：…）` 这类跟在《名称》之后的括号只会归到它
    自己那一条上，不会串到邻居身上。图片与音色走的是同一条通道，只是 media 不同。
    """
    text = field or ""
    matches = list(REF_SLOT.finditer(text))
    items: List[Dict[str, Any]] = []
    for position, matched in enumerate(matches):
        end = matches[position + 1].start() if position + 1 < len(matches) else len(text)
        segment = text[matched.start():end]
        contract = parse_slot_contract(segment)
        kind = matched.group("kind").upper()
        slot = matched.group("slot")
        character = contract.get("角色", "")
        if not character:
            fallback = CHARACTER_IN_AUDIO.search(segment)
            character = fallback.group("name").strip() if fallback else ""
        items.append({
            "kind": kind,
            "media": slot_media(kind, slot, matched.group("locator")),
            "id": f"{kind}-{slot}",
            "slot": slot,
            "order": int(matched.group("order")),
            "locator": (matched.group("locator") or "").strip(),
            "name": (matched.group("name") or "").strip(),
            "usage": contract.get("用途", ""),
            "may_control": contract.get("控制", ""),
            "must_not_control": contract.get("不得控制", ""),
            "character": character,
        })
    return items


def contract_gaps(item: Dict[str, Any]) -> List[str]:
    """一条槽位的语义声明缺了哪几项——缺了就没法编译成「参考约束」，如实报出。"""
    gaps: List[str] = []
    if not item.get("usage"):
        gaps.append("用途")
    if not item.get("may_control"):
        gaps.append("控制")
    if not item.get("must_not_control"):
        gaps.append("不得控制")
    if not item.get("name"):
        gaps.append("中文名称")
    return gaps


def declared_reference_counts(node: Dict[str, Any]) -> Dict[str, int]:
    """一个节点在文档里声明了几张/几段各类素材（含画布不接的视频槽位）。

    口径取文档的声明数，不是画布实际连上的边数——上限是模型对「一次生成挂多少素材」的限制，
    声明超了就得回分镜阶段取舍，与画布连没连上无关。
    """
    counts: Dict[str, int] = {}
    for item in node.get("reference_slots") or []:
        counts[item["media"]] = counts.get(item["media"], 0) + 1
    for _ in node.get("video_slots") or []:
        counts["video"] = counts.get("video", 0) + 1
    for _ in node.get("audio_slots") or []:
        counts["audio"] = counts.get("audio", 0) + 1
    return counts


def resolve_reference_target(
    name: str, locator: str, by_key: Dict[str, str], by_title: Dict[str, str]
) -> Optional[str]:
    """按**名字**把一条参考槽位指到画布上已有的图片节点；认不出返回 None。

    连线只表达「节点与节点之间的关系」，不表达「这个节点当前显示的是第几次生成的结果」，
    所以这里只认名字，也不为参考文件另建节点。判据依次尝试，全部只看文档里写下的名字：

      1. 《中文名称》里出现的条目 ID——上游样例 `《SHOT-EP001-002 起始帧》`；
      2. 定位符的文件主名（去扩展名）是条目 ID——上游样例
         `制作成果/images/SHOT-EP001-002.png`，文件名就是产出它的条目；
      3. 《中文名称》恰好是某个条目的标题。

    名字里点到的条目**不在项目里**时照样返回它，由调用方按缺项报出——那是文档写错或条目还没建，
    属文档侧的缺口；名字里根本没有条目（如 `输入/参考图/江辰定妆.jpg《江辰定妆照》` 这种创作者
    自己在项目外准备的素材）时返回 None，那不是缺项，画布也不替它造节点。
    """
    found = ENTRY_ID.findall(name or "")
    if found:
        return found[0]
    tail = (locator or "").strip().rsplit("/", 1)[-1]
    stem = tail.rsplit(".", 1)[0] if "." in tail else tail
    found = ENTRY_ID.findall(stem)
    if found:
        return found[0]
    plain = (name or "").strip()
    if plain and plain in by_title:
        return by_title[plain]
    return None


def parse_duration(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    matched = DURATION.search(value)
    return float(matched.group(1)) if matched else None


def detect_ratio(entry: Dict[str, Any], fallback: Optional[str]) -> Optional[str]:
    """成片画幅由项目档案统一给定，条目只在显式写了「画幅」时覆盖它。

    不优先从提示词正文抓比例：正文里的数字冒号常是画面内元素（如 27 英寸屏、16:9 显示器），
    拿它当成片画幅会把已确认的画幅改掉。仅在档案与显式字段都缺时才回落到正文。
    """
    explicit = entry["fields"].get("画幅")
    if explicit:
        matched = RATIO.search(explicit)
        if matched:
            return matched.group(1)
    if fallback:
        return fallback
    matched = RATIO.search(pick_prompt(entry)[:160])
    return matched.group(1) if matched else None


def find_episode_dir(root: Path, episode: Optional[str]) -> Path:
    if (root / "图片提示词.md").is_file() or (root / "分镜.md").is_file():
        return root
    candidates: List[Path] = []
    for base in (root / "剧集", root / "episodes", root):
        if not base.is_dir():
            continue
        for child in sorted(base.iterdir()):
            if child.is_dir() and (EPISODE_DIR.match(child.name) or (child / "分镜.md").is_file()):
                candidates.append(child)
    if episode:
        wanted = episode.upper()
        for candidate in candidates:
            if candidate.name.upper() == wanted:
                return candidate
        raise SystemExit(f"找不到剧集目录：{episode}")
    if not candidates:
        raise SystemExit(f"在 {root} 下找不到任何剧集目录")
    return candidates[0]


def read_profile_ratio(start: Path) -> tuple[Optional[str], Optional[Path]]:
    """从剧集目录往上找项目档案，取 format.aspect_ratio（创作者在初始化时确认的成片画幅）。"""
    for parent in [start, *start.parents]:
        profile = parent / "short-drama.json"
        if not profile.is_file():
            continue
        try:
            payload = json.loads(read_text(profile))
        except (json.JSONDecodeError, OSError):
            return None, profile
        block = payload.get("format")
        if isinstance(block, dict):
            value = block.get("aspect_ratio")
            if isinstance(value, str) and value.strip():
                return value.strip(), profile
        surface = payload.get("creator_authority", {}).get("delivery_surface") if isinstance(payload.get("creator_authority"), dict) else None
        if isinstance(surface, dict):
            value = surface.get("aspect")
            if isinstance(value, str) and value.strip():
                return value.strip(), profile
        return None, profile
    return None, None


def read_visual_ratio(episode_dir: Path) -> Optional[str]:
    setting = episode_dir / "视觉设定.md"
    if not setting.is_file():
        return None
    matched = RATIO.search(read_text(setting)[:2000])
    return matched.group(1) if matched else None


def resolve_ratio(episode_dir: Path) -> Dict[str, Optional[str]]:
    """成片画幅按「项目档案 -> 视觉设定」取值；两处不一致时以档案为准并如实报告。"""
    profile_ratio, profile_path = read_profile_ratio(episode_dir)
    visual_ratio = read_visual_ratio(episode_dir)
    conflict = None
    if profile_ratio and visual_ratio and profile_ratio != visual_ratio:
        conflict = f"档案 {profile_ratio} 与视觉设定 {visual_ratio} 不一致"
    return {
        "ratio": profile_ratio or visual_ratio,
        "source": "项目档案 format.aspect_ratio" if profile_ratio else ("视觉设定.md" if visual_ratio else None),
        "profile": str(profile_path) if profile_path else None,
        "profile_ratio": profile_ratio,
        "visual_ratio": visual_ratio,
        "conflict": conflict,
    }


def parse_record_sheet(path: Path) -> List[Dict[str, Any]]:
    """读上游 $short-drama-write 的录音表（JSONL），每行一条待录台词。

    它是对白信息最全的来源：自带 tactic、pronunciation_notes、channel 与 target_seconds。
    但上游只给了模板和 voice_sheet_check.py 校验器、**没有生成脚本**，所以不能假定它存在；
    不存在时由 parse_screenplay_dialogue 从剧本投影。
    """
    rows: List[Dict[str, Any]] = []
    for raw in read_text(path).splitlines():
        text_line = raw.strip()
        if not text_line:
            continue
        try:
            record = json.loads(text_line)
        except json.JSONDecodeError:
            continue
        if not isinstance(record, dict):
            continue
        # 首行是 sources 声明（record_type=sources），不是台词。
        if record.get("record_type") == "sources":
            continue
        line_text = (record.get("line_text") or "").strip()
        if not line_text:
            continue
        rows.append({
            "key": (record.get("line_id") or "").strip() or f"VLINE-{len(rows) + 1:03d}",
            "speaker": (record.get("speaker_display") or record.get("speaker") or "").strip(),
            "text": line_text,
            "tactic": (record.get("tactic") or "").strip(),
            "channel": (record.get("channel") or "sync").strip(),
            "notes": [item for item in (record.get("pronunciation_notes") or []) if isinstance(item, dict)],
            "target_seconds": record.get("target_seconds"),
            "source": RECORD_SHEET,
        })
    return rows


def pick_reference_field(fields: Dict[str, Any]) -> str:
    """取参考槽位那一行。

    干净版里这一行叫「输入参考图」，音频另起一行「参考音频」（SKILL.md：音频不进「输入参考图」）；
    早期 fork 版把三类混排在一个「输入参考」里。两个名字都认，干净版优先。
    """
    return fields.get("输入参考图") or fields.get("输入参考") or ""


def parse_audio_reference(field: str) -> List[Dict[str, Any]]:
    """解析 MOTION 的「参考音频」行（VID-27）：逐条取人物音色与它写明的角色。

    角色是逐条各写一个的，所以与图片槽位共用同一条解析通道，每条各自取自己那段里的角色。
    """
    items = parse_reference_slots(field)
    items.sort(key=lambda item: item["order"])
    return items


def collect_dialogue(episode_dir: Path) -> tuple[List[Dict[str, Any]], str]:
    """取本集待录台词，并说明它来自哪一处。

    只有录音表一个来源。它不存在时交回 $short-drama-write 去生成，本脚本不代劳：
    对白怎么从剧本切出来，是写作技能的规则，画布这一层猜了就会与它错开。
    """
    sheet = episode_dir / RECORD_SHEET
    if sheet.is_file():
        return parse_record_sheet(sheet), RECORD_SHEET
    return [], ""


def music_field(fields: Dict[str, str], kind: str) -> str:
    for name in MUSIC_FIELD_ALIASES[kind]:
        value = (fields.get(name) or "").strip()
        if value:
            return value
    return ""


def round_to_step(seconds: float) -> int:
    """向上取到节点步长（5 秒）的整数倍——宁长勿短，短了只能重新生成。"""
    if seconds <= 0:
        return 0
    return int(-(-seconds // MUSIC_STEP) * MUSIC_STEP)


def music_scope_seconds(value: str, motion_durations: Dict[str, Optional[float]]) -> Optional[int]:
    """把上游字段「使用区间」机械换算成乐段的时长上限（秒）。

    只认两种换得出来的写法，换不出来返回 None，交回写章节的人写清，不靠默认值：
      - 条目区间（`MOTION-EP001-001 ~ MOTION-EP001-005`）：取覆盖镜头的时长之和；
      - 时间码（`00:00–00:12`、`01:00:00–01:00:48`）或直接写秒（`48s`、`0-12 秒`）：取区间末端。
    """
    text = (value or "").strip()
    if not text:
        return None
    shots = MUSIC_SHOT_RANGE.findall(text)
    if shots:
        total = 0.0
        for key in shots:
            seconds = motion_durations.get(key)
            if seconds:
                total += seconds
        return round_to_step(total) if total > 0 else None
    codes = MUSIC_TIME_RANGE.findall(text)
    if codes:
        hours, minutes, seconds = codes[-1]
        if seconds:
            return round_to_step(int(hours) * 3600 + int(minutes) * 60 + int(seconds))
        # `00:12` 是「分:秒」；只有三段才是「时:分:秒」。
        return round_to_step(int(hours) * 60 + int(minutes))
    numbers = re.findall(r"\d+(?:\.\d+)?", text)
    return round_to_step(float(numbers[-1])) if numbers else None


def resolve_segment_texts(segment: Dict[str, Any]) -> tuple[str, str, str]:
    """一个乐段的风格描述与歌词：返回（风格描述，歌词，歌词状态）。

    风格描述取围栏块或「风格描述」字段。歌词一律以 `- 歌词：` 为准，不靠「第几个围栏块」猜：

      - `- 歌词：无（纯旋律）` / `无` / `纯配乐`：纯配乐，节点 lyrics 留空（它的围栏块仍是
        风格描述——这是最常见的一种，章节里通常只有一个围栏块）；
      - `- 歌词：<一句>`：行内写下的歌词，原样带进节点；
      - `- 歌词：见下` + 紧随其后的围栏块：多行歌词写不下时才用，那个块就是歌词；
      - `- 歌词：待补…`：还没定稿，报进 stats，画布不代写；
      - 没有 `歌词` 行：未声明（上游章节字段表里没有歌词，缺失是常态，不算缺项）。

    歌词状态四值：`主题曲` / `纯配乐` / `待补` / `未声明`。
    """
    fences = segment.get("fences") or []
    lyrics_value = music_field(segment["fields"], "lyrics")
    plain = plain_value(lyrics_value)
    lyrics_line = segment.get("lyrics_line")
    lyrics = ""
    lyrics_block = ""
    state = "未声明"
    if lyrics_value:
        if LYRICS_PENDING.match(plain):
            state = "待补"
        elif LYRICS_NONE.match(plain):
            state = "纯配乐"
        elif LYRICS_BELOW.match(plain):
            if lyrics_line is not None:
                for fence in fences:
                    if fence["start"] > lyrics_line:
                        lyrics_block = fence["text"]
                        break
            if lyrics_block:
                lyrics, state = strip_quote(lyrics_block), "主题曲"
            # 说了「见下」却没有歌词块时仍是「未声明」——不把「见下」本身当成歌词。
        else:
            lyrics, state = strip_quote(lyrics_value), "主题曲"
    style = ""
    for fence in fences:
        if fence["text"] and fence["text"] != lyrics_block:
            style = fence["text"]
            break
    if not style:
        style = music_field(segment["fields"], "style")
    return style, lyrics, state


def parse_music_segments(
    markdown: str, motion_durations: Optional[Dict[str, Optional[float]]] = None
) -> List[Dict[str, Any]]:
    """从《视频提示词.md》里挑出时间线音乐章节的乐段项（`MUS-*`）。

    只认 `MUS-*` 标题下的内容：遇到任何别的标题（如 `MOTION-*`）就结束当前项，所以整篇
    视频提示词里只有音乐章节的字段会被读到。风格描述可写在围栏代码块里，也可写成字段。
    乐段怎么切是创作者在章节里的决定（方法见 references/segment-design.md），这里只把它
    读成节点，不替它划分。

    时长上限两个来源：先认显式「时长」字段（画布侧约定），没有再拿上游字段「使用区间」
    机械换算；两者都拿不到就留空并记下 `duration_source` 为空，由 stats 如实报出。

    歌词只从 `- 歌词：` 读（上游：歌词必须来自创作者提供或明确接受的文本）。写
    「无（纯旋律）」是纯配乐，节点 lyrics 留空；写实际文本、或写「见下」并紧跟一个围栏块
    才是主题曲。两种决定要分清，画布不替创作者二选一。
    """
    segments: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    in_fence = False
    fence_start = 0
    fence_lines: List[str] = []
    for index, raw in enumerate(markdown.splitlines()):
        line = raw.rstrip()
        if in_fence:
            if MUSIC_FENCE.match(line.strip()):
                if current is not None and fence_lines:
                    # 围栏块连行号记下来：紧跟「歌词」行的那个是歌词，另一个是风格描述。
                    current["fences"].append(
                        {"start": fence_start, "text": "\n".join(fence_lines).strip()}
                    )
                fence_lines = []
                in_fence = False
            else:
                fence_lines.append(line)
            continue
        heading = MUSIC_HEADING.match(line.strip())
        if heading:
            if current is not None:
                segments.append(current)
            current = {
                "id": heading.group("id"),
                "title": (heading.group("title") or "").strip(),
                "fields": {},
                "fences": [],
            }
            continue
        if ANY_HEADING.match(line.strip()):
            # 别的项（MOTION-* 或下一节的标题）：当前乐段到此为止。
            if current is not None:
                segments.append(current)
                current = None
            continue
        if current is None:
            continue
        if MUSIC_FENCE.match(line.strip()):
            in_fence = True
            fence_start = index
            fence_lines = []
            continue
        field = FIELD.match(line.strip())
        if field:
            key = field.group("key").strip()
            current["fields"][key] = field.group("value").strip()
            if key in MUSIC_FIELD_ALIASES["lyrics"]:
                current["lyrics_line"] = index
    if current is not None:
        segments.append(current)

    durations = motion_durations or {}
    rows: List[Dict[str, Any]] = []
    for segment in segments:
        style, lyrics, lyrics_state = resolve_segment_texts(segment)
        raw_duration = music_field(segment["fields"], "duration")
        duration: Optional[int] = None
        source = ""
        if raw_duration:
            matched = MUSIC_DURATION.search(raw_duration)
            if matched:
                duration = int(round(float(matched.group(1))))
                source = "时长字段"
        if duration is None:
            derived = music_scope_seconds(music_field(segment["fields"], "scope"), durations)
            if derived:
                duration = derived
                source = "使用区间推算"
        rows.append({
            "id": segment["id"],
            "title": segment["title"],
            "style": style,
            "lyrics": lyrics,
            "lyrics_state": lyrics_state,
            "duration": duration,
            "duration_source": source,
        })
    return rows


def build_plan(episode_dir: Path) -> Dict[str, Any]:
    resolved = resolve_ratio(episode_dir)
    ratio = resolved["ratio"]
    nodes: List[Dict[str, Any]] = []
    index: Dict[str, Dict[str, Any]] = {}
    # 参考槽位连出的边还会带上文档写的 `顺序`（`order`）与素材类别（`media`），
    # 供 board_apply 定引用编号、编译「参考约束」。
    edges: List[Dict[str, Any]] = []

    def add_node(node: Dict[str, Any]) -> None:
        nodes.append(node)
        index[node["key"]] = node

    image_doc = episode_dir / "图片提示词.md"
    if image_doc.is_file():
        for entry in parse_entries(read_text(image_doc)):
            explicit = entry["fields"].get("画幅")
            matched = RATIO.search(explicit) if explicit else None
            add_node({
                "key": entry["id"],
                "kind": "image",
                "role": "asset",
                "title": entry["title"],
                "prompt": pick_prompt(entry),
                "purpose": entry["fields"].get("用途", ""),
                "ratio": matched.group(1) if matched else "自适应",
                "source": "图片提示词.md",
                # IMG 条目的「参考」与分镜的「输入参考图」是同一套语法（上游校验器是同一个
                # `_references()`），所以走同一条槽位通道，脚本不为它单开一条简化路径。
                "reference_field": entry["fields"].get("参考", ""),
            })

    shot_doc = episode_dir / "分镜.md"
    if shot_doc.is_file():
        for entry in parse_entries(read_text(shot_doc)):
            add_node({
                "key": entry["id"],
                "kind": "image",
                "role": "keyframe",
                "title": entry["title"],
                "prompt": pick_prompt(entry),
                "duration": parse_duration(entry["fields"].get("时长")),
                "ratio": detect_ratio(entry, ratio),
                "source": "分镜.md",
                "image_items": IMG_ITEM.findall(entry["fields"].get("图片提示词项", "")),
                "reference_field": pick_reference_field(entry["fields"]),
            })

    motion_doc = episode_dir / "视频提示词.md"
    if motion_doc.is_file():
        # 同一份文档里既有逐镜的 MOTION 项，也有按需出现的时间线音乐章节，一次读取两处都用。
        motion_text = read_text(motion_doc)
        motion_seconds: Dict[str, Optional[float]] = {}
        for entry in parse_entries(motion_text):
            seconds = parse_duration(entry["fields"].get("时长"))
            motion_seconds[entry["id"]] = seconds
            add_node({
                "key": entry["id"],
                "kind": "video",
                "role": "motion",
                "title": entry["title"],
                "prompt": pick_prompt(entry),
                "duration": seconds,
                "ratio": detect_ratio(entry, ratio),
                "mode": entry["fields"].get("生成方式", ""),
                "shot": (entry["fields"].get("分镜") or "").strip(),
                "source": "视频提示词.md",
                "reference_field": pick_reference_field(entry["fields"]),
                # 上游把人物音色放在 MOTION 自己的一行「参考音频」（VID-27），与「输入参考图」
                # 分开编号。它写明了角色与路径，是画布上音色参考节点的唯一来源。
                "audio_field": entry["fields"].get("参考音频", ""),
            })
        # 时间线音乐章节的乐段 -> 音乐节点。它是产出物，供剪辑铺轨，不与任何节点连线；
        # 风格描述就是它唯一进模型的文本，时长是上限（宁长勿短，见 segment-design.md）。
        # 章节的字段表里没有「时长」，所以先用上游字段「使用区间」按覆盖镜头换算。
        for segment in parse_music_segments(motion_text, motion_seconds):
            add_node({
                "key": segment["id"],
                "kind": "music",
                "role": "music",
                "title": segment["title"],
                "prompt": "",
                "style": segment["style"],
                # 歌词只在篇章写了实际文本（主题曲）时才带；纯配乐留空。画布不代写歌词。
                "lyrics": segment["lyrics"],
                "lyrics_state": segment["lyrics_state"],
                "duration": segment["duration"],
                "duration_source": segment["duration_source"],
                "source": "视频提示词.md",
            })

    # 音色：MOTION 的「参考音频」行是上游登记的人物音色（VID-27），与「输入参考图」分开一行、
    # 分开编号。它写明了角色，画布按角色名把它接到该人物的对白节点上。
    for node in nodes:
        if node["role"] == "motion":
            node["audio_slots"] = parse_audio_reference(node.pop("audio_field", ""))
        else:
            node.pop("audio_field", None)

    # 对白：录音表是唯一来源。逐镜的音频实现（空间化、层级、与画面的对位）
    # 属于视频提示词环节，录音表明确「只引用不复制」，所以对白不自动连向任何一个镜头。
    dialogue_rows, dialogue_source = collect_dialogue(episode_dir)
    for row in dialogue_rows:
        add_node({
            "key": row["key"],
            "kind": "audio",
            "role": "dialogue",
            "title": row["speaker"],
            "prompt": row["text"],
            "tactic": row["tactic"],
            "channel": row["channel"],
            "notes": row["notes"],
            "duration": row["target_seconds"],
            "source": row["source"],
        })

    # 连线一：分镜的图片提示词项 -> 该镜关键帧
    for node in nodes:
        if node["role"] != "keyframe":
            continue
        for item in node.get("image_items", []):
            if item in index:
                edges.append({"from": item, "to": node["key"], "reason": "图片提示词项", "document": "分镜.md"})
            else:
                node.setdefault("missing_items", []).append(item)

    # 连线二：视频提示词的分镜 -> 该视频镜头
    for node in nodes:
        if node["role"] != "motion":
            continue
        shot = node.get("shot", "")
        if not shot:
            continue
        if shot in index:
            edges.append({"from": shot, "to": node["key"], "reason": "分镜", "document": "视频提示词.md"})
        else:
            node.setdefault("missing_items", []).append(shot)

    # 连线三：参考槽位。一条声明里有三种来源，各自处置——
    #   PLAN- 的定位符就是条目 ID（IMG-/SHOT-），文档已写明「这张图画的是哪一条已决定的事实」；
    #   REF- 的定位符是项目内的真实文件路径，画布上没有对应条目，靠名字认出它是哪一条的产出；
    #   视频槽位不作参考输入，写了的计进 stats，不静默丢掉。
    # 两类槽位都只按名字认节点（见 resolve_reference_target），不为参考文件另建节点——
    # 边只表达节点之间的关系，不表达「这个节点当前显示第几次生成的结果」。
    ignored_video_slots: List[str] = []
    unresolved_references: List[Dict[str, Any]] = []
    # 按名字认节点要用的索引，只收图片节点：参考槽位指向的是图，指向人物或视频条目都说不通。
    picture_nodes = [n for n in nodes if n["kind"] == "image"]
    by_key = {n["key"]: n["key"] for n in picture_nodes}
    title_seen: Dict[str, int] = {}
    for item in picture_nodes:
        title_seen[item["title"]] = title_seen.get(item["title"], 0) + 1
    by_title = {n["title"]: n["key"] for n in picture_nodes if title_seen[n["title"]] == 1}
    # 已连的边按 (源, 目标) 索引：文档里同一条参考既可能由结构字段连上，也可能由参考槽位
    # 声明，两种写法指向同一对节点，要让它们合成一条边（顺序取声明里那一个）。
    edge_index = {(edge["from"], edge["to"]): edge for edge in edges}
    for node in nodes:
        # 对白与音乐都不是画面，谈不上有参考图；对白的音色参考属「参考音频」那一行。
        if node["role"] in ("dialogue", "music"):
            continue
        field = node.pop("reference_field", "") or ""
        parsed = parse_reference_slots(field)
        # 视频槽位不作参考输入，但声明超了上限仍要报（见 declared_reference_counts）。
        node["video_slots"] = [item for item in parsed if item["media"] == "video"]
        ignored_video_slots.extend(item["id"] for item in node["video_slots"])
        slots = [item for item in parsed if item["media"] != "video"]
        slots.sort(key=lambda item: (MEDIA_ORDER[item["media"]], item["order"]))
        node["reference_slots"] = slots
        # 音色是附加在图片之上的另一类，不改变「这一镜有没有图」。
        outcome = classify_reference(
            field,
            {item["kind"] for item in slots if item["media"] == "image"},
            asset=node["role"] == "asset",
        )
        node["reference_state"] = outcome["state"]
        # 「已就绪」只有一个判据：有图且不缺口，或创作者明确选择无参考。光有 REF-/PLAN-
        # 但带着「；待补参考图：…」仍算未就绪——只是缺了一部分。
        node["reference_ready"] = outcome["ready"]
        node["reference_pending"] = outcome["pending"]
        node["pending_items"] = outcome["pending_items"]
        node["reference_raw"] = field
        # 槽位指到哪个节点就连哪条边；指到不存在的条目的按缺项报出，不静默丢。
        for item in slots:
            if item["media"] != "image":
                continue
            if item["kind"] == "PLAN":
                # PLAN- 的定位符本来就是条目 ID，直接用它。
                target_key = item["locator"]
            else:
                target_key = resolve_reference_target(
                    item["name"], item["locator"], by_key, by_title
                )
            if not target_key:
                # 名字里没有条目：这是创作者自己在项目外准备的素材（`输入/参考图/…`），
                # 画布上没有对应节点，也不替它造文件节点。如实报出，让创作者自己挂。
                unresolved_references.append({
                    "key": node["key"], "slot": item["id"],
                    "name": item["name"], "path": item["locator"],
                })
                continue
            if target_key == node["key"]:
                # 自指：分镜的「输入参考图」按上游要求与对应 MOTION 逐字一致，而 MOTION 的
                # 「起始帧」槽位点的正是本镜自己的冻结关键帧，于是分镜里那一行会指回自己。
                # 这条边在画布上无从表达（节点不能喂自己），而 MOTION→SHOT 的「分镜」边已经
                # 承担了同一个事实，所以跳过，不当缺项报出。
                continue
            if target_key not in index:
                node.setdefault("missing_items", []).append(target_key)
                continue
            # 解析出来的引用按文档的 `顺序` 记在目标节点上：board_apply 用它定引用编号，
            # 让正文里的 `<Picture N>` 与画布引用列表同源。自指与缺项在上一行已经出局。
            node.setdefault("resolved_references", []).append({
                "slot": item["id"], "order": item["order"],
                "media": item["media"], "target": target_key,
            })
            linked = edge_index.get((target_key, node["key"]))
            if linked is not None:
                # 这一对节点已由结构边（「图片提示词项」/「分镜」）连上，不再重复连一条；
                # 但结构边没有「顺序」，把文档那行声明写的顺序补到它身上——正文里的
                # `<Picture N>` 与画布引用编号都由这个顺序定（见 board_apply.reference_order）。
                linked.setdefault("order", item["order"])
                linked.setdefault("media", item["media"])
                # 槽位 id 也留给 board_apply：它照着节点自己的声明编译「参考约束」。
                linked.setdefault("slot", item["id"])
                continue
            edge = {
                "from": target_key, "to": node["key"],
                "reason": "参考槽位", "document": node["source"],
                "order": item["order"], "media": item["media"], "slot": item["id"],
            }
            edges.append(edge)
            edge_index[(target_key, node["key"])] = edge

    stats = {
        "episode": episode_dir.name,
        "image_nodes": sum(1 for n in nodes if n["kind"] == "image" and n["role"] == "asset"),
        "keyframe_nodes": sum(1 for n in nodes if n["role"] == "keyframe"),
        "video_nodes": sum(1 for n in nodes if n["kind"] == "video"),
        "dialogue_nodes": sum(1 for n in nodes if n["role"] == "dialogue"),
        "dialogue_source": dialogue_source or (
            f"缺失：{RECORD_SHEET} 不存在；台词由 $short-drama-write 投影剧本生成，画布不代劳"
        ),
        "music_nodes": sum(1 for n in nodes if n["role"] == "music"),
        "edges": len(edges),
        # 音乐节点没有可复制提示词（它的文本是章节里的 style），不算缺正文。
        "empty_prompts": [n["key"] for n in nodes if not n["prompt"] and n["role"] != "music"],
        # 乐段缺风格描述 / 定不出时长上限时如实列出，别让节点静默落默认值。
        "music_without_style": [n["key"] for n in nodes if n["role"] == "music" and not n.get("style")],
        "music_without_duration": [
            n["key"] for n in nodes if n["role"] == "music" and not n.get("duration")
        ],
        # 主题曲的歌词会随节点一起送进模型，列出来让创作者在付费前核对一遍；写了「待补」
        # 说明还没定稿，单独报，画布不代写。
        "music_with_lyrics": [n["key"] for n in nodes if n.get("lyrics_state") == "主题曲"],
        "music_lyrics_pending": [n["key"] for n in nodes if n.get("lyrics_state") == "待补"],
        "dangling_items": sorted({item for n in nodes for item in n.get("missing_items", [])}),
        "aspect_ratio": ratio,
        "ratio_source": resolved["source"],
        "ratio_conflict": resolved["conflict"],
        # 画幅没定出来的节点（档案、视觉设定、条目「画幅」三处都拿不到）：画布不会替它假造
        # 一个比例，它会沿用节点自身的默认值，所以建图前必须先与创作者确认成片画幅。
        "nodes_without_ratio": [
            n["key"] for n in nodes if n["kind"] in ("image", "video") and not n.get("ratio")
        ],
        # 参考还没备齐的条目：`reference_ready` 为假的全在这里，说清是「缺口点名了条目」
        # 还是「光写了无」——前者要补图，后者要创作者先决定走图生还是文生。
        "unready_references": [
            {"key": n["key"], "state": n["reference_state"],
             "missing": n.get("pending_items") or []}
            for n in nodes if n.get("reference_ready") is False
        ],
        # 视频参考槽位不作参考输入，写了的在这里列出来（不静默丢失）。
        "ignored_video_slots": sorted(set(ignored_video_slots)),
        # 参考槽位点到的名字在项目里找不到条目：通常是创作者自己在项目外准备的素材
        # （`输入/参考图/…`）。画布不替它造节点，所以这条参考不会出现在连线里，如实报出。
        "unresolved_references": unresolved_references,
        # 参考声明的语义不全（缺 `用途`/`控制`/`不得控制`/`中文名称`）：节点照建，但这一条
        # 参考没法编译成「参考约束」，执行端收不到「这张图允许决定什么」——回上游补齐。
        "incomplete_reference_slots": [
            {"key": n["key"], "slot": item["id"], "missing": contract_gaps(item)}
            for n in nodes
            for item in (n.get("reference_slots") or [])
            if contract_gaps(item)
        ],
        # 声明的素材数超过目标模型一次生成的上限（H3：9 图 / 3 视频 / 3 音频）。这是文档侧的
        # 取舍问题，画布不替创作者砍参考，只如实报出，避免到提交时才失败。
        "reference_over_limit": [
            {"key": n["key"], "media": media, "count": count, "limit": REFERENCE_LIMITS[media]}
            for n in nodes if n["role"] == "motion"
            for media, count in sorted(declared_reference_counts(n).items())
            if count > REFERENCE_LIMITS[media]
        ],
    }
    if resolved["conflict"] is None and resolved["profile_ratio"] is None and resolved["visual_ratio"] is None:
        stats["ratio_missing"] = True
    return {"stats": stats, "nodes": nodes, "edges": edges}


def main() -> int:
    parser = argparse.ArgumentParser(description="解析短剧创作文档，输出画布施工计划（只读，不写文件）")
    parser.add_argument("project", help="项目根目录，或直接指定剧集目录")
    parser.add_argument("--episode", help="剧集目录名，如 EP001；省略时取第一个")
    parser.add_argument("--pretty", action="store_true", help="格式化输出，便于人工核对")
    args = parser.parse_args()

    root = Path(args.project).expanduser()
    if not root.is_dir():
        raise SystemExit(f"目录不存在：{root}")
    episode_dir = find_episode_dir(root.resolve(), args.episode)
    plan = build_plan(episode_dir)
    print(json.dumps(plan, ensure_ascii=False, indent=2 if args.pretty else None))

    stats = plan["stats"]
    if stats["empty_prompts"]:
        print(f"警告：{len(stats['empty_prompts'])} 个条目没有可复制提示词", file=sys.stderr)
    if stats["dangling_items"]:
        print(f"警告：引用了不存在的条目 {stats['dangling_items']}", file=sys.stderr)
    if stats.get("unready_references"):
        gap = sorted({item for row in stats["unready_references"] for item in row["missing"]})
        print(
            f"警告：{len(stats['unready_references'])} 个条目的参考图还没备齐，"
            f"建节点可以继续，但这些条目不能声称已有参考"
            + (f"；缺口 {gap}" if gap else "（未点明缺口，先与创作者确认走图生还是文生）"),
            file=sys.stderr,
        )
    if stats.get("music_without_style"):
        print(f"警告：乐段缺风格描述（节点唯一进模型的文本）：{stats['music_without_style']}", file=sys.stderr)
    if stats.get("music_without_duration"):
        print(
            f"警告：乐段定不出时长上限（写「时长」或「使用区间」都没有可换算的数）："
            f"{stats['music_without_duration']}",
            file=sys.stderr,
        )
    if stats.get("music_lyrics_pending"):
        print(
            f"警告：乐段的歌词标着待补，节点现在只出纯旋律：{stats['music_lyrics_pending']}"
            "（歌词由创作者提供或明确接受，画布不代写）",
            file=sys.stderr,
        )
    if stats.get("music_with_lyrics"):
        print(
            f"注意：这些乐段是主题曲，歌词会随节点一起送进模型，付费前先核对："
            f"{stats['music_with_lyrics']}",
            file=sys.stderr,
        )
    if stats.get("ratio_missing"):
        print("警告：项目档案与视觉设定都没有成片画幅；先与创作者确认画幅并写入档案，不要靠默认值建图",
              file=sys.stderr)
    if stats.get("nodes_without_ratio"):
        print(
            f"警告：这些节点没定出画幅，节点会沿用自身默认比例：{stats['nodes_without_ratio']}",
            file=sys.stderr,
        )
    if stats.get("unresolved_references"):
        rows = stats["unresolved_references"]
        print(
            f"警告：{len(rows)} 条参考槽位点到的名字在项目里没有条目（多为项目外素材），"
            f"这些参考不会出现在连线里，要在画布上自行挂：",
            file=sys.stderr,
        )
        for row in rows:
            print(f"  {row['key']} → {row['slot']}《{row['name']}》· {row['path']}", file=sys.stderr)
    if stats.get("incomplete_reference_slots"):
        rows = stats["incomplete_reference_slots"]
        print(
            f"注意：{len(rows)} 条参考缺语义声明，编译不出「参考约束」，执行端收不到这张图"
            f"允许决定什么——回上游把用途/控制/不得控制写全：",
            file=sys.stderr,
        )
        for row in rows:
            print(f"  {row['key']} → {row['slot']}（缺 {'、'.join(row['missing'])}）", file=sys.stderr)
    if stats.get("reference_over_limit"):
        print("警告：声明的素材数超过目标模型一次生成的上限，回分镜阶段按重要性取舍：", file=sys.stderr)
        for row in stats["reference_over_limit"]:
            print(f"  {row['key']}：{row['media']} {row['count']} 项，上限 {row['limit']}", file=sys.stderr)
    if stats.get("ratio_conflict"):
        print(f"警告：{stats['ratio_conflict']}；本次关键帧与视频以项目档案为准，请回对应 owner 统一文档",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
