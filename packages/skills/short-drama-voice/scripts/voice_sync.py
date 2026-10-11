#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把配音本里定好的音色参考回写到跨文档校验认的两个规范位置。

配音本是工作稿；校验器与生产读的是这两个位置，必须同步：

  1. 《视觉设定.md》的人物条目下加/更新 `- 声音参考：<路径>（用途：…；控制：…；不得控制：…）`
  2. 《视频提示词.md》的 MOTION 条目「输入参考」末尾加/更新 `REF-VOICE-…（顺序：n）·
     <路径>《中文名》（用途：音色；角色：<人物名>；控制：…；不得控制：台词、语气、情绪）`

音色槽位与图片槽位同处一个字段（VID-27），写在图片槽位之后，顺序单独从 1 数；
旧的 `- 参考音频：` 行会在这里被删掉，内容迁进「输入参考」。

只改这两处，不碰其他内容；已存在的行原地更新，不重复追加。
默认先出计划（--dry-run 效果），加 --write 才真正落盘。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
from voice_plan import (  # noqa: E402
    build_plan, find_episode_dir, match_visual_entry, read_text,
)
from voice_apply import parse_roll_cast, parse_roll_lines, line_to_motion, scene_to_motions  # noqa: E402

VISUAL_HEADING = re.compile(r"^##\s+人物\s*·\s*(?P<name>.+?)\s*$")
MOTION_HEADING = re.compile(r"^##\s+(?P<id>MOTION-[A-Za-z0-9-]+)\s*(?:·\s*(?P<title>.*))?$")
VOICE_RECORD_LINE = re.compile(r"^[ \t　]*[-*+][ \t　]*声音参考[：:]")
# The field the voice slots now live in, and the field they used to live in.
INPUT_FIELD_LINE = re.compile(r"^[ \t　]*[-*+][ \t　]*(?:\*\*)?输入参考(?:\*\*)?[：:]")
AUDIO_REF_LINE = re.compile(r"^[ \t　]*[-*+][ \t　]*(?:\*\*)?参考音频(?:\*\*)?[：:]")
FIELD_LINE = re.compile(r"^[ \t　]*[-*+][ \t　]*(?P<key>[^：:]+)[：:]")
# Everything from the first voice slot to the end of the value: the slots are
# written last, so cutting there leaves the picture part untouched and makes
# the rewrite idempotent.
VOICE_TAIL = re.compile(r"(?:^|；)REF-VOICE[-A-Za-z0-9\u3400-\u9fff]*（顺序：[\s\S]*$")
SCREEN_NAME_LINE = re.compile(r"^[ \t　]*[-*+][ \t　]*画面代称[：:](.+)$")
# 音色参考行的用途/控制/不得控制/状态四段（顺序固定，匹配配音本的写法）。
VOICE_DETAIL = re.compile(r"[（(]用途[：:](?P<purpose>[^；）]*)[；;]控制[：:](?P<may>[^；）]*)[；;]不得控制[：:](?P<must>[^）]*)[）)]")

AUDIO_MUST_NOT = "台词、语气、情绪"


def split_voice_detail(value: str) -> Optional[Dict[str, str]]:
    """从配音本的「声音参考」值里拆出路径与三段控制边界。"""
    matched = VOICE_DETAIL.search(value)
    if not matched:
        return None
    path = value[: matched.start()].strip()
    if not path:
        return None
    return {
        "path": path,
        "purpose": matched.group("purpose").strip(),
        "may": matched.group("may").strip(),
        "must": matched.group("must").strip(),
    }


def slot_for(character: str, designator: str = "") -> str:
    """REF 槽位名：ASCII 大写，与人物一一对应。

    正文用英文写的项目里，人物通常有英文「画面代称」，那个拼写就是槽位名。
    槽位名必须稳定且唯一——两个人不能共用一个名字，也不能因为多了一个说话人
    就整体改名；既没有 ASCII 也没有汉字的名字退成该名字的短摘要。
    """
    for candidate in (designator, character):
        ascii_name = re.sub(r"[^A-Za-z0-9]+", "-", candidate).strip("-").upper()
        if ascii_name:
            return f"REF-VOICE-{ascii_name}"
    han_name = re.sub(r"[^\u3400-\u9fff]+", "-", character).strip("-")
    if han_name:
        return f"REF-VOICE-{han_name}"
    return "REF-VOICE-" + hashlib.sha1(character.encode("utf-8")).hexdigest()[:6].upper()


def visual_designators(episode_dir: Path) -> Dict[str, str]:
    """每个 人物 条目声明的画面代称，供槽位取名使用。"""
    doc = episode_dir / "视觉设定.md"
    if not doc.is_file():
        return {}
    result: Dict[str, str] = {}
    current: Optional[str] = None
    for raw in read_text(doc).splitlines():
        line = raw.strip()
        heading = VISUAL_HEADING.match(line)
        if heading:
            current = heading.group("name").strip()
            continue
        if line.startswith("## "):
            current = None
            continue
        if current is None:
            continue
        declared = SCREEN_NAME_LINE.match(raw)
        if declared and declared.group(1).strip():
            result[current] = declared.group(1).strip()
    return result


