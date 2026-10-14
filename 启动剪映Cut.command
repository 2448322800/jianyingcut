#!/bin/bash
# 《剪映Cut》启动器 —— 双击即用
# 只起一个进程（后端顺便托管前端产物），单端口对外，方便被别的系统当外部平台调用。

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$HERE/jianyingcut.conf"

# 先记下调用方传进来的环境变量，读完配置后它们优先 —— 外部系统调用时可以动态覆盖
ENV_APP_DIR="${APP_DIR:-}"
ENV_PORT="${PORT:-}"
ENV_IMPORT_DIR="${IMPORT_DIR:-}"
ENV_IMPORT_ROOTS="${IMPORT_ROOTS:-}"
ENV_OPEN_BROWSER="${OPEN_BROWSER:-}"

# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"

# 程序本体目录：优先调用方环境变量 → conf 里的 APP_DIR → 本文件同级的 app/
APP_DIR="${ENV_APP_DIR:-${APP_DIR:-$HERE/app}}"

PORT="${ENV_PORT:-${PORT:-4000}}"
IMPORT_DIR="${ENV_IMPORT_DIR:-${IMPORT_DIR:-}}"
IMPORT_ROOTS="${ENV_IMPORT_ROOTS:-${IMPORT_ROOTS:-$HOME/WorkBuddy}}"
OPEN_BROWSER="${ENV_OPEN_BROWSER:-${OPEN_BROWSER:-1}}"

echo "《剪映Cut》启动中…"
echo "  程序目录：$APP_DIR"
echo "  端口：    $PORT"

# 双击运行时暂停一下让人看清输出；被脚本/CI 调用时不阻塞
pause() {
  [ -t 0 ] && read -n 1 -s -r -p "${1:-按任意键关闭…}"
  return 0
}

fail() {
  echo
  echo "✗ $1"
  echo
  pause "按任意键关闭…"
  exit 1
}

# 健康检查必须校验响应内容，不能只看 curl 的退出码 ——
# 装了代理 / 网关（HTTP_PROXY 之类）时，连接被拒也会返回一个错误页而 curl 依然算成功，
# 只看退出码会把「服务没起来」误判成「已在运行」。
health_ok() {
  curl -s -m "${1:-1}" --noproxy '*' "http://127.0.0.1:$PORT/health" 2>/dev/null \
    | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'
}

# ── PATH 补全 ─────────────────────────────────────────────
# 双击 .command 时环境来自 Finder/launchd，PATH 通常很干净；而 node 多半是 nvm 装的、
# 只写在 ~/.zshrc 里 —— 本脚本跑在 /bin/bash 下读不到，于是「找不到 node」直接退出。
# 这里把常见位置补进来（已有就不重复加）。
for d in "$HOME/.nvm/versions/node/current/bin" \
         "$HOME/.nvm/versions/node"/*/bin \
         "$HOME/.workbuddy/binaries/node/versions"/*/bin \
         /opt/homebrew/bin /usr/local/bin; do
  if [ -x "$d/node" ]; then
    case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac
  fi
done
export PATH

# ── 环境检查 ──────────────────────────────────────────────
command -v node >/dev/null 2>&1 || fail "找不到 node（$PATH 里都没有）。请先安装 Node 20 以上（推荐 22）。"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node 版本过低（当前 $(node -v)），需要 20 以上。"

command -v ffmpeg >/dev/null 2>&1 || echo "  ⚠ PATH 上没有 ffmpeg，素材探测会失败。装一个或设置 FFMPEG_PATH。"

cd "$APP_DIR" || fail "进不去程序目录：$APP_DIR"

# ── 依赖 ──────────────────────────────────────────────────
if [ ! -d node_modules ]; then
  echo "  首次运行，安装依赖（几分钟）…"
  npm install --registry=https://registry.npmmirror.com || npm install || fail "依赖安装失败。"
fi

# ── 构建 ──────────────────────────────────────────────────
echo "  编译共享领域层…"
npm run build:shared >/dev/null 2>&1 || fail "shared 编译失败，跑 npm run build:shared 看详细报错。"

if [ ! -f web/dist/index.html ]; then
  echo "  构建前端产物（只做一次）…"
  npm run build --workspace @ai-cut/web >/dev/null 2>&1 || fail "前端构建失败。"
fi

# ── 已经在跑就不重复起 ────────────────────────────────────
if health_ok; then
  echo "  服务已在运行，直接打开页面。"
else
  echo "  拉起服务…"
  HOST=127.0.0.1 PORT="$PORT" IMPORT_ROOTS="$IMPORT_ROOTS" \
    nohup ./node_modules/.bin/tsx server/src/index.ts >>"$HERE/jianyingcut.log" 2>&1 &
  echo $! >"$HERE/jianyingcut.pid"

  for i in $(seq 1 40); do
    sleep 0.5
    if health_ok; then
      echo "  服务就绪（pid $(cat "$HERE/jianyingcut.pid")）"
      break
    fi
    if [ "$i" -eq 40 ]; then
      echo
      echo "✗ 启动超时。最后 20 行日志："
      tail -n 20 "$HERE/jianyingcut.log" 2>/dev/null
      pause "按任意键关闭…"
      exit 1
    fi
  done
fi

# ── 打开页面 ──────────────────────────────────────────────
URL="http://127.0.0.1:$PORT/"
if [ -n "$IMPORT_DIR" ] && [ -d "$IMPORT_DIR" ]; then
  # 把导入目录带过去，页面一打开左边就是分好的素材
  ENCODED="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$IMPORT_DIR" 2>/dev/null || echo "$IMPORT_DIR")"
  URL="${URL}?import=${ENCODED}"
  echo "  自动导入：$IMPORT_DIR"
fi

echo
echo "  剪辑台地址：$URL"
echo "  停服务：    双击「停止剪映Cut.command」"
echo

if [ "$OPEN_BROWSER" = "1" ]; then
  open "$URL"
fi

pause "按任意键关闭本窗口（服务继续在后台跑）…"
