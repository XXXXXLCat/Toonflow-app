#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把配音本与音色绑定导出成一份可导入的画布文件。

产出内容：
  - 每个人物 1 个音频节点（标签 VOICE-<人物>），带上语音指令与参考文本
  - 音频节点的音频输出 -> 该人物每一句对白所在镜头的视频节点

关键映射链：配音本的 LINE 指向剧本场次（EP001-SC002）；
`分镜.md` 的 SHOT 条目的「来源」字段写明它出自哪个场次；
`视频提示词.md` 的 MOTION 条目的「分镜」字段指向 SHOT。三跳把台词接到镜头。

本脚本只读文档、只写输出的画布 JSON，不修改任何正在打开的画布、不调用供应商。
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from voice_plan import build_plan, find_episode_dir  # noqa: E402

# 节点类型名与端口随实际安装的节点包变化；改这里即可对接别的节点实现。
NODE_TYPES = {"image": "remote-comfyuiImageNode", "video": "remote-comfyuiVideoNode", "audio": "remote-comfyuiAudioNode"}
SOURCE_HANDLES = {"audio": "audio"}
TARGET_HANDLE = "in"

VOICE_COLUMN_X = -900
SHOT_COLUMN_X = 0
MOITION_COLUMN_X = 900
COLUMN_GAP = 640
NAMESPACE = uuid.UUID("6f9619ff-8b86-d011-b42d-00c04fc964ff")

SCENE_TOKEN = __import__("re").compile(r"EP\d+-SC\d+")
FIELD = __import__("re").compile(r"^-\s*(?P<key>[^：:]+)[：:]\s*(?P<value>.*)$")
ENTRY_HEADING = __import__("re").compile(r"^##\s+(?P<id>(?:IMG|SHOT|MOTION)-[A-Za-z0-9-]+)\s*(?:·\s*(?P<title>.*))?$")
LINE_HEADING = __import__("re").compile(r"^###\s+(?P<id>LINE-[A-Za-z0-9-]+)\s*(?:（(?P<scene>EP\d+-SC\d+)）)?\s*$")


def read_text(path: Path) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    raise SystemExit(f"无法解码文件：{path}")


def parse_fields(markdown: str, pattern=ENTRY_HEADING) -> List[Dict[str, Any]]:
    """按 H2 切条目，收集字段区。"""
    entries: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    for raw in markdown.splitlines():
        line = raw.strip()
        heading = pattern.match(line)
        if heading:
            if current is not None:
                entries.append(current)
            current = {"id": heading.group("id"), "fields": {}, "title": (heading.groupdict().get("title") or "")}
            continue
        if current is None:
            continue
        field = FIELD.match(line)
        if field:
            current["fields"][field.group("key").strip()] = field.group("value").strip()
    if current is not None:
        entries.append(current)
    return entries


def parse_roll_lines(markdown: str) -> List[Dict[str, Any]]:
    """读配音本的 LINE 条目：说话人、场次、语气、朗读文本。"""
    lines: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    for raw in markdown.splitlines():
        line = raw.strip()
        heading = LINE_HEADING.match(line)
        if heading:
            if current is not None:
                lines.append(current)
            current = {"id": heading.group("id"), "scene": heading.group("scene") or "", "fields": {}}
            continue
        if current is None:
            continue
        field = FIELD.match(line)
        if field:
            current["fields"][field.group("key").strip()] = field.group("value").strip()
    if current is not None:
        lines.append(current)
    return lines


def parse_roll_cast(markdown: str) -> Dict[str, Dict[str, str]]:
    """读配音本的人物段：声音参考、参考文本、语音指令、别名。"""
    cast: Dict[str, Dict[str, str]] = {}
    current: Optional[str] = None
    for raw in markdown.splitlines():
        line = raw.strip()
        if line.startswith("## 人物"):
            current = line.split("·", 1)[-1].strip()
            cast[current] = {}
            continue
        if current is None:
            continue
        field = FIELD.match(line)
        if field:
            cast[current][field.group("key").strip()] = field.group("value").strip()
    return cast


def scene_to_motions(episode_dir: Path) -> Dict[str, List[str]]:
    """把剧本场次映射到 MOTION 条目：SHOT 的来源写出场次，MOTION 的分镜指向 SHOT。"""
    shot_doc = episode_dir / "分镜.md"
    motion_doc = episode_dir / "视频提示词.md"
    if not shot_doc.is_file() or not motion_doc.is_file():
        return {}
    shot_scene: Dict[str, str] = {}
    for entry in parse_fields(read_text(shot_doc)):
        source = entry["fields"].get("来源", "")
        matched = SCENE_TOKEN.search(source)
        if matched:
            shot_scene[entry["id"]] = matched.group(0)
    result: Dict[str, List[str]] = {}
    for entry in parse_fields(read_text(motion_doc)):
        shot = entry["fields"].get("分镜", "").strip()
        scene = shot_scene.get(shot)
        if scene:
            result.setdefault(scene, []).append(entry["id"])
    return result


