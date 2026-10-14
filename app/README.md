# 剪映Cut · AI 剪辑台

一个**可被 AI 操作**的网页版剪辑台。对标剪映桌面版 / ChatCut 的交互，但把「剪辑动作」全部抽成命令。

**核心判断**：不是「先做网页版剪映，以后再想办法让 AI 用」，而是**命令层先行**。鼠标拖拽和 AI 指令走的是同一条命令总线，唯一真源是一棵状态树。

> AI 发一条指令 → 时间线自动变化 → 秒级可预览

---

## 快速开始

```bash
npm install                 # 安装依赖（首次约几分钟）
npm run dev                 # 开发模式：后端(4000) + 前端(5173) 一起起
# 或单端口模式：后端顺便托管前端产物，只对外一个地址
npm run build && npm run start
```

打开 http://localhost:5173 （单端口模式则直接 http://127.0.0.1:4000）

> 后端需要 `ffmpeg` / `ffprobe` 在 PATH 上。本机已内置，
> 若在别处运行且不在 PATH，用 `FFMPEG_PATH` / `FFPROBE_PATH` 指定。

配置：复制 `.env.example` 为 `.env` 按需修改（不复制也能跑，全部有默认值）。
**真实 `.env` 已在 `.gitignore` 中，不要提交。**

---

## 怎么用

| 操作 | 做法 |
|---|---|
| 导入素材 | 把视频/音频拖到左侧素材库，或点「导入素材」 |
| 加片段 | 从素材库拖到轨道；或双击素材直接追加到主视频轨末尾 |
| 改位置 | 拖片段本体（自动吸附片段边缘与播放头） |
| 裁剪 | 拖片段左/右边缘 |
| 剪切 | 播放头定位 → `S` 或点「分割」；也可双击片段就地分割 |
| 拼接 | 点「拼接」：把该轨片段左对齐、首尾相接 |
| 播放 | 空格；`←` `→` 逐帧；标尺上拖动可走带 |
| 精确编辑 | 右侧属性面板可直接输数值 |
| 命令台 | 底部可直接下发命令 JSON，看到命令流 |

---

## 命令 API（这是「AI 可操作」的入口）

```bash
# 读工程
curl -s localhost:4000/api/project | jq

# 加一个片段
curl -s -X POST localhost:4000/api/commands \
  -H 'Content-Type: application/json' \
  -d '{"commands":[{"type":"addClip","trackId":"V1","assetId":"<id>","start":0}]}'

# 播放头处一刀两段
curl -s -X POST localhost:4000/api/commands \
  -H 'Content-Type: application/json' \
  -d '{"commands":[{"type":"splitClip","clipId":"<id>","at":3.5}]}'

# 拼接（左对齐首尾相接）
curl -s -X POST localhost:4000/api/commands \
  -H 'Content-Type: application/json' \
  -d '{"commands":[{"type":"concatTrack","trackId":"V1"}]}'
```

请求体里的 `source` 默认是 `ai`（没声明身份的调用者按外部 AI 记账）；Web 端会显式传 `user`。
执行结果会通过 SSE 广播给所有连着的页面，所以 AI 改完，浏览器里的时间线**立刻**就变了，不需要刷新。

广播载荷里还带着「这次变了什么、是谁改的」，所以 AI 下的命令会以 `远端 · <命令描述>` 的形式
出现在页面底部的命令台里，和用户自己的操作并排可见 —— 做了什么都看得见，这是命令层可审计的地方。

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/project` | 读当前工程状态 |
| POST | `/api/commands` | 执行一批命令（原子：一条不合法整体不生效） |
| GET | `/api/events` | SSE，工程变更推送（含 20s 心跳） |
| POST | `/api/assets` | 上传素材（multipart，字段名 `file`），返回元数据 |
| **POST** | **`/api/assets/import`** | **按路径原地导入**，不复制文件，按第一层文件夹名自动分组 |
| GET | `/api/assets` | 列出素材 |
| GET | `/api/import-roots` | 允许按路径导入的根目录白名单 |
| GET | `/health` `/ready` | 健康检查 / 就绪检查 |

### 按路径原地导入 —— 接入已有工程

不想把别的工程的素材复制一份进来，就直接引用磁盘上的原文件：

```bash
curl -s -X POST localhost:4000/api/assets/import \
  -H 'Content-Type: application/json' \
  -d '{"root":"/path/to/02_数据/05_视频片段","groupBy":"parentFolder"}'
