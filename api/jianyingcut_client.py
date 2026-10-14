#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
《剪映Cut》外部调用客户端 —— 纯标准库，零依赖。

给「一站式ai漫剧工具」这类工程流用：把已经生成好的片段铺到时间线上、
按集拼接、下发任意剪辑命令，全程不用碰浏览器。

用法（Python）：

    from jianyingcut_client import JianyingCutClient
    c = JianyingCutClient()                                  # 默认 http://127.0.0.1:4000
    c.wait_ready()                                       # 等剪辑台起来
    c.load_episode(CLIPS_DIR, "E01")                     # 把 E01 一集铺到 V1 并拼接
    print(c.state()["project"]["tracks"][0]["clips"])

用法（命令行）：

    python3 jianyingcut_client.py state
    python3 jianyingcut_client.py import "/path/to/05_视频片段"
    python3 jianyingcut_client.py episode "/path/to/05_视频片段" E01 --track V1
    python3 jianyingcut_client.py cmd '{"type":"concatTrack","trackId":"V1"}'
    python3 jianyingcut_client.py open          # 只打印页面地址

命名约定（本客户端认这套，漫剧工程就是这套）：

    E01_S001.mp4 … E01_S015.mp4          镜级片段（一镜一条）
    E05_G01_whole12s.mp4 … G07b_…        组级片段（一组一条，九宫格整段生成）
    *_multiframe / *_测试* / *_误存* / *_无音频版   调试与返工产物，一律不算正片

一集到底用哪种，用 mode 控制：'auto'（默认）镜级优先、没有再退组级。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE = "http://127.0.0.1:4000"

# ── 命名解析 ────────────────────────────────────────────────
_SHOT_RE = re.compile(r"^E(\d+)_S(\d+)", re.IGNORECASE)
_GROUP_RE = re.compile(r"^E(\d+)_G(\d+)([a-z]?)_whole(\d+)", re.IGNORECASE)
# 调试 / 返工 / 变体产物：默认不当成正片
_NOISE_RE = re.compile(r"multiframe|_测试|_误存|_无音频版|智能多帧|九宫格整图", re.IGNORECASE)


def classify(name: str) -> tuple[str, tuple] | None:
    """
    把文件名分类成 ('shot'|'group', 排序键)。认不出来返回 None。
    排序键保证 E01_S002 < E01_S010（数字按数值比，不按字符串比）。
    """
    if _NOISE_RE.search(name):
        return None

    shot = _SHOT_RE.match(name)
    if shot:
        return "shot", (int(shot.group(1)), int(shot.group(2)), "")

    group = _GROUP_RE.match(name)
    if group:
        return "group", (int(group.group(1)), int(group.group(2)), group.group(3).lower())

    return None


def pick_clips(assets: list[dict], mode: str = "auto") -> list[dict]:
    """
    从素材里挑出属于「正片」的片段并排好序。

    mode:
      'shots'  —— 只要镜级（E##_S###）
      'groups' —— 只要组级（E##_G##_whole）
      'auto'   —— 有镜级就用镜级，没有才用组级（默认）
      'all'    —— 全要（结果里组级排在镜级之后，注意可能重复素材）
    """
    shots, groups = [], []
    for asset in assets:
        kind = classify(asset.get("name", ""))
        if kind is None:
            continue
        which, key = kind
        (shots if which == "shot" else groups).append((key, asset))

    shots.sort(key=lambda x: x[0])
    groups.sort(key=lambda x: x[0])

    if mode == "shots":
        chosen = shots
    elif mode == "groups":
        chosen = groups
    elif mode == "all":
        chosen = shots + groups
    else:  # auto
        chosen = shots if shots else groups

    return [asset for _, asset in chosen]


