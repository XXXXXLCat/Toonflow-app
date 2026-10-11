#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把画布施工计划导出成一份可导入的画布文件。

一次性建好整集的节点与连线，避免逐个调用画布工具。产出是独立的新画布文件，
不修改任何正在打开的画布；用户主动导入后再由画布正常运行节点逻辑。

用法：
  python3 board_apply.py <project> --episode EP001 --out EP001.canvas.json
  python3 board_apply.py <project> --episode EP001 --out EP001.canvas.json --structure-only
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent))
from board_plan import build_plan, find_episode_dir  # noqa: E402

# 节点类型名与端口，随实际安装的节点包变化；改这里即可对接别的节点实现。
NODE_TYPES = {"image": "remote-comfyuiImageNode", "video": "remote-comfyuiVideoNode"}
SOURCE_HANDLES = {"image": "image", "video": "video"}
TARGET_HANDLE = "in"

COLUMN_X = {"asset": 0, "keyframe": 900, "motion": 1800}
COLUMN_GAP = 620
NAMESPACE = uuid.UUID("6f9619ff-8b86-d011-b42d-00c04fc964ff")


def node_id(key: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"node:{key}"))


def edge_id(source: str, target: str, reason: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"edge:{source}->{target}:{reason}"))


def build_payload(plan: Dict[str, Any], include_references: bool) -> Dict[str, Any]:
    counters = {"asset": 0, "keyframe": 0, "motion": 0}
    nodes: List[Dict[str, Any]] = []

    for node in plan["nodes"]:
        role = node["role"]
        column = COLUMN_X[role]
        position = {"x": column, "y": counters[role] * COLUMN_GAP}
        counters[role] += 1

        data: Dict[str, Any] = {"label": f"{node['key']} · {node['title']}".rstrip(" ·"), "prompt": node["prompt"]}
        if node["kind"] == "image":
            data["model"] = ""
            data["promptModel"] = []
            data["ratio"] = node.get("ratio") or "自适应"
            data["megapixels"] = "1"
            data["rewritePrompt"] = True
        else:
            data["model"] = ""
            data["promptModel"] = []
            data["ratio"] = node.get("ratio") or "16:9"
            data["resolution"] = ""
            data["mode"] = ""
            data["generateAudio"] = True
            data["megapixels"] = "0.9"
            data["rewritePrompt"] = True
            data["turbo"] = True
            if node.get("duration"):
                data["duration"] = node["duration"]

        nodes.append({
            "id": node_id(node["key"]),
            "type": NODE_TYPES[node["kind"]],
            "position": position,
            "data": data,
        })

    edges: List[Dict[str, Any]] = []
    kinds_by_key = {n["key"]: n["kind"] for n in plan["nodes"]}
    for edge in plan["edges"]:
        if edge["reason"] == "图片提示词项" and not include_references:
            continue
        edges.append({
            "id": edge_id(edge["from"], edge["to"], edge["reason"]),
            "source": node_id(edge["from"]),
            "sourceHandle": SOURCE_HANDLES[kinds_by_key[edge["from"]]],
            "target": node_id(edge["to"]),
            "targetHandle": TARGET_HANDLE,
        })

    return {
        "toonflowCanvas": True,
        "nodes": nodes,
        "edges": edges,
        "viewport": {"x": -100, "y": -100, "zoom": 0.3},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="把短剧项目的创作文档导出成画布文件（只读文档，不碰已有画布）")
    parser.add_argument("project", help="项目根目录，或直接指定剧集目录")
    parser.add_argument("--episode", help="剧集目录名，如 EP001；省略时取第一个")
    parser.add_argument("--out", required=True, help="输出画布文件路径")
    parser.add_argument("--structure-only", action="store_true",
                        help="只连结构性关系（分镜）；省略时连上资产图的参考关系")
    args = parser.parse_args()

    root = Path(args.project).expanduser()
    if not root.is_dir():
        raise SystemExit(f"目录不存在：{root}")
    episode_dir = find_episode_dir(root.resolve(), args.episode)
    plan = build_plan(episode_dir)

    stats = plan["stats"]
    if stats["dangling_items"] or stats["empty_prompts"]:
        print("计划不完整，先回对应 owner 修文档：", file=sys.stderr)
        if stats["dangling_items"]:
            print(f"  引用了不存在的条目：{stats['dangling_items']}", file=sys.stderr)
        if stats["empty_prompts"]:
            print(f"  缺可复制提示词：{stats['empty_prompts']}", file=sys.stderr)
        return 2

    payload = build_payload(plan, include_references=not args.structure_only)
    out = Path(args.out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    kinds: Dict[str, int] = {}
    for node in payload["nodes"]:
        kinds[node["type"]] = kinds.get(node["type"], 0) + 1
    print(json.dumps({
        "画布文件": str(out),
        "剧集": episode_dir.name,
        "节点数": len(payload["nodes"]),
        "节点构成": kinds,
        "连线数": len(payload["edges"]),
        "连线范围": "结构性 + 参考" if not args.structure_only else "仅结构性",
        "画幅": stats["aspect_ratio"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