```

- **不复制文件**：素材 URL 指向原路径（`/imported/0/...`），不占双份磁盘；
  那边重新生成片段后，编辑器刷新就能看到新版。
- **自动分组**：相对根目录的第一层文件夹名就是分组名，所以 `E01/` `E02/` 一进来就是分好的，
  左侧素材库按组折叠、每组可「整组加入」到主视频轨。
- **幂等**：已导入过的源文件会被跳过，同一个目录可以放心重复调用。
- **安全**：只允许读 `.env` 里 `IMPORT_ROOTS` 列出的目录（默认 `$HOME/WorkBuddy`），
  越界返回 403 并附带允许的根目录清单。

### 一键把一集铺到时间线（给外部工程调用）

配合 `~/.workbuddy/skills/jianyingcut/references/api/jianyingcut_client.py`：

```bash
python3 jianyingcut_client.py episode "/path/to/02_数据/05_视频片段" E05
# → E05：8 段 · 79.52s · 已落到 V1
```

它一口气做完「导入目录 → 挑出正片 → 清轨 → 逐条 addClip → concatTrack」。
正片识别认这套命名：`E##_S###`（镜级）与 `E##_G##_whole##s`（组级），
自动排除 `multiframe` / `_测试` / `_误存` / `_无音频版`；两种约定并存时 `mode=auto` 优先镜级。

### 命令清单

| 命令 | 语义 |
|---|---|
| `addClip` | 把素材放到轨道某位置。位置被占用时自动向右顺延，不会叠在一起 |
| `moveClip` | 改位置，可跨轨道 |
| `trimClip` | 改入点/出点（`in`/`out`/`start` 全是**绝对值**，命令因此可重放、易被 AI 生成） |
| `splitClip` | 在时间线绝对时刻 `at` 处一刀两段，越界会报 422 而不是静默失败 |
| `deleteClip` | 删除片段 |
| `concatTrack` | 该轨片段左对齐首尾相接 |
| `clearTrack` | 清空该轨 |

---

## 验证

```bash
npm run samples    # 生成三份演示素材到 samples/（没有素材可拖时先跑这个）
npm run check      # 领域逻辑 12 项：剪切/拼接/吸附/原子性/浮点精度（不需要起服务）
npm run typecheck  # 前后端 + shared 三包类型检查
npm run smoke      # 端到端：真起服务、真生成视频、真上传、真走命令、真连 SSE
```

`npm run smoke` 需要后端已在运行。

### 已实测通过的链路

| 项 | 结果 |
|---|---|
| 上传 → ffprobe 探测 → ffmpeg 抽帧 | 1280×720 / 4.0s / 缩略图已生成；纯音频正确跳过缩略图 |
| 双击素材追加到主视频轨 | V1 出现 `left:0px w:240px`（4s × 60px/s） |
| 素材拖到 A1 音轨 | `left:60px w:360px`（落点 1s，时长 6s） |
| 鼠标拖动片段改位置 | 第三段 `240px → 480px`（4s → 8s） |
| 鼠标拖右边缘裁剪 | `w:180px → w:121.98px`（3.0s → 2.03s） |
| 播放头定位 + 分割 | V1 3 段 → 4 段，切点 2.75s 与播放头一致 |
| 播放跨过片段空隙 | 4.0s 处的空白自动跳到 8.0s 继续播，不卡死 |
| **外部 AI 发命令 → 页面自动同步** | curl 发 `splitClip`，**未刷新页面** V1 由 2 段变 3 段 |
| 远端命令进命令流 | 命令台出现 `chip ai · 远端 · 拼接轨道 V1（左对齐首尾相接）` |
| 非法命令 | 越界分割返回 `422 SPLIT_OUT_OF_RANGE` 且带 `requestId` |

