#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""剪映Cut（jianyingcut）剪辑台控制 MCP Server。

把本地剪辑台的 HTTP 接口包成 MCP 工具，让 agent 能直接驱动时间线：
导入素材 → 挑正片 → 铺轨 → 拼接 → 剪裁，全程不用点浏览器。

设计原则
--------
1. 只读优先：jc_status / jc_project / jc_list_assets 不改任何状态。
2. 会抹掉已有片段的操作必须显式确认：jc_load_episode（覆盖模式）、jc_clear_track、
   以及命令批次里含 clearTrack 的 jc_send_commands，都要求 confirm=true。
   （剪辑台目前**没有撤销**，清轨是真的会丢东西，所以这道闸必要。）
3. 幂等：导入按路径原地引用、重复调用会跳过已导入的源文件；铺一集可放心重跑。
4. 本机回环请求绕开代理：本机设了 HTTP_PROXY 时，连不上会返回错误页而不是抛异常，
   极易被误判成「服务正常」，所以一律 --noproxy 等价处理。
5. 协议：MCP over stdio（JSON-RPC 2.0）。诊断输出走 stderr，stdout 只承载协议。

环境变量
--------
JIANYINGCUT_BASE   剪辑台地址，默认 http://127.0.0.1:4000
JIANYINGCUT_HOME   项目本体目录（app/ 启动脚本 conf mcp/ api/ docs/ 都在它下面）
                   默认 ~/Desktop/06 工具与脚本/剪映Cut
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

VERSION = "1.0.0"
PROTOCOL = "2024-11-05"
SERVER_NAME = "jianyingcut-mcp"

BASE = os.environ.get("JIANYINGCUT_BASE", "http://127.0.0.1:4000").rstrip("/")
HOME_DIR = Path(os.environ.get(
    "JIANYINGCUT_HOME",
    str(Path.home() / "Desktop" / "06 工具与脚本" / "剪映Cut"),
)).expanduser()
LAUNCHER = HOME_DIR / "启动剪映Cut.command"
CONF = HOME_DIR / "jianyingcut.conf"

# 漫剧工程的常用片段目录，写进工具描述里省得 agent 每次去翻
MANJU_PROJECT_ROOT = str(Path.home() / "WorkBuddy/2026-10-05-17-28-54")
MANJU_CLIPS_DIR = f"{MANJU_PROJECT_ROOT}/02_数据/05_视频片段"


def log(*a):
    print(*a, file=sys.stderr)


# ---------------------------------------------------------------- HTTP 层

# 绕开代理：本机回环请求绝不能走 HTTP_PROXY，否则连不上时拿到的是错误页而非异常
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _request(method, path, body=None, timeout=120, base=None):
    url = f"{base or BASE}{path}"
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", "replace")
        try:
            info = json.loads(raw).get("error", {})
            return {"error": {"status": err.code,
                              "code": info.get("code", ""),
                              "message": info.get("message") or f"HTTP {err.code}",
                              "details": info.get("details")}}
        except json.JSONDecodeError:
            return {"error": {"status": err.code, "message": raw[:300]}}
    except Exception as err:  # 连不上 / 超时
        return {"error": {"status": 0, "code": "OFFLINE",
                          "message": f"连不上剪辑台（{base or BASE}）：{err}。先调 jc_start 把它拉起来。"}}


def _is_error(out):
    return isinstance(out, dict) and "error" in out


# ---------------------------------------------------------------- 领域助手

def _load_client():
    """复用项目里的客户端（命名识别只写一份，避免两处漂移）。"""
    api_dir = HOME_DIR / "api"
    if str(api_dir) not in sys.path:
        sys.path.insert(0, str(api_dir))
    try:
        import jianyingcut_client as mod  # noqa: PLC0415
        return mod
    except Exception as err:  # pragma: no cover
        log("warn: 载入 skill 客户端失败", err)
        raise RuntimeError(
            f"找不到 skill 客户端：{api_dir}/jianyingcut_client.py。"
            f"确认 JIANYINGCUT_HOME 指向正确（当前 {HOME_DIR}）。"
        ) from err


