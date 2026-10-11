#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把短剧项目的创作文档解析成画布施工计划。

读三份 creator-first 文档，输出结构化节点清单与连线清单：
  - 图片提示词.md 的 IMG-*  -> 图片节点（资产图）
  - 分镜.md       的 SHOT-* -> 图片节点（冻结关键帧）
  - 视频提示词.md 的 MOTION-* -> 视频节点

连线依据取自文档已有的事实，不做推断：
  - SHOT 的「图片提示词项」  -> IMG 节点连到该 SHOT 节点
  - MOTION 的「分镜」        -> SHOT 节点连到该 MOTION 节点
  - SHOT/MOTION 的「输入参考图」的 REF-* -> 该素材连到目标节点

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
REF_SLOT = re.compile(r"(?P<kind>REF|PLAN)-(?P<slot>[A-Za-z0-9-]+)\s*（顺序：(?P<order>\d+)）")
IMG_ITEM = re.compile(r"(?P<id>IMG-[A-Za-z0-9-]+)")

PROMPT_HEADINGS = ("可复制提示词", "冻结关键帧提示词", "收尾关键帧提示词")
NONE_PREFIXES = ("无", "待补", "-")


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


def build_plan(episode_dir: Path) -> Dict[str, Any]:
    resolved = resolve_ratio(episode_dir)
    ratio = resolved["ratio"]
    nodes: List[Dict[str, Any]] = []
    index: Dict[str, Dict[str, Any]] = {}
    edges: List[Dict[str, str]] = []

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
                "reference_note": entry["fields"].get("参考", ""),
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
                "reference_field": entry["fields"].get("输入参考图", ""),
            })

    motion_doc = episode_dir / "视频提示词.md"
    if motion_doc.is_file():
        for entry in parse_entries(read_text(motion_doc)):
            add_node({
                "key": entry["id"],
                "kind": "video",
                "role": "motion",
                "title": entry["title"],
                "prompt": pick_prompt(entry),
                "duration": parse_duration(entry["fields"].get("时长")),
                "ratio": detect_ratio(entry, ratio),
                "mode": entry["fields"].get("生成方式", ""),
                "shot": (entry["fields"].get("分镜") or "").strip(),
                "source": "视频提示词.md",
                "reference_field": entry["fields"].get("输入参考图", ""),
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

    # 连线三：输入参考图里已落地的 REF- 槽位
    for node in nodes:
        if node["role"] == "asset":
            continue
        field = node.pop("reference_field", "") or ""
        slots = REF_SLOT.findall(field)
        if slots:
            kinds = {kind.upper() for kind, _, _ in slots}
            node["reference_state"] = "已绑定真实图" if kinds == {"REF"} else (
                "挂图计划" if kinds == {"PLAN"} else "真实图与挂图计划混用")
            node["reference_slots"] = [
                {"kind": kind.upper(), "slot": slot, "order": int(order)}
                for kind, slot, order in slots
            ]
        elif field.lstrip().startswith("无"):
            node["reference_state"] = "创作者选择无参考"
        elif is_absent(field):
            node["reference_state"] = "待补参考图"
        else:
            node["reference_state"] = "待解析"
        node["reference_raw"] = field

    stats = {
        "episode": episode_dir.name,
        "image_nodes": sum(1 for n in nodes if n["kind"] == "image" and n["role"] == "asset"),
        "keyframe_nodes": sum(1 for n in nodes if n["role"] == "keyframe"),
        "video_nodes": sum(1 for n in nodes if n["kind"] == "video"),
        "edges": len(edges),
        "empty_prompts": [n["key"] for n in nodes if not n["prompt"]],
        "dangling_items": sorted({item for n in nodes for item in n.get("missing_items", [])}),
        "aspect_ratio": ratio,
        "ratio_source": resolved["source"],
        "ratio_conflict": resolved["conflict"],
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
    if stats.get("ratio_missing"):
        print("警告：项目档案与视觉设定都没有成片画幅；先与创作者确认画幅并写入档案，不要靠默认值建图",
              file=sys.stderr)
    if stats.get("ratio_conflict"):
        print(f"警告：{stats['ratio_conflict']}；本次关键帧与视频以项目档案为准，请回对应 owner 统一文档",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