---

## 目录结构

```
shared/          前后端同构的领域层（唯一真源）
  src/domain.ts    数据模型 + 时间计算
  src/commands.ts  命令定义
  src/reducer.ts   命令 → 新状态（纯函数，前后端跑同一份）
  test/check.mjs   领域逻辑自检
server/          Node 22 + Fastify + TypeScript
  src/config/      环境变量集中校验，启动即快速失败
  src/shared/      类型化错误、结构化日志、全局错误处理
  src/media/       素材上传 → ffprobe 探测 → ffmpeg 抽帧（仓储 / 服务 / 控制器三层）
  src/project/     工程状态、命令执行、SSE 广播
web/             React 19 + Vite + TypeScript + Zustand
  src/core/        命令总线、状态树、类型化 API 客户端、SSE 订阅
  src/features/    素材库 / 预览 / 时间线 / 属性 / 命令台（按功能组织）
scripts/smoke.mjs  端到端冒烟
```

样式是手写 CSS 变量（`web/src/styles.css`），没引 UI 框架 —— 时间线要精确 px 计算，工具类反而碍事。

---

## 本期范围

**已实现**：素材导入与探测 · 多轨时间线 · 拖拽落位 · 拖动改位置 · 拖边缘裁剪 · 吸附 · 播放头与逐帧 · 分割 · 拼接 · 多轨预览（换源式连续播放，自动跳过空隙）· 命令 API + SSE · 远端命令审计 · 命令台 · 属性面板

**明确未做**（避免过度设计）：

| 项 | 计划 |
|---|---|
| 导出 MP4 | M2（后端 ffmpeg 拼接 + 任务队列 + 进度） |
| 自然语言 → 命令 | M3（需要一个 LLM 翻译层，本期只做结构化命令） |
| 多轨画面叠加合成 | M2 |
| 转场 / 滤镜 / 变速 / 关键帧 / 字幕 | M2+ |
| 撤销重做 | M2（状态树已按可快照的方式组织，几乎白送） |
| 云工程 / 协作 / 账号 | M4 |

**已知短板**：预览换源切换瞬间会有极短的画面跳变（未做双播放器预载），M2 处理。

---

## 设计取舍

| 问题 | 选择 | 理由 |
|---|---|---|
| 状态权威 | 本地乐观 + 服务端权威 + SSE 对齐 | 拖拽必须跟手；AI 改动必须能进来 |
| 冲突处理 | 交互中 / 请求在飞时**攒着**远端状态，空闲后一次性对齐 | 避免把用户正在做的操作冲掉 |
| 时间线渲染 | DOM 绝对定位 | 几十个片段足够，拖拽与调试图省最多；上千再换 canvas |
| 预览 | 单个 `<video>`，跨片段边界换源 | 拼接立刻可见，无需先渲染文件 |
| 帧同步 | 采样视频自身 `currentTime`，不累加计时器 | 长时间播放不漂移 |
| 命令参数 | 全部绝对值，不用增量 | 幂等、可重放、AI 好生成 |
| 写操作重试 | **不自动重试** `POST /api/commands` | `addClip` 不幂等，重试会凭空多出片段 |
| 持久化 | 一个 JSON 文件，原子 rename | M1 不需要数据库，零迁移成本 |
| 远端变更 | SSE 推「新状态 + 造成变更的命令」 | 既能让 UI 对齐，又能把 AI 的操作记进命令流 |

---

## 几个容易踩的坑（已经踩过并修好）

- **Fastify 的 `setErrorHandler` 必须在 `register` 路由之前设置**。子上下文在创建时会快照父级错误处理器，
  放后面设置的话路由仍然走默认处理器 —— 表现是自定错误码被吞掉、一律变成 500 + 默认错误体。
- **npm 装包慢可以换镜像**：`npm install --registry=https://registry.npmmirror.com`。
- 传输中的文件（`server/media/`）与工程状态（`server/data/`）都在 `.gitignore` 里，别手滑提交上去。
