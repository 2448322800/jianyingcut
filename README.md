# 剪映Cut · AI 可操作的本地剪辑台

一个**命令层先行**的网页剪辑台：把一个目录里已有的视频片段铺到多轨时间线上，拖拽排序、裁剪、
分割、一键拼接，同时对外提供命令 API + SSE，让 AI 或别的本地工程直接驱动它。

- 页面：<http://127.0.0.1:4000/>
- 端口约定：**4000**（本工具）· 8790 漫剧工作台 · 8765 视频分发助手 · 9222 即梦调试 —— 不要混用。

---

## 一、文件分类总览

```
剪映Cut/
├── app/                          ← ① 程序本体（唯一一份，别处不再有副本）
│   ├── shared/                     前后端同构的领域层（命令 + reducer，全项目的心脏）
│   ├── server/                     Node 22 + Fastify 5 + zod（后端）
│   │   ├── src/                     源码
│   │   ├── data/project.json        ★工程状态（时间线内容就在这，每条命令实时落盘）
│   │   └── media/                   上传素材缓存（按 UUID 存）
│   ├── web/                        React 19 + Vite + Zustand（前端，含 dist 构建产物）
│   ├── scripts/                    自检与冒烟脚本
│   ├── samples/                    示例素材
│   ├── docs/                       项目文档与截图
│   └── node_modules/               依赖（已装好，双击即可用）
│
├── 启动剪映Cut.command            ← ② 启动器（双击即用）
├── 停止剪映Cut.command              停止器
├── jianyingcut.conf                 ★唯一配置源：端口 / APP_DIR / 自动导入目录 / 白名单
│
├── mcp/jianyingcut_mcp.py         ← ③ WorkBuddy 连接器（MCP over stdio，零依赖）
├── api/jianyingcut_client.py      ← ④ 外部调用客户端（纯标准库，给漫剧工程等调用）
│
├── .backup-归并前-20261014/       ← ⑤ 本次归并的备份（含归并前后的工程状态与旧脚本）
└── README.md                      ← 你正在看的这份
```

**只有一份真身**：应用代码、连接器、客户端各一份。连接器在 WorkBuddy 的注册路径
（`~/.workbuddy/mcp-servers/jianyingcut-mcp/jianyingcut_mcp.py`）是一个**指向 `mcp/` 的符号链接**，
不是副本。技能目录 `~/.workbuddy/skills/jianyingcut/` 里只剩 `SKILL.md` 和两个转发用薄指针。

---

## 二、素材在哪（本工具不动它）

片段素材始终在**漫剧工程**里，剪辑台只是**原地引用**，不做拷贝：

```
/Users/caoyouqing/WorkBuddy/2026-10-05-17-28-54/02_数据/05_视频片段/
├── E01/ … E12/    正片片段（E01_S001 镜级 / E05_G02_whole12s 组级，两种命名都认）
├── _测试/          调试产物
└── _废弃_*/        返工产物
```

- 左侧素材库按**目录第一层**自动分组 → 打开就是 E01 / E02 …（本次核对：75 个素材、12 组、0 个未分组）。
- 素材文件被移动或改名后，需重新「目录导入」一次。
- 白名单由 `jianyingcut.conf` 的 `IMPORT_ROOTS` 控制（默认 `$HOME/WorkBuddy`）。

---

## 三、怎么用

### 给人用

1. 双击 `启动剪映Cut.command` → 自动编译、起服务、打开浏览器（首次已装好依赖，秒起）。
2. 双击 `停止剪映Cut.command` → 关掉服务。
3. 从漫剧工作台进：顶栏「剪辑台」按钮（第一下启动并打开；已在跑时再点一下会问你要不要关闭）。

### 给 AI / 别的工程用（三条通路，任选）

```bash
# ① 外部调用客户端（推荐，纯标准库）
python3 api/jianyingcut_client.py state
python3 api/jianyingcut_client.py episode "/路径/05_视频片段" E01 --track V1
python3 api/jianyingcut_client.py cmd '{"type":"splitClip","clipId":"…","at":3.5}'

# ② 裸 HTTP
curl -s --noproxy '*' http://127.0.0.1:4000/health
curl -s -X POST http://127.0.0.1:4000/api/commands \
     -H 'Content-Type: application/json' \
     -d '{"commands":[{"type":"concatTrack","trackId":"V1"}]}'

# ③ WorkBuddy 连接器（jc_* 工具，需先在连接器管理页点「信任」）
```

> **本机回环请求必须绕开系统代理**：装了 HTTP_PROXY 时，连接被拒会返回一个错误页而 curl 仍算成功，
> 很容易把「服务没起来」误判成「服务正常」。客户端已在代码里显式绕开；手敲 curl 记得加 `--noproxy '*'`。

---

## 四、配置与排障

| 想改什么 | 改哪 |
|---|---|
| 端口 / 自动导入目录 / 导入白名单 | `jianyingcut.conf`（改完下次启动生效） |
| 程序本体位置 | `jianyingcut.conf` 里的 `APP_DIR` |
| 素材目录 | 漫剧工程自己的 `project.json`（剪辑台只读它） |

**双击没反应？** 先看终端窗口的提示。最常见的是 PATH 里没有 node（nvm 装在 `~/.zshrc`，
而 `.command` 跑在 `/bin/bash` 下读不到）—— 启动器已内置兜底，会自动去找 nvm / Homebrew /
`~/.workbuddy/binaries` 里的 node。

**AI 改完时间线，页面没变？** 命令是实时落盘的；刷新页面即可。远端（AI）改的会在右下角命令台标成「远端 · xxx」。

---

## 五、本次归并做了什么（2026-10-14）

之前这套东西散在 7 个地方，其中最糟的是 `~/.workbuddy/skills/jianyingcut/references/app/`
有一份 **128M 的完整代码副本**，而且**真正在跑的是那一份**，跟工作区源码各走各的，改一边另一边不知道。

| 项 | 归并前 | 归并后 |
|---|---|---|
| 应用代码 | 两份（工作区源码 + skill 里 128M 镜像） | **一份**：`app/` |
| 在跑的是哪份 | skill 镜像（数据也跟着在里面） | `app/` |
| 工程状态 | 两份 `project.json`（镜像那份才是活数据） | **一份**：`app/server/data/` |
| 上传素材 | 两份 `media/`，且**内容不是同一批** | **取并集合并**成一份 |
| 启动器 / 配置 | 在 skill `references/launcher/` | 项目根目录 |
| 连接器 | skill 里一份 + mcp-servers 一份（两份） | `mcp/` 一份 + 符号链接 |
| 文档 | 散在工作区 docs/ 与 app/docs/ | `app/docs/` 一份 |

**素材位置未动**：归并后 75 个素材的 `sourcePath` 全部仍指向 `02_数据/05_视频片段`，逐条核对一致。

**回滚**：`.backup-归并前-20261014/` 里有归并前后的两份 `project.json`、旧启动器/连接器/客户端源码、
旧的工作台 `app.py`，以及被退役的 skill 镜像（在废纸篓：`~/.Trash/jianyingcut-references-app-20261014-*`）。
