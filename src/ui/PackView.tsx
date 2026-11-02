import { useRef } from 'preact/hooks';
import { askConfirm, evaluation, newEmptyProject, pack, restoreFromBackup, runCheck, saveBackup, saveFile, setState, useApp } from '../app/store';
import { exportFileName, exportGate, type ScopeEval } from '../core/rules';
import { bytesText, FindingList, Mascot } from './common';
import { IconDownload, IconFolder, IconImage } from './icons';

function Tree({ se }: { se: ScopeEval }) {
  const dirs = new Map<string, string[]>();
  for (const e of [...se.entries].sort((a, b) => a.path.localeCompare(b.path, 'ja', { numeric: true }))) {
    const i = e.path.lastIndexOf('/');
    const d = i >= 0 ? e.path.slice(0, i) : '';
    dirs.set(d, [...(dirs.get(d) ?? []), i >= 0 ? e.path.slice(i + 1) : e.path]);
  }
  return (
    <div class="tree" aria-label="ZIP内のツリー">
      <div class="tree-root">
        <IconFolder size={16} /> {se.scope.archiveName}
      </div>
      <ul>
        {[...dirs.entries()].map(([d, files]) => (
          <li key={d}>
            {d && (
              <span class="tree-dir">
                <IconFolder size={16} /> {d}/
              </span>
            )}
            <ul class={d ? 'nested' : ''}>
              {files.map((f) => (
                <li key={f} class="tree-file">
                  <IconImage size={14} /> {f}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ScopePack({ se }: { se: ScopeEval }) {
  const s = useApp();
  const up = exportGate(se, 'upload');
  const work = exportGate(se, 'work');
  const result = s.packResults[se.scope.id];
  const error = s.packErrors[se.scope.id];
  const max = se.scope.template.maxArchiveBytes;
  const ack = !!s.acks[se.scope.id];
  const labelCls = up.label === 'チェック済み' ? 'pass' : up.label === '要確認あり' ? 'warn' : up.label === '指摘あり' ? 'error' : 'unchecked';
  return (
    <section class="card pack-card" aria-labelledby={`pk-${se.scope.id}`}>
      <div class="pack-head">
        <h2 id={`pk-${se.scope.id}`}>{se.scope.archiveName}</h2>
        <span class={`pill pill-${labelCls}`}>{up.label}</span>
      </div>
      <p class="muted">{se.scope.template.name}</p>
      <dl class="facts pack-stats">
        <dt>ファイル数</dt>
        <dd>{se.entries.length}件</dd>
        <dt>完成ZIP（予定）</dt>
        <dd>
          {bytesText(se.zipBytes)}
          {max !== null ? ` ／ 上限 ${max.toLocaleString()} bytes` : ''}
        </dd>
        <dt>格納方式</dt>
        <dd>無圧縮で格納（画像を再エンコードしません）</dd>
      </dl>

      <div class="pack-grid">
        <Tree se={se} />
        <div class="mapping">
          <h3 class="h-small">元の名前 → 出力名</h3>
          <table>
            <thead>
              <tr>
                <th scope="col">元の名前</th>
                <th scope="col">出力名</th>
                <th scope="col">役割</th>
              </tr>
            </thead>
            <tbody>
              {se.entries.map((e) => (
                <tr key={e.refId}>
                  <td class="break">{e.originalName}</td>
                  <td class="mono break">{e.path}</td>
                  <td>{e.roleLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {se.excluded.length > 0 && (
        <details class="excluded">
          <summary>このZIPに含めないもの（{se.excluded.length}件）</summary>
          <ul>
            {se.excluded.map((x) => (
              <li key={x.assetId}>
                {x.originalName}：{x.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      {se.setFindings.length > 0 && <FindingList findings={se.setFindings} />}

      {up.blockers.length > 0 && (
        <div class="banner banner-warn" role="note">
          <div>
            <strong>投稿用の書出しを止めています</strong>
            <ul>
              {up.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
          {se.uncheckedCount > 0 && (
            <button class="btn btn-small" onClick={() => runCheck(se.assetIds)} disabled={!!s.job}>
              この場で検査する
            </button>
          )}
        </div>
      )}
      {up.needsAck && (
        <label class="ack">
          <input type="checkbox" checked={ack} onChange={(e) => setState((st) => ({ acks: { ...st.acks, [se.scope.id]: e.currentTarget.checked } }))} />
          <span>要確認の内容（余白の目安・DPI未確認など）を確認しました。このまま書き出します。</span>
        </label>
      )}

      <div class="pack-actions">
        <button class="btn btn-primary" disabled={!up.allowed || (up.needsAck && !ack) || !!s.job} onClick={() => pack(se.scope.id, 'upload')}>
          <IconDownload /> 投稿用ZIPを作成
        </button>
        <button class="btn" disabled={!work.allowed || !!s.job} onClick={() => pack(se.scope.id, 'work')} title={exportFileName(se, 'work', work)}>
          作業用として保存
        </button>
      </div>
      <p class="muted small">
        保存名 — 投稿用：{exportFileName(se, 'upload', up)} ／ 作業用（{work.label}）：{exportFileName(se, 'work', work)}。ファイル名は端末差を避けるため英数字です（UPLOAD＝投稿用、WORK＝作業用、BACKUP＝バックアップ）。
        {!work.allowed && work.blockers.length ? `（作業用も停止中：${work.blockers.join(' / ')}）` : ''}
      </p>

      {error && (
        <div class="banner banner-error" role="alert">
          <span>ZIPを作れませんでした：{error.message}</span>
          <button class="btn btn-small" onClick={() => pack(se.scope.id, error.mode)} disabled={!!s.job}>
            再試行
          </button>
        </div>
      )}

      {result && (
        <div class="card result" role="status">
          <Mascot kind="packed" alt="箱に封をしたマーモット" size={112} />
          <div>
            <strong>{result.mode === 'upload' ? '投稿用ZIPを作成しました' : '作業用ZIPを作成しました'}</strong>
            <p class="break">{result.fileName}</p>
            <p class="small">
              {bytesText(result.bytes)}・{result.fileCount}件。再展開してSHA-256が元画像と一致することを確認しました。
            </p>
            <button class="btn btn-small" onClick={() => saveFile(result.blob, result.fileName, `pack:${se.scope.id}`)}>
              <IconDownload size={18} /> もう一度保存
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function PackView() {
  const s = useApp();
  const ev = evaluation(s);
  const restoreInput = useRef<HTMLInputElement>(null);
  return (
    <div class="workspace single">
      <div class="main-col">
        <div class="page-head">
          <div class="title-block">
            <h1>梱包</h1>
            <p class="muted">書出し前にZIPの中身・ファイル数・出力名を確認します。チェックしていなくても梱包の確認や作業用保存はできます。</p>
          </div>
        </div>
        {ev.scopeErrors.length > 0 && (
          <div class="banner banner-error" role="alert">
            {ev.scopeErrors.join(' / ')}
          </div>
        )}
        {s.project.assets.length === 0 && (
          <div class="card mascot-card">
            <Mascot kind="waiting" alt="空き箱の横で待つマーモット" size={120} />
            <div>
              <strong>梱包する画像がありません</strong>
              <p class="muted">「画像を追加」「ZIPを読み込む」から読み込めます。</p>
            </div>
          </div>
        )}
        {ev.scopes.map((se) => (
          <ScopePack key={se.scope.id} se={se} />
        ))}

        <section class="card backup" aria-labelledby="h-backup">
          <h2 id="h-backup">保存と復元</h2>
          <p class="muted small">
            「保存」はこのブラウザ内（IndexedDB）に保存します。ブラウザ保存は永続を保証しません
            {s.persistence === true ? '（永続保存を許可済み）' : s.persistence === false ? '（永続保存は許可されませんでした）' : ''}
            。大切な作品はバックアップZIPも保存してください。バックアップZIPは投稿用ZIPとは別物です。
          </p>
          <div class="pack-actions">
            <button class="btn" onClick={saveBackup} disabled={!!s.job}>
              <IconDownload /> バックアップZIPを保存
            </button>
            <button class="btn" onClick={() => restoreInput.current?.click()} disabled={!!s.job}>
              バックアップから復元
            </button>
            <button
              class="btn"
              onClick={() => {
                askConfirm('新しい作品を始めますか？ 端末に保存していない変更は失われます。', '新しい作品を始める', true).then((ok) => ok && newEmptyProject());
              }}
            >
              新しい作品を始める
            </button>
          </div>
          {s.lastBackup && (
            <p class="small">
              作成済み：{s.lastBackup.name}（{bytesText(s.lastBackup.bytes)}）{' '}
              <button class="btn btn-small" onClick={() => saveFile(s.lastBackup!.blob, s.lastBackup!.name, 'backup')}>
                もう一度保存
              </button>
            </p>
          )}
          <input
            ref={restoreInput}
            type="file"
            accept=".zip,application/zip"
            class="sr-only"
            tabIndex={-1}
            aria-label="バックアップZIPを選ぶ"
            data-testid="input-restore"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (!f) return;
              if (!s.project.assets.length) restoreFromBackup(f);
              else askConfirm('現在の作品をバックアップの内容で置き換えますか？', '置き換える', true).then((ok) => {
                  if (ok) restoreFromBackup(f);
                });
            }}
          />
        </section>
      </div>
    </div>
  );
}