def line_to_motion(line: Dict[str, Any], by_scene: Dict[str, List[str]]) -> Optional[str]:
    """一句台词的画布落点：优先取 LINE 字段里显式写的「画布节点」，否则按场次取该场最后一镜。"""
    explicit = line["fields"].get("画布节点", "").strip()
    if explicit.startswith("MOTION-"):
        return explicit
    scene = line["scene"]
    if not scene:
        matched = SCENE_TOKEN.search(line["fields"].get("场次", ""))
        scene = matched.group(0) if matched else ""
    if not scene:
        return None
    motions = by_scene.get(scene, [])
    return motions[-1] if motions else None


def node_id(key: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"node:{key}"))


def edge_id(source: str, target: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"voice:{source}->{target}"))


def build_payload(episode_dir: Path) -> Dict[str, Any]:
    roll_doc = episode_dir / "配音本.md"
    if not roll_doc.is_file():
        raise SystemExit(f"找不到配音本：{roll_doc}")
    markdown = read_text(roll_doc)
    cast = parse_roll_cast(markdown)
    roll_lines = parse_roll_lines(markdown)
    by_scene = scene_to_motions(episode_dir)

    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []
    unresolved: List[Dict[str, str]] = []
    count = 0

    for name in sorted(cast):
        record = cast[name]
        nodes.append({
            "id": node_id(f"VOICE-{name}"),
            "type": NODE_TYPES["audio"],
            "position": {"x": VOICE_COLUMN_X, "y": count * COLUMN_GAP},
            "data": {
                "label": f"VOICE-{name} · {name}",
                # 「待朗读文本」进供应商的 text：参考文本告诉模型参考音频里念的是什么。
                "prompt": record.get("参考文本", ""),
                # 「语音指令」进供应商的 instruction：写身份，不写情绪。
                "instruction": record.get("语音指令", ""),
                "model": "",
                "instructionModel": [],
                "format": "mp3",
                "quality": "",
                "seedMode": "random",
                "seedValue": 0,
            },
        })
        count += 1

    for line in roll_lines:
        speaker = line["fields"].get("说话人", "").strip()
        motion = line_to_motion(line, by_scene)
        if not speaker or not motion:
            unresolved.append({"line": line["id"], "speaker": speaker or "（缺说话人）", "reason": "定位不到视频节点"})
            continue
        edges.append({
            "id": edge_id(f"VOICE-{speaker}", motion),
            "source": node_id(f"VOICE-{speaker}"),
            "sourceHandle": SOURCE_HANDLES["audio"],
            "target": node_id(motion),
            "targetHandle": TARGET_HANDLE,
        })

    return {
        "toonflowCanvas": True,
        "nodes": nodes,
        "edges": edges,
        "viewport": {"x": -100, "y": -100, "zoom": 0.3},
        "_voiceReport": {
            "characters": len(nodes),
            "lines": len(roll_lines),
            "edges": len(edges),
            "unresolved": unresolved,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="把配音本导出成画布文件（只读文档，不碰已有画布）")
    parser.add_argument("project", help="项目根目录，或直接指定剧集目录")
    parser.add_argument("--episode", help="剧集目录名，如 EP001；省略时取第一个")
    parser.add_argument("--out", required=True, help="输出画布文件路径")
    parser.add_argument("--merge", help="与 $short-drama-canvas 导出的画布合并成一份完整画布；两边共用同一套节点 ID")
    args = parser.parse_args()

    root = Path(args.project).expanduser()
    if not root.is_dir():
        raise SystemExit(f"目录不存在：{root}")
    episode_dir = find_episode_dir(root.resolve(), args.episode)
    payload = build_payload(episode_dir)
    report = payload.pop("_voiceReport")

    merged_note = None
    if args.merge:
        merge_path = Path(args.merge).expanduser().resolve()
        if not merge_path.is_file():
            raise SystemExit(f"找不到要合并的画布：{merge_path}")
        base = json.loads(read_text(merge_path))
        existing = {node["id"] for node in base.get("nodes", [])}
        existing_edges = {edge["id"] for edge in base.get("edges", [])}
        # 只追加，不覆盖：同一节点 ID 说明两边指向同一个镜头，取先到的那份。
        added_nodes = [node for node in payload["nodes"] if node["id"] not in existing]
        added_edges = [edge for edge in payload["edges"] if edge["id"] not in existing_edges]
        payload["nodes"] = base.get("nodes", []) + added_nodes
        payload["edges"] = base.get("edges", []) + added_edges
        merged_note = {
            "合并来源": str(merge_path),
            "新增音频节点": len(added_nodes),
            "新增音频连线": len(added_edges),
            "合并后节点总数": len(payload["nodes"]),
            "合并后连线总数": len(payload["edges"]),
        }

    out = Path(args.out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    summary = {
        "画布文件": str(out),
        "剧集": episode_dir.name,
        "音频节点": report["characters"],
        "配音本条目": report["lines"],
        "音频连线": report["edges"],
        "未定位条目": report["unresolved"],
    }
    if merged_note:
        summary["合并"] = merged_note
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if report["unresolved"]:
        print(f"警告：{len(report['unresolved'])} 条台词定位不到视频节点，需在配音本补「画布节点」字段",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