def _summarize(project):
    tracks = []
    for t in project.get("tracks", []):
        total = sum(c["out"] - c["in"] for c in t.get("clips", []))
        tracks.append({"id": t["id"], "type": t["type"], "clips": len(t.get("clips", [])),
                       "seconds": round(total, 2),
                       "spans": [f"{c['start']:.2f}~{c['start'] + (c['out'] - c['in']):.2f}"
                                 for c in t.get("clips", [])][:12]})
    groups = {}
    for a in project.get("assets", []):
        key = a.get("group") or "(未分组)"
        groups[key] = groups.get(key, 0) + 1
    return {
        "name": project.get("name"),
        "rev": project.get("rev"),
        "assets": len(project.get("assets", [])),
        "asset_groups": groups,
        "tracks": tracks,
    }


def _recv_conf():
    """从启动器配置里取端口 / 自动导入目录，让 MCP 和启动器口径一致。"""
    out = {}
    try:
        for line in CONF.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"')
    except Exception:
        pass
    return out


def _health(base=None):
    h = _request("GET", "/health", timeout=3, base=base)
    return not _is_error(h) and h.get("status") == "ok"


# ---------------------------------------------------------------- 工具实现

def t_status(_args):
    """检查剪辑台是否在跑；在跑就顺带给出工程摘要。"""
    if not _health():
        conf = _recv_conf()
        return {"running": False,
                "hint": "剪辑台没在运行。调 jc_start 拉起它（首次会自动装依赖并构建前端）。",
                "expected_base": BASE,
                "launcher": str(LAUNCHER),
                "launcher_exists": LAUNCHER.exists(),
                "conf": conf}
    proj = _request("GET", "/api/project")
    if _is_error(proj):
        return proj
    return {"running": True, "base": BASE, "page": f"{BASE}/",
            "project": _summarize(proj.get("project", {}))}


