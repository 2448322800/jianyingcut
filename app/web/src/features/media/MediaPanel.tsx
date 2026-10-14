import { useEffect, useMemo, useRef, useState } from 'react';
import { clipEnd, type Asset, type Command } from '@ai-cut/shared';
import { api, mediaUrl } from '../../core/api.js';
import { ASSET_MIME } from '../../core/dnd.js';
import { humanDuration } from '../../core/format.js';
import { useEditor } from '../../core/store.js';

/**
 * 素材库：导入 → 分组展示 → 拖到时间线。
 *
 * 两条导入路径：
 *  - 上传：把文件复制进工作区，适合零散素材
 *  - 目录导入：直接引用磁盘上已有工程的素材（漫剧那套片段），不复制文件，
 *    按第一层文件夹名自动分组 —— 所以漫剧的 E01 / E02 一进来就是分好的
 */

const ACCEPT = 'video/*,audio/*';
const UNGROUPED = '(未分组)';

export function MediaPanel(): React.JSX.Element {
  const project = useEditor((s) => s.project);
  const uploads = useEditor((s) => s.uploads);
  const addUpload = useEditor((s) => s.addUpload);
  const importFromPath = useEditor((s) => s.importFromPath);
  const dispatch = useEditor((s) => s.dispatch);

  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showImport, setShowImport] = useState(false);
  const [importPath, setImportPath] = useState('');
  const [roots, setRoots] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const assets = project?.assets ?? [];

  const grouped = useMemo(() => {
    const map = new Map<string, Asset[]>();
    for (const asset of assets) {
      const key = asset.group && asset.group.length > 0 ? asset.group : UNGROUPED;
      const list = map.get(key);
      if (list) list.push(asset);
      else map.set(key, [asset]);
    }
    // 排序：正常分组按自然序（E01 < E02 < E10）→ 下划线开头的内部目录（_测试/_废弃）→ 未分组
    const rank = (key: string): number => {
      if (key === UNGROUPED) return 2;
      if (key.startsWith('_')) return 1;
      return 0;
    };
    return [...map.entries()].sort(([a], [b]) => {
      const diff = rank(a) - rank(b);
      if (diff !== 0) return diff;
      return a.replace(/^_+/, '').localeCompare(b.replace(/^_+/, ''), 'zh-Hans-CN', { numeric: true });
    });
  }, [assets]);

  useEffect(() => {
    if (!showImport) return;
    void api
      .importRoots()
      .then((data) => setRoots(data.roots ?? []))
      .catch(() => setRoots([]));
  }, [showImport]);

  const takeFiles = (files: FileList | null): void => {
    if (!files) return;
    for (const file of Array.from(files)) addUpload(file);
  };

  const runImport = (path: string): void => {
    const target = path.trim();
    if (!target) return;
    setBusy(true);
    void importFromPath(target).finally(() => {
      setBusy(false);
      setImportPath('');
    });
  };

  /** 双击条目：直接追加到第一条视频轨的末尾，省一次拖拽 */
  const appendToFirstVideoTrack = (asset: Asset): void => {
    if (!project) return;
    const track = project.tracks.find((t) => t.type === 'video');
    if (!track) return;
    const end = track.clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0);
    const command: Command = { type: 'addClip', trackId: track.id, assetId: asset.id, start: end };
    dispatch([command]);
  };

  /** 把一整组按顺序追加到主视频轨 —— 漫剧「一集拼起来」的常见动作 */
  const appendGroup = (list: Asset[]): void => {
    if (!project || list.length === 0) return;
    const track = project.tracks.find((t) => t.type === 'video');
    if (!track) return;

    let cursor = track.clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0);
    const commands: Command[] = [];
    for (const asset of list) {
      commands.push({ type: 'addClip', trackId: track.id, assetId: asset.id, start: cursor });
      cursor = Math.round((cursor + asset.duration) * 1000) / 1000;
    }
    dispatch(commands);
  };

  const renderItem = (asset: Asset): React.JSX.Element => (
    <div
      key={asset.id}
      className="media-item"
      draggable
      data-asset-name={asset.name}
      onDragStart={(event) => {
        event.dataTransfer.setData(ASSET_MIME, asset.id);
        event.dataTransfer.effectAllowed = 'copy';
      }}
      onDoubleClick={() => appendToFirstVideoTrack(asset)}
      title={`${asset.name}\n拖到时间线，或双击追加到主视频轨末尾`}
    >
      <div className="media-thumb">
        {asset.thumbUrl ? (
          <img src={mediaUrl(asset.thumbUrl)} alt="" draggable={false} />
        ) : (
          <span className="media-thumb-audio">音频</span>
        )}
      </div>
      <div className="media-info">
        <span className="media-name">{asset.name}</span>
        <span className="media-meta">
          {humanDuration(asset.duration)}
          {asset.width > 0 && ` · ${asset.width}×${asset.height}`}
        </span>
      </div>
    </div>
  );

  return (
    <section
      className={`media${dragOver ? ' drag-over' : ''}`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragOver(false);
        takeFiles(event.dataTransfer.files);
      }}
    >
      <header className="panel-head">
        <h2>素材库</h2>
        <span className="panel-sub">
          {assets.length} 项
          {grouped.length > 1 && ` · ${grouped.length} 组`}
        </span>
      </header>

      <div className="media-actions">
        <button type="button" className="primary" onClick={() => inputRef.current?.click()}>
          导入素材
        </button>
        <button
          type="button"
          onClick={() => setShowImport((v) => !v)}
          title="直接引用磁盘上已有目录里的素材，不复制文件"
        >
          目录
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(event) => {
            takeFiles(event.target.files);
            event.target.value = '';
          }}
        />
      </div>

      {showImport && (
        <div className="media-import">
          <div className="media-import-row">
            <input
              type="text"
              value={importPath}
              placeholder="目录绝对路径，如 …/02_数据/05_视频片段"
              onChange={(e) => setImportPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runImport(importPath);
              }}
              disabled={busy}
            />
            <button type="button" className="primary" onClick={() => runImport(importPath)} disabled={busy || !importPath.trim()}>
              {busy ? '导入中…' : '导入'}
            </button>
          </div>
          <div className="media-import-roots">
            {roots.length === 0 ? (
              <span className="media-import-hint">没有可导入的根目录，在 .env 里配 IMPORT_ROOTS</span>
            ) : (
              <>
                <span className="media-import-hint">可导入：</span>
                {roots.map((root) => (
                  <button key={root} type="button" className="chipbtn" onClick={() => setImportPath(root)} title={root}>
                    {root.split('/').filter(Boolean).pop()}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      <div className="media-list">
        {assets.length === 0 && uploads.length === 0 && (
          <p className="media-hint">
            把视频或音频文件拖进来，
            <br />
            或点「目录」直接引用已有工程的素材。
          </p>
        )}

        {grouped.map(([key, list]) => {
          const isCollapsed = collapsed.has(key);
          return (
            <div key={key} className="media-group">
              <div className="media-group-head">
                <button
                  type="button"
                  className="media-group-toggle"
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                >
                  <span className={`caret${isCollapsed ? ' collapsed' : ''}`} />
                  <span className="media-group-name">{key}</span>
                  <span className="media-group-count">{list.length}</span>
                </button>
                <button
                  type="button"
                  className="media-group-add"
                  onClick={() => appendGroup(list)}
                  title="按当前顺序整组追加到主视频轨"
                >
                  整组加入
                </button>
              </div>
              {!isCollapsed && <div className="media-group-body">{list.map(renderItem)}</div>}
            </div>
          );
        })}

        {uploads.map((task) => (
          <div key={task.id} className={`media-item upload ${task.status}`}>
            <div className="media-thumb">
              <span className="media-thumb-audio">
                {task.status === 'error' ? '失败' : `${Math.round(task.ratio * 100)}%`}
              </span>
            </div>
            <div className="media-info">
              <span className="media-name">{task.name}</span>
              <span className="media-meta">
                {task.status === 'error' ? task.message : task.status === 'done' ? '已完成' : '上传中…'}
              </span>
              {task.status === 'uploading' && (
                <div className="progress">
                  <div className="progress-bar" style={{ width: `${task.ratio * 100}%` }} />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