def apply_visual(episode_dir: Path, cast: Dict[str, Dict[str, str]], write: bool) -> Dict[str, Any]:
    """在《视觉设定.md》的人物条目下加/更新声音参考行。

    插入点优先选「状态变化」/「本集状态」之后；没有该字段时落在条目第一行之后。
    已存在的行原地更新，不重复追加（校验器对重复会判错）。
    """
    doc = episode_dir / "视觉设定.md"
    if not doc.is_file():
        raise SystemExit(f"找不到视觉设定：{doc}")
    lines = read_text(doc).splitlines()
    changed: List[Dict[str, str]] = []

    current: Optional[str] = None
    insert_targets: Dict[str, int] = {}
    has_line: Dict[str, int] = {}
    for index, raw in enumerate(lines):
        heading = VISUAL_HEADING.match(raw.strip())
        if heading:
            current = heading.group("name").strip()
            insert_targets[current] = index + 1
            continue
        if current is None or raw.strip().startswith("## "):
            current = None
            continue
        field = FIELD_LINE.match(raw)
        if field and field.group("key").strip() in ("状态变化", "本集状态"):
            insert_targets[current] = index + 1
            continue
        if VOICE_RECORD_LINE.match(raw):
            has_line[current] = index
            insert_targets.pop(current, None)

    for name, record in cast.items():
        detail = split_voice_detail(record.get("声音参考", ""))
        if not detail:
            continue
        visual_name = record.get("别名_visual") or name
        text = f"- 声音参考：{detail['path']}（用途：{detail['purpose']}；控制：{detail['may']}；不得控制：{detail['must']}）"
        if visual_name in has_line:
            lines[has_line[visual_name]] = text
            changed.append({"位置": f"视觉设定.md · {visual_name}", "动作": "更新"})
        elif visual_name in insert_targets:
            at = insert_targets[visual_name]
            lines.insert(at, text)
            # 插入后后续行号整体后移，重建索引。
            for key in list(insert_targets):
                if insert_targets[key] > at:
                    insert_targets[key] += 1
            for key in list(has_line):
                if has_line[key] > at:
                    has_line[key] += 1
            insert_targets.pop(visual_name, None)
            changed.append({"位置": f"视觉设定.md · {visual_name}", "动作": "新增"})

    if write and changed:
        doc.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"changed": changed, "count": len(changed)}


def _scan_motions(lines: List[str]) -> Tuple[Dict[str, int], Dict[str, int]]:
    """每个 MOTION 条目的「输入参考」行号，以及残留的「参考音频」行号。"""
    inputs: Dict[str, int] = {}
    stale: Dict[str, int] = {}
    current: Optional[str] = None
    for index, raw in enumerate(lines):
        heading = MOTION_HEADING.match(raw.strip())
        if heading:
            current = heading.group("id")
            continue
        if current is None or raw.strip().startswith("## "):
            current = None
            continue
        if INPUT_FIELD_LINE.match(raw):
            inputs[current] = index
        elif AUDIO_REF_LINE.match(raw):
            stale[current] = index
    return inputs, stale


def _split_field(raw: str) -> Optional[Tuple[str, str, str]]:
    """`- 输入参考：<值>` 拆成（前缀、分隔符、值）；不是该字段时返回 None。"""
    for separator in ("：", ":"):
        if separator in raw:
            head, _, value = raw.partition(separator)
            return head, separator, value
    return None


def _rewrite_input(raw: str, parts: List[str]) -> Optional[str]:
    """把音色槽位整段换到「输入参考」末尾；图片部分一字不动。"""
    split = _split_field(raw)
    if split is None:
        return None
    head, separator, value = split
    picture = VOICE_TAIL.sub("", value.strip()).rstrip("；;。 ")
    if parts:
        joined = "；".join(parts)
        picture = f"{picture}；{joined}" if picture else joined
    return f"{head}{separator}{picture}"


