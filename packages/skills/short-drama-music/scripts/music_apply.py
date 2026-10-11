#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把配乐本导出成一份可导入的画布文件：每个乐段 1 个音乐节点。

音乐节点只负责「出曲子」——它是产出物，供剪辑铺轨，**不与任何节点连线**。
视频节点上的音频输入留给人物参考音频（$short-drama-voice），不接配乐。

本脚本只读《配乐本.md》，只写输出的画布 JSON，不修改任何正在打开的画布、不调用供应商。
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from music_plan import find_episode_dir, read_text  # noqa: E402

import re

NODE_TYPE_MUSIC = "remote-comfyuiMusicNode"
COLUMN_X = -1800
COLUMN_GAP = 620
NAMESPACE = uuid.UUID("6f9619ff-8b86-d011-b42d-00c04fc964ff")

SEGMENT_HEADING = re.compile(r"^##\s+(?P<id>MUSIC-[A-Za-z0-9-]+)\s*(?:·\s*(?P<title>.*))?$")
FIELD = re.compile(r"^-\s*(?P<key>[^：:]+)[：:]\s*(?P<value>.*)$")
DURATION_NUM = re.compile(r"(\d+(?:\.\d+)?)")
STYLE_BLOCK = re.compile(r"^```(?:text)?\s*$")


def parse_segments(markdown: str) -> List[Dict[str, Any]]:
    """按 H2 切乐段，收字段区与围栏里的风格描述。"""
    segments: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    in_fence = False
    fence_lines: List[str] = []
    for raw in markdown.splitlines():
        line = raw.rstrip()
        if STYLE_BLOCK.match(line.strip()):
            if in_fence:
                if current is not None and fence_lines:
                    current["style"] = "\n".join(fence_lines).strip()
                fence_lines = []
                in_fence = False
            else:
                in_fence = True
            continue
        if in_fence:
            fence_lines.append(line)
            continue
        heading = SEGMENT_HEADING.match(line.strip())
        if heading:
            if current is not None:
                segments.append(current)
            current = {
                "id": heading.group("id"),
                "title": (heading.group("title") or "").strip(),
                "fields": {},
                "style": "",
            }
            continue
        if current is None:
            continue
        field = FIELD.match(line.strip())
        if field:
            current["fields"][field.group("key").strip()] = field.group("value").strip()
    if current is not None:
        segments.append(current)
    return segments


def parse_duration(value: str) -> Optional[int]:
    matched = DURATION_NUM.search(value or "")
    if not matched:
        return None
    return int(round(float(matched.group(1))))


def node_id(key: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"node:{key}"))


def build_payload(episode_dir: Path) -> Dict[str, Any]:
    doc = episode_dir / "配乐本.md"
    if not doc.is_file():
        raise SystemExit(f"找不到配乐本：{doc}")
    segments = parse_segments(read_text(doc))

    nodes: List[Dict[str, Any]] = []
    incomplete: List[Dict[str, str]] = []
    for index, segment in enumerate(segments):
        style = segment.get("style", "").strip() or segment["fields"].get("风格描述", "").strip()
        duration = parse_duration(segment["fields"].get("时长", ""))
        missing: List[str] = []
        if not style:
            missing.append("风格描述")
        if duration is None:
            missing.append("时长")
        if missing:
            incomplete.append({"segment": segment["id"], "missing": missing})
        nodes.append({
            "id": node_id(segment["id"]),
            "type": NODE_TYPE_MUSIC,
            "position": {"x": COLUMN_X, "y": index * COLUMN_GAP},
            "data": {
                "label": f"{segment['id']} · {segment['title']}".rstrip(" ·"),
                "style": style,
                # 一律纯旋律：歌词字段留空。
                "lyrics": "",
                "model": "",
                "styleModel": [],
                "lyricsModel": [],
                "format": "mp3",
                "quality": "",
                "maxDuration": duration if duration is not None else 60,
                "seedMode": "random",
                "seedValue": 0,
            },
        })

    return {
        "toonflowCanvas": True,
        "nodes": nodes,
        "edges": [],
        "viewport": {"x": -100, "y": -100, "zoom": 0.3},
        "_musicReport": {
            "segments": len(segments),
            "incomplete": incomplete,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="把配乐本导出成画布文件（只读文档，不碰已有画布）")
    parser.add_argument("project", help="项目根目录，或直接指定剧集目录")
    parser.add_argument("--episode", help="剧集目录名，如 EP001；省略时取第一个")
    parser.add_argument("--out", required=True, help="输出画布文件路径")
    parser.add_argument("--merge", help="与既有画布合并：三个脚本共用同一套节点 ID，音乐节点只追加不覆盖")
    args = parser.parse_args()

    root = Path(args.project).expanduser()
    if not root.is_dir():
        raise SystemExit(f"目录不存在：{root}")
    episode_dir = find_episode_dir(root.resolve(), args.episode)
    payload = build_payload(episode_dir)
    report = payload.pop("_musicReport")

    merged_note = None
    if args.merge:
        merge_path = Path(args.merge).expanduser().resolve()
        if not merge_path.is_file():
            raise SystemExit(f"找不到要合并的画布：{merge_path}")
        base = json.loads(read_text(merge_path))
        existing = {node["id"] for node in base.get("nodes", [])}
        added = [node for node in payload["nodes"] if node["id"] not in existing]
        payload["nodes"] = base.get("nodes", []) + added
        payload["edges"] = base.get("edges", [])
        merged_note = {
            "合并来源": str(merge_path),
            "新增音乐节点": len(added),
            "合并后节点总数": len(payload["nodes"]),
            "合并后连线总数": len(payload["edges"]),
        }

    out = Path(args.out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    summary = {
        "画布文件": str(out),
        "剧集": episode_dir.name,
        "音乐节点": report["segments"],
        "未接通": report["incomplete"],
    }
    if merged_note:
        summary["合并"] = merged_note
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if report["incomplete"]:
        print(f"警告：{len(report['incomplete'])} 个乐段缺字段，节点已按缺省值建出但生成前要补齐："
              f"{[item['segment'] for item in report['incomplete']]}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