def t_start(args):
    """拉起剪辑台（等价于双击启动器）。已在运行则直接返回。"""
    if _health():
        return {"started": False, "already_running": True, "page": f"{BASE}/"}
    if not LAUNCHER.exists():
        return {"error": {"code": "LAUNCHER_MISSING",
                          "message": f"找不到启动器：{LAUNCHER}。检查 JIANYINGCUT_HOME。"}}

    env = dict(os.environ)
    env["PORT"] = str(urllib.parse.urlparse(BASE).port or 4000)
    env["OPEN_BROWSER"] = "0"  # MCP 场景不需要弹浏览器，要看得用 jc_open 拿地址
    if args.get("import_dir"):
        env["IMPORT_DIR"] = str(args["import_dir"])
    if args.get("import_roots"):
        env["IMPORT_ROOTS"] = str(args["import_roots"])
    env.pop("HTTP_PROXY", None)
    env.pop("http_proxy", None)

    # 启动器末尾有「按任意键」的暂停，非交互调用必须重定向 stdin
    proc = subprocess.Popen(
        ["bash", str(LAUNCHER)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env=env, cwd=str(LAUNCHER.parent), start_new_session=True,
    )

    deadline = time.time() + float(args.get("timeout", 240))
    while time.time() < deadline:
        if _health():
            return {"started": True, "already_running": False, "page": f"{BASE}/",
                    "note": "已就绪。用 jc_open 拿页面地址给人看，或直接开始调 jc_* 工具。"}
        if proc.poll() is not None and not _health():
            # 启动器退出了但服务还没起来 —— 大概率是装依赖/构建失败
            return {"error": {"code": "START_FAILED",
                              "message": f"启动器已退出（码 {proc.returncode}）但服务没起来。"
                                         f"手动跑一次看报错：bash '{LAUNCHER}'"}}
        time.sleep(1.0)
    return {"error": {"code": "START_TIMEOUT",
                      "message": f"等了 {args.get('timeout', 240)} 秒还没就绪。"
                                 f"首次启动可能在装依赖（几分钟），稍后再调 jc_status 看看。"}}


def t_open(args):
    """返回剪辑台的网页地址（可带 import 目录，打开即自动导入）。"""
    url = f"{BASE}/"
    d = args.get("import_dir")
    if d:
        url += "?import=" + urllib.parse.quote(str(d))
    return {"page": url, "running": _health(),
            "note": "把这个地址给对方、或在浏览器打开即可。没在跑就先 jc_start。"}


def t_import_dir(args):
    """按路径原地导入磁盘上已有的素材。不复制文件、幂等。"""
    body = {"root": str(args["root"]), "groupBy": args.get("group_by", "parentFolder")}
    if args.get("groups"):
        body["groups"] = list(args["groups"])
    if args.get("limit"):
        body["limit"] = int(args["limit"])
    out = _request("POST", "/api/assets/import", body, timeout=600)
    if _is_error(out):
        return out
    return {"imported": out.get("imported"), "scanned": out.get("scanned"),
            "skipped": out.get("skipped"), "groups": out.get("groups"),
            "failed": out.get("failed", [])[:10]}


def t_list_assets(args):
    """列素材（可按分组过滤）。只读。"""
    out = _request("GET", "/api/project")
    if _is_error(out):
        return out
    assets = out.get("project", {}).get("assets", [])
    group = args.get("group")
    if group:
        assets = [a for a in assets if (a.get("group") or "") == group]
    return {"count": len(assets),
            "assets": [{"id": a["id"], "name": a["name"], "group": a.get("group"),
                        "duration": a.get("duration"), "size": a.get("size")} for a in assets]}


def t_project(args):
    """读工程状态：轨道、片段位置、素材分组统计。只读。"""
    out = _request("GET", "/api/project")
    if _is_error(out):
        return out
    summary = _summarize(out.get("project", {}))
    if args.get("with_clips"):
        summary["raw_clips"] = [{"clipId": c["id"], "assetId": c["assetId"], "start": c["start"],
                                 "in": c["in"], "out": c["out"]}
                                for t in out["project"]["tracks"] for c in t["clips"]]
    return summary


def t_load_episode(args):
    """把某一集的片段按顺序铺到轨道并拼接。覆盖模式会清空该轨，需要 confirm=true。"""
    append = bool(args.get("append"))
    if not append and not args.get("confirm"):
        return {"needs_confirm": True,
                "message": f"这会先清空 {args.get('track', 'V1')} 轨上的现有片段，且剪辑台没有撤销。"
                           f"确认请重调并带 confirm=true；或改 append=true 追加到已有片段之后。",
                "would_do": {"clips_dir": str(args["clips_dir"]), "episode": args["episode"],
                             "track": args.get("track", "V1"), "mode": args.get("mode", "auto")}}

    client_mod = _load_client()
    c = client_mod.JianyingCutClient(BASE)
    try:
        res = c.load_episode(str(args["clips_dir"]), str(args["episode"]),
                             track=args.get("track", "V1"),
                             mode=args.get("mode", "auto"), append=append)
    except client_mod.JianyingCutError as err:
        return {"error": {"code": "LOAD_FAILED", "message": str(err)}}

    clips = res.get("assets", [])
    kinds = {}
    for a in clips:
        k = client_mod.classify(a.get("name", ""))
        kinds[k[0] if k else "?"] = kinds.get(k[0] if k else "?", 0) + 1
    return {"episode": res["episode"], "clips": res["clips"], "seconds": res["seconds"],
            "track": args.get("track", "V1"),
            "picked": [a["name"] for a in clips],
            "kinds": kinds,
            "first_clip_id": None if not clips else next(
                (x["id"] for t in res["project"]["tracks"] if t["id"] == args.get("track", "V1")
                 for x in t["clips"]), None),
            "note": "已铺好并拼接。要剪的话用 jc_send_commands 下发 splitClip / trimClip / deleteClip。"}


def t_send_commands(args):
    """下发一批编辑命令（原子批次）。含 clearTrack 时需 confirm=true。"""
    commands = args.get("commands")
    if not isinstance(commands, list) or not commands:
        return {"error": {"code": "BAD_ARGS", "message": "commands 必须是非空数组"}}

    destructive = [c for c in commands if isinstance(c, dict) and c.get("type") == "clearTrack"]
    if destructive and not args.get("confirm"):
        return {"needs_confirm": True,
                "message": "批次里含 clearTrack，会清空整条轨且无法撤销。确认请带 confirm=true。",
                "clear_tracks": [c.get("trackId") for c in destructive]}
    if len(commands) > 500:
        return {"error": {"code": "TOO_MANY", "message": "单批最多 500 条命令"}}

    out = _request("POST", "/api/commands",
                   {"commands": commands, "source": args.get("source", "ai")}, timeout=300)
    if _is_error(out):
        return out
    proj = out.get("project", {})
    return {"applied": out.get("applied"), "rev": proj.get("rev"),
            "project": _summarize(proj)}


def t_clear_track(args):
    """清空某条轨道。需要 confirm=true（没有撤销）。"""
    track = args.get("track", "V1")
    if not args.get("confirm"):
        return {"needs_confirm": True,
                "message": f"清空 {track} 轨且无法撤销。确认请带 confirm=true。", "track": track}
    return t_send_commands({"commands": [{"type": "clearTrack", "trackId": track}], "confirm": True})


def t_where_is_manju(_args):
    """给出漫剧工程的片段目录等常用路径，省得每次去翻。只读。"""
    root = Path(MANJU_PROJECT_ROOT)
    clips = Path(MANJU_CLIPS_DIR)
    episodes = []
    if clips.is_dir():
        for d in sorted(clips.iterdir()):
            if d.is_dir() and not d.name.startswith("_"):
                episodes.append({"episode": d.name,
                                 "files": sum(1 for f in d.iterdir()
                                              if f.suffix.lower() in {".mp4", ".mov", ".m4v"})})
    return {"project_root": MANJU_PROJECT_ROOT, "project_root_exists": root.is_dir(),
            "clips_dir": MANJU_CLIPS_DIR, "clips_dir_exists": clips.is_dir(),
            "episodes": episodes,
            "usage": f'jc_load_episode(clips_dir="{MANJU_CLIPS_DIR}", episode="E01", confirm=true)'}


# ---------------------------------------------------------------- 工具表

TOOLS = [
    {"name": "jc_status",
     "description": "检查剪映Cut剪辑台是否在运行；在跑就返回工程摘要（素材数、分组、各轨片段）。只读，永远先调它。",
     "inputSchema": {"type": "object", "properties": {}}},

    {"name": "jc_start",
     "description": "拉起剪辑台（等价于双击启动器，会装依赖/构建前端，首次可能要几分钟），等到就绪才返回。已在运行则直接返回。",
     "inputSchema": {"type": "object", "properties": {
         "import_dir": {"type": "string", "description": "可选：启动时自动导入的目录"},
         "import_roots": {"type": "string", "description": "可选：覆盖允许导入的根目录白名单，逗号分隔"},
         "timeout": {"type": "number", "description": "最长等待秒数，默认 240"}}}},

    {"name": "jc_open",
     "description": "返回剪辑台的网页地址（可直接在浏览器打开）。带上 import_dir 则打开即自动导入该目录。",
     "inputSchema": {"type": "object", "properties": {
         "import_dir": {"type": "string", "description": "可选：页面加载时自动导入的目录"}}}},

    {"name": "jc_which_project",
     "description": "列出漫剧工程的片段目录与各集片段数，并给出可直接复制的调用示例。只读，不知道素材在哪时先调它。",
     "inputSchema": {"type": "object", "properties": {}}},

    {"name": "jc_import_dir",
     "description": "按路径原地导入素材：不复制文件、直接引用磁盘原路径，按第一层文件夹名自动分组，幂等（重复调用跳过已导入的）。只允许导入白名单 IMPORT_ROOTS 内的目录。",
     "inputSchema": {"type": "object", "properties": {
         "root": {"type": "string", "description": "目录或单个文件的绝对路径"},
         "group_by": {"type": "string", "description": "parentFolder（默认，按第一层文件夹分组）或 none"},
         "groups": {"type": "array", "items": {"type": "string"}, "description": "只导入这些分组，如 [\"E01\"]"},
         "limit": {"type": "integer", "description": "单次上限，默认 400"}},
         "required": ["root"]}},

    {"name": "jc_list_assets",
     "description": "列素材库里的素材（可选按分组过滤），带 id/名称/时长。只读。",
     "inputSchema": {"type": "object", "properties": {
         "group": {"type": "string", "description": "只看这一组，如 E05"}}}},

    {"name": "jc_project",
     "description": "读工程状态：各轨片段数与时间跨度、素材分组统计。with_clips=true 时额外返回每个片段的 id 与 in/out（做剪裁前需要它拿 clipId）。只读。",
     "inputSchema": {"type": "object", "properties": {
         "with_clips": {"type": "boolean", "description": "是否返回每个片段的明细，默认 false"}}}},

    {"name": "jc_load_episode",
     "description": "把某一集铺到时间线并拼接：一次完成「导入目录 → 挑出这一集的正片 → 清轨 → 逐条上轨 → 首尾相接」。正片识别认 E##_S###（镜级）与 E##_G##_whole##s（组级），自动排除 multiframe/测试/误存/无音频版。覆盖模式会清空该轨，必须带 confirm=true（没有撤销）；append=true 则追加、不需要确认。",
     "inputSchema": {"type": "object", "properties": {
         "clips_dir": {"type": "string", "description": f"片段根目录，如 {MANJU_CLIPS_DIR}"},
         "episode": {"type": "string", "description": "集号，就是子文件夹名，如 E01 / E05"},
         "track": {"type": "string", "description": "落到哪条轨，默认 V1"},
         "mode": {"type": "string", "description": "auto（默认，有镜级优先）/ shots / groups / all"},
         "append": {"type": "boolean", "description": "true 则追加到该轨已有片段之后，不清轨"},
         "confirm": {"type": "boolean", "description": "覆盖模式必须为 true"}},
         "required": ["clips_dir", "episode"]}},

    {"name": "jc_send_commands",
     "description": "下发一批编辑命令（前后端同一套命令，原子批次：一条不合法整批不生效）。可用命令：addClip{trackId,assetId,start,in?,out?} / moveClip{clipId,start,trackId?} / trimClip{clipId,in?,out?,start?} / splitClip{clipId,at} / deleteClip{clipId} / concatTrack{trackId} / clearTrack{trackId}。参数都是**绝对值**（秒），不是增量。批次里含 clearTrack 时必须带 confirm=true。",
     "inputSchema": {"type": "object", "properties": {
         "commands": {"type": "array", "items": {"type": "object"},
                      "description": "命令数组，例如 [{\"type\":\"splitClip\",\"clipId\":\"…\",\"at\":3.5}]"},
         "source": {"type": "string", "description": "来源标记，默认 ai"},
         "confirm": {"type": "boolean", "description": "批次含 clearTrack 时必须为 true"}},
         "required": ["commands"]}},

    {"name": "jc_clear_track",
     "description": "清空某条轨道。需要 confirm=true —— 剪辑台没有撤销，这是真会丢片段的操作。",
     "inputSchema": {"type": "object", "properties": {
         "track": {"type": "string", "description": "轨道 id，默认 V1"},
         "confirm": {"type": "boolean"}}}},
]

HANDLERS = {
    "jc_status": t_status,
    "jc_start": t_start,
    "jc_open": t_open,
    "jc_which_project": t_where_is_manju,
    "jc_import_dir": t_import_dir,
    "jc_list_assets": t_list_assets,
    "jc_project": t_project,
    "jc_load_episode": t_load_episode,
    "jc_send_commands": t_send_commands,
    "jc_clear_track": t_clear_track,
}


# ---------------------------------------------------------------- MCP 协议层

def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def reply(rid, result):
    send({"jsonrpc": "2.0", "id": rid, "result": result})


def error(rid, code, message):
    send({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}})


def serve():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = req.get("method")
        rid = req.get("id")

        if method == "initialize":
            reply(rid, {"protocolVersion": PROTOCOL,
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": SERVER_NAME, "version": VERSION}})
        elif method in ("notifications/initialized", "initialized"):
            continue
        elif method == "tools/list":
            reply(rid, {"tools": TOOLS})
        elif method == "tools/call":
            params = req.get("params") or {}
            name = params.get("name")
            args = params.get("arguments") or {}
            fn = HANDLERS.get(name)
            if fn is None:
                error(rid, -32601, f"未知工具: {name}")
                continue
            try:
                out = fn(args)
            except Exception as e:
                log("tool error:", name, type(e).__name__, e)
                out = {"error": {"code": "TOOL_ERROR", "message": f"{type(e).__name__}: {e}"}}
            reply(rid, {"content": [{"type": "text",
                                     "text": json.dumps(out, ensure_ascii=False, indent=2)}],
                        "isError": _is_error(out)})
        elif method == "ping":
            reply(rid, {})
        elif rid is not None:
            error(rid, -32601, f"未实现: {method}")


if __name__ == "__main__":
    try:
        serve()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        log("fatal:", type(e).__name__, e)
        sys.exit(1)