def apply_motion(episode_dir: Path, roll_lines: List[Dict[str, Any]], cast: Dict[str, Dict[str, str]], by_scene: Dict[str, List[str]], write: bool) -> Dict[str, Any]:
    """在《视频提示词.md》MOTION 条目的「输入参考」末尾加/更新音色槽位。"""
    doc = episode_dir / "视频提示词.md"
    if not doc.is_file():
        raise SystemExit(f"找不到视频提示词：{doc}")
    lines = read_text(doc).splitlines()

    designators = visual_designators(episode_dir)
    # 先按 MOTION 归拢：每个镜头绑哪些人物的音色。
    binding: Dict[str, List[Tuple[str, str, str]]] = {}
    for line in roll_lines:
        speaker = line["fields"].get("说话人", "").strip()
        motion = line_to_motion(line, by_scene)
        if not speaker or not motion:
            continue
        record = cast.get(speaker, {})
        detail = split_voice_detail(record.get("声音参考", ""))
        if not detail:
            continue
        visual_name = record.get("别名_visual") or speaker
        binding.setdefault(motion, [])
        if not any(item[0] == visual_name for item in binding[motion]):
            binding[motion].append((visual_name, detail["path"], detail["may"]))

    changed: List[Dict[str, Any]] = []
    inputs, stale = _scan_motions(lines)

    # 旧的「参考音频」行先删：音色槽位已迁进「输入参考」，留着会被校验器判错。
    for index in sorted(stale.values(), reverse=True):
        changed.append({"位置": f"视频提示词.md · 第 {index + 1} 行", "动作": "删除旧的参考音频行", "绑定": 0})
        del lines[index]
    if stale:
        inputs, _ = _scan_motions(lines)

    for motion, items in binding.items():
        parts = []
        for order, (name, path, may) in enumerate(items, start=1):
            slot = slot_for(name, designators.get(name, ""))
            parts.append(
                f"{slot}（顺序：{order}）· {path}《{name}的音色》"
                f"（用途：音色；角色：{name}；控制：{may}；不得控制：{AUDIO_MUST_NOT}）"
            )
        if motion not in inputs:
            changed.append({"位置": f"视频提示词.md · {motion}", "动作": "跳过（找不到输入参考字段）", "绑定": 0})
            continue
        index = inputs[motion]
        rewritten = _rewrite_input(lines[index], parts)
        if rewritten is None:
            changed.append({"位置": f"视频提示词.md · {motion}", "动作": "跳过（输入参考字段无法解析）", "绑定": 0})
            continue
        if rewritten == lines[index]:
            continue
        action = "更新" if VOICE_TAIL.search(lines[index]) else "新增"
        lines[index] = rewritten
        changed.append({"位置": f"视频提示词.md · {motion}", "动作": action, "绑定": len(items)})

    # 配音本里已经不说话的镜头：把残留的音色槽位摘掉，别让它挂着旧人。
    for motion, index in inputs.items():
        if motion in binding:
            continue
        rewritten = _rewrite_input(lines[index], [])
        if rewritten is not None and rewritten != lines[index]:
            lines[index] = rewritten
            changed.append({"位置": f"视频提示词.md · {motion}", "动作": "摘除音色槽位", "绑定": 0})

    if write and changed:
        doc.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"changed": changed, "count": len(changed)}


def main() -> int:
    parser = argparse.ArgumentParser(description="把配音本的音色参考回写到视觉设定与视频提示词（默认只出计划）")
    parser.add_argument("project", help="项目根目录，或直接指定剧集目录")
    parser.add_argument("--episode", help="剧集目录名，如 EP001；省略时取第一个")
    parser.add_argument("--write", action="store_true", help="真正落盘；省略时只显示将要做的改动")
    parser.add_argument("--pretty", action="store_true", help="格式化输出")
    args = parser.parse_args()

    root = Path(args.project).expanduser()
    if not root.is_dir():
        raise SystemExit(f"目录不存在：{root}")
    episode_dir = find_episode_dir(root.resolve(), args.episode)

    roll_doc = episode_dir / "配音本.md"
    if not roll_doc.is_file():
        raise SystemExit(f"找不到配音本：{roll_doc}")
    markdown = read_text(roll_doc)
    raw_cast = parse_roll_cast(markdown)
    roll_lines = parse_roll_lines(markdown)

    # 用 voice_plan 的对齐逻辑把别名解析出来，供回写使用。
    plan = build_plan(episode_dir)
    visual_of = {item["speaker"]: item.get("visual_entry") for item in plan["cast"]}
    cast: Dict[str, Dict[str, str]] = {}
    for speaker, record in raw_cast.items():
        merged = dict(record)
        merged["别名_visual"] = visual_of.get(speaker) or record.get("别名") or speaker
        cast[speaker] = merged

    by_scene = scene_to_motions(episode_dir)
    visual_result = apply_visual(episode_dir, cast, args.write)
    motion_result = apply_motion(episode_dir, roll_lines, cast, by_scene, args.write)

    report = {
        "剧集": episode_dir.name,
        "模式": "写入" if args.write else "计划（--write 才落盘）",
        "视觉设定改动": visual_result["changed"],
        "视频提示词改动": motion_result["changed"],
    }
    print(json.dumps(report, ensure_ascii=False, indent=2 if args.pretty else None))
    if not args.write:
        print("以上是计划；确认无误后加 --write 落盘", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