# ── 客户端 ──────────────────────────────────────────────────
class JianyingCutError(RuntimeError):
    """剪辑台返回的业务错误，message 是可直接展示给用户的中文文案。"""

    def __init__(self, message: str, status: int = 0, code: str = "", details=None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.details = details


class JianyingCutClient:
    def __init__(self, base: str = DEFAULT_BASE, timeout: float = 300.0):
        self.base = base.rstrip("/")
        self.timeout = timeout

    # ── 底层 ────────────────────────────────────────────────
    def _request(self, method: str, path: str, body=None):
        url = f"{self.base}{path}"
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8", "replace")
            try:
                payload = json.loads(raw)
                info = payload.get("error", {})
                raise JianyingCutError(
                    info.get("message") or f"HTTP {err.code}",
                    status=err.code,
                    code=info.get("code", ""),
                    details=info.get("details"),
                ) from None
            except json.JSONDecodeError:
                raise JianyingCutError(f"HTTP {err.code}: {raw[:200]}", status=err.code) from None
        except urllib.error.URLError as err:
            raise JianyingCutError(
                f"连不上剪辑台（{self.base}）。先双击项目里的「启动剪映Cut.command」，或进 app/ 跑 npm run dev 起服务。原因：{err.reason}",
            ) from None

    # ── 只读 ────────────────────────────────────────────────
    def health(self) -> dict:
        return self._request("GET", "/health")

    def state(self) -> dict:
        return self._request("GET", "/api/project")

    def import_roots(self) -> list[str]:
        return self._request("GET", "/api/import-roots").get("roots", [])

    def assets(self) -> list[dict]:
        return self.state()["project"]["assets"]

    def tracks(self) -> list[dict]:
        return self.state()["project"]["tracks"]

    def page_url(self, import_dir: str | None = None) -> str:
        """给人点开的页面地址。带上 import_dir 的话一打开左边就是那个目录的素材。"""
        url = f"{self.base}/"
        if import_dir:
            url += "?import=" + urllib.parse.quote(import_dir)
        return url

    # ── 写 ──────────────────────────────────────────────────
    def send_commands(self, commands: list[dict], source: str = "ai") -> dict:
        """下发一批命令。批次是原子的：任何一条不合法，整批都不生效。"""
        if not commands:
            return self.state()
        return self._request("POST", "/api/commands", {"commands": commands, "source": source})

    def command(self, **kwargs) -> dict:
        """下发单条命令，例如 command(type='concatTrack', trackId='V1')"""
        return self.send_commands([kwargs])

    def import_dir(self, root: str, groups: list[str] | None = None) -> dict:
        """
        按路径导入磁盘上已有的素材。不复制文件、幂等，重复调用同一个目录只会跳过已导入的。
        目录第一层子文件夹名自动成为分组名。
        """
        body: dict = {"root": root, "groupBy": "parentFolder"}
        if groups:
            body["groups"] = groups
        return self._request("POST", "/api/assets/import", body)

    def clear_track(self, track: str = "V1") -> dict:
        return self.command(type="clearTrack", trackId=track)

    def concat_track(self, track: str = "V1") -> dict:
        return self.command(type="concatTrack", trackId=track)

    def split_at(self, clip_id: str, at: float) -> dict:
        return self.command(type="splitClip", clipId=clip_id, at=round(at, 3))

    def delete_clip(self, clip_id: str) -> dict:
        return self.command(type="deleteClip", clipId=clip_id)

    # ── 组合动作 ────────────────────────────────────────────
    def wait_ready(self, timeout: float = 30.0, interval: float = 0.5) -> dict:
        """等服务起来。启动器刚拉起时用得上。"""
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            try:
                return self.health()
            except JianyingCutError as err:
                last = err
                time.sleep(interval)
        raise JianyingCutError(f"等了 {timeout:.0f} 秒剪辑台还是没起来。{last}")

    def load_episode(
        self,
        clips_dir: str,
        episode: str,
        track: str = "V1",
        mode: str = "auto",
        append: bool = False,
    ) -> dict:
        """
        把某一集的片段按顺序铺到轨道上并拼接 —— 漫剧工程流里最常用的一个动作。

        clips_dir  片段根目录，例如 …/02_数据/05_视频片段
        episode    集号，例如 "E01"（就是它的子文件夹名）
        track      落到哪条轨，默认 V1
        mode       'auto' | 'shots' | 'groups' | 'all'，见 pick_clips
        append     False（默认）= 先清空该轨再铺；True = 追加到该轨已有片段之后

        步骤：导入目录 → 挑出这一集的正片 → （可选清轨）→ 逐条 addClip → concatTrack
        """
        episode = episode.upper()
        self.import_dir(clips_dir, groups=[episode])

        assets = [a for a in self.assets() if (a.get("group") or "") == episode]
        clips = pick_clips(assets, mode)
        if not clips:
            raise JianyingCutError(
                f"{episode} 里没有可用的正片片段（已排除了 multiframe / 测试 / 误存 / 无音频版）。"
                f"该组现有 {len(assets)} 个文件，检查一下命名是不是 E{episode[1:]}_S### 或 _G##_whole##s。",
            )

        commands: list[dict] = []
        if not append:
            commands.append({"type": "clearTrack", "trackId": track})

        cursor = 0.0
        if append:
            for existing in self.tracks():
                if existing["id"] != track:
                    continue
                for clip in existing["clips"]:
                    cursor = max(cursor, clip["start"] + (clip["out"] - clip["in"]))
            cursor = round(cursor, 3)

        for asset in clips:
            commands.append(
                {"type": "addClip", "trackId": track, "assetId": asset["id"], "start": cursor},
            )
            cursor = round(cursor + float(asset["duration"]), 3)

        commands.append({"type": "concatTrack", "trackId": track})

        result = self.send_commands(commands)
        return {
            "episode": episode,
            "clips": len(clips),
            "mode": "shots" if mode != "groups" and classify(clips[0]["name"])[0] == "shot" else mode,
            "seconds": round(cursor, 2),
            "project": result.get("project", {}),
            "assets": clips,
        }


# ── 命令行 ──────────────────────────────────────────────────
def _main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="《剪映Cut》命令行客户端")
    parser.add_argument("--base", default=DEFAULT_BASE, help=f"剪辑台地址，默认 {DEFAULT_BASE}")
    sub = parser.add_subparsers(dest="action", required=True)

    sub.add_parser("state", help="打印工程状态摘要")
    sub.add_parser("open", help="打印页面地址")

    p_import = sub.add_parser("import", help="按路径导入素材")
    p_import.add_argument("root")
    p_import.add_argument("--groups", nargs="*", default=None)

    p_ep = sub.add_parser("episode", help="把一集铺到轨道并拼接")
    p_ep.add_argument("clips_dir")
    p_ep.add_argument("episode")
    p_ep.add_argument("--track", default="V1")
    p_ep.add_argument("--mode", default="auto", choices=["auto", "shots", "groups", "all"])
    p_ep.add_argument("--append", action="store_true")

    p_cmd = sub.add_parser("cmd", help="下发一条命令（JSON）")
    p_cmd.add_argument("json")

    args = parser.parse_args(argv)
    client = JianyingCutClient(args.base)

    try:
        if args.action == "state":
            project = client.state()["project"]
            print(f"工程 {project['name']} · rev {project['rev']} · 素材 {len(project['assets'])} 个")
            for track in project["tracks"]:
                total = sum(c["out"] - c["in"] for c in track["clips"])
                print(f"  {track['id']} ({track['type']})  {len(track['clips'])} 段 · {total:.1f}s")
        elif args.action == "open":
            print(client.page_url())
        elif args.action == "import":
            res = client.import_dir(args.root, args.groups)
            print(f"导入 {res['imported']} 个（扫描 {res['scanned']}，跳过 {res['skipped']}）")
            for group, count in sorted(res.get("groups", {}).items()):
                print(f"  {group}: {count}")
        elif args.action == "episode":
            res = client.load_episode(
                args.clips_dir, args.episode, track=args.track, mode=args.mode, append=args.append,
            )
            print(f"{res['episode']}：{res['clips']} 段 · {res['seconds']}s · 已落到 {args.track}")
            print(f"页面：{client.page_url()}")
        elif args.action == "cmd":
            client.send_commands([json.loads(args.json)])
            print("已下发")
    except JianyingCutError as err:
        print(f"✗ {err.message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
