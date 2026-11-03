import { useEffect, useRef, useState } from 'preact/hooks';
import { askConfirm, deleteAsset, evaluation, exportOriginal, replaceAssetFile, roleOps, setState, templatesMap, useApp } from '../app/store';
import { factsValid } from '../core/facts';
import { CONTAINER_LABEL, PNG_COLOR_TYPE } from '../core/sniff';
import { roleLabel } from '../core/templates';
import { FindingList, StatusPill } from './common';
import { IconClose, IconDownload, IconLeft, IconRight, IconSwap, IconTrash } from './icons';

function useObjectUrl(blob: Blob | undefined, key: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [key]);
  return url;
}

export function DetailPanel() {
  const s = useApp();
  const ev = evaluation(s);
  const asset = s.project.assets.find((a) => a.id === s.selectedAssetId);
  const url = useObjectUrl(asset?.blob, asset ? `${asset.id}:${asset.version}` : 'none');
  const replaceInput = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [addChoice, setAddChoice] = useState('');

  useEffect(() => {
    if (asset) closeRef.current?.focus({ preventScroll: true });
  }, [asset?.id]);

  if (!asset) {
    return (
      <aside class="detail detail-empty" aria-label="詳細">
        <p class="muted">画像を選ぶと、実測値・要求値・出典つきの指摘と、役割・並び順・差替えの操作がここに出ます。</p>
        <p class="muted small">チェックでは画像のバイト・寸法・透明度・DPI・名前を変更しません。</p>
      </aside>
    );
  }

  const ae = ev.assets[asset.id];
  const facts = s.project.facts[asset.id];
  const f = factsValid(facts, asset.sha256, s.project.settings.alphaThreshold) ? facts : undefined;
  const tmap = templatesMap(s);
  const scopeTemplates = new Map(ev.scopes.map((se) => [se.scope.template.id, se.scope]));
  const myRefs = s.project.refs.filter((r) => r.assetId === asset.id);
  const roleOptions = ev.scopes.flatMap((se) =>
    se.roles.map((re) => ({ value: `${se.scope.template.id}|${re.role.id}`, label: ev.scopes.length > 1 ? `${se.scope.template.name}／${re.label}` : re.label })),
  );
  const uniqueOptions = roleOptions.filter((o, i) => roleOptions.findIndex((x) => x.value === o.value) === i);

  const outputPathFor = (refId: string) => {
    for (const se of ev.scopes) for (const re of se.roles) for (const r of re.refs) if (r.id === refId) return r.outputPath;
    return null;
  };

  return (
    <aside class="detail" aria-label={`詳細：${asset.originalName}`}>
      <div class="detail-head">
        <div>
          <div class="muted small">選択中の画像</div>
          <h2 class="detail-name">{asset.originalName}</h2>
        </div>
        <button ref={closeRef} class="icon-btn" aria-label="詳細を閉じる" onClick={() => setState({ selectedAssetId: null })}>
          <IconClose />
        </button>
      </div>
      <StatusPill status={ae?.status ?? 'unchecked'} />

      <div class={`preview bg-${s.previewBg}`}>{url ? <img src={url} alt={`${asset.originalName} のプレビュー`} /> : null}</div>
      <div class="seg" role="radiogroup" aria-label="プレビューの背景">
        {(
          [
            ['checker', '市松'],
            ['white', '白'],
            ['black', '黒'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="radio" aria-checked={s.previewBg === k} class={`seg-btn ${s.previewBg === k ? 'on' : ''}`} onClick={() => setState({ previewBg: k })}>
            {l}
          </button>
        ))}
      </div>

      <dl class="facts">
        <dt>元ファイル名</dt>
        <dd class="break">{asset.originalName}</dd>
        {asset.sourcePath !== asset.originalName && (
          <>
            <dt>取込元</dt>
            <dd class="break">{asset.sourcePath}</dd>
          </>
        )}
        <dt>容量</dt>
        <dd>{asset.size.toLocaleString()} bytes</dd>
        {f ? (
          <>
            <dt>形式（中身）</dt>
            <dd>
              {CONTAINER_LABEL[f.container]}
              {f.png ? `・${PNG_COLOR_TYPE[f.png.colorType] ?? f.png.colorType} ${f.png.bitDepth}bit` : ''}
              {f.png?.hasIccp ? '・ICCあり' : ''}
            </dd>
            {f.width !== undefined && (
              <>
                <dt>寸法</dt>
                <dd>
                  {f.width} × {f.height} px
                </dd>
              </>
            )}
            <dt>DPI</dt>
            <dd>{f.dpi.status === 'ok' ? `${f.dpi.x.toFixed(2)} × ${f.dpi.y.toFixed(2)}（${f.dpi.source} ${f.dpi.raw}）` : `未確認：${f.dpi.reason}`}</dd>
            {f.alpha && (
              <>
                <dt>透明画素</dt>
                <dd>
                  {f.alpha.translucentPixels.toLocaleString()} / {f.alpha.totalPixels.toLocaleString()}
                  {f.alpha.zeroAlphaPixels === f.alpha.totalPixels ? '（完全透明）' : f.alpha.translucentPixels === 0 ? '（完全不透明）' : ''}
                </dd>
                <dt>余白（推定）</dt>
                <dd>{f.alpha.margins ? `上${f.alpha.margins.top} 右${f.alpha.margins.right} 下${f.alpha.margins.bottom} 左${f.alpha.margins.left} px（alpha>${f.alpha.threshold}）` : '内容なし'}</dd>
              </>
            )}
          </>
        ) : (
          <>
            <dt>検査</dt>
            <dd>未検査</dd>
          </>
        )}
        {asset.derivedFrom && (
          <>
            <dt>作成元</dt>
            <dd class="break">
              {asset.derivedFrom.originalName}（{asset.derivedFrom.op === 'split' ? '分割' : '背景透過'}：{asset.derivedFrom.detail}）
            </dd>
          </>
        )}
        <dt>SHA-256</dt>
        <dd class="mono break small">{asset.sha256}</dd>
        {asset.replacedNames?.length ? (
          <>
            <dt>差替え</dt>
            <dd class="break">{asset.version - 1}回（前：{asset.replacedNames.join('、')}）</dd>
          </>
        ) : null}
      </dl>

      <h3 class="h-small">指摘（{ae?.findings.filter((x) => x.severity !== 'info').length ?? 0}件）</h3>
      <FindingList findings={ae?.findings ?? []} empty={<p class="muted">{f ? '指摘はありません。' : '未検査です。「検査を実行」で確認します。'}</p>} />

      <h3 class="h-small">役割と出力名</h3>
      {myRefs.length === 0 && <p class="muted">役割が未割当です。</p>}
      <ul class="refs">
        {myRefs.map((r) => {
          const inScope = scopeTemplates.has(r.templateId) && ev.scopes.some((se) => se.scope.template.id === r.templateId && se.roles.some((x) => x.role.id === r.roleId));
          const t = tmap.get(r.templateId);
          const role = t?.roles.find((x) => x.id === r.roleId);
          const out = outputPathFor(r.id);
          return (
            <li key={r.id} class="ref">
              {inScope ? (
                <label class="field">
                  <span>役割{r.suggested ? '（候補）' : ''}</span>
                  <select
                    value={`${r.templateId}|${r.roleId}`}
                    onChange={(e) => {
                      const [tid, rid] = e.currentTarget.value.split('|');
                      roleOps.change(r.id, tid, rid);
                    }}
                  >
                    {uniqueOptions.map((o) => (
                      <option value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <p class="muted small">
                  現在の対象外：{t?.name ?? r.templateId}／{role ? roleLabel(role) : r.roleId}
                </p>
              )}
              {out && (
                <label class="field">
                  <span>出力名（{out}）</span>
                  <input
                    placeholder="命名プリセットを使う"
                    value={r.nameOverride ?? ''}
                    onChange={(e) => roleOps.rename(r.id, e.currentTarget.value)}
                    aria-label={`出力名を変更（現在 ${out}）`}
                  />
                </label>
              )}
              <div class="ref-actions">
                {inScope && (
                  <>
                    <button class="btn btn-small" onClick={() => roleOps.move(r.id, -1)} aria-label="前へ移動">
                      <IconLeft size={18} /> 前へ
                    </button>
                    <button class="btn btn-small" onClick={() => roleOps.move(r.id, 1)} aria-label="後へ移動">
                      後へ <IconRight size={18} />
                    </button>
                  </>
                )}
                <button class="btn btn-small" onClick={() => roleOps.remove(r.id)}>
                  役割から外す
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {uniqueOptions.length > 0 && (
        <div class="add-role">
          <label class="field">
            <span>役割を追加（同じ画像を複数の役割で使えます）</span>
            <select value={addChoice} onChange={(e) => setAddChoice(e.currentTarget.value)}>
              <option value="">選んでください</option>
              {uniqueOptions
                .filter((o) => !myRefs.some((r) => `${r.templateId}|${r.roleId}` === o.value))
                .map((o) => (
                  <option value={o.value}>{o.label}</option>
                ))}
            </select>
          </label>
          <button
            class="btn btn-small"
            disabled={!addChoice}
            onClick={() => {
              const [tid, rid] = addChoice.split('|');
              roleOps.add(asset.id, tid, rid);
              setAddChoice('');
            }}
          >
            追加
          </button>
        </div>
      )}

      <div class="detail-actions">
        <button class="btn btn-block" onClick={() => replaceInput.current?.click()} disabled={!!s.job}>
          <IconSwap /> 画像を差し替え
        </button>
        <button class="btn btn-block" onClick={() => exportOriginal(asset.id)}>
          <IconDownload /> 元画像を書き出す
        </button>
        <p class="muted small center">チェックでは画像を変更しません。分割・背景透過は「編集」タブで行えます（結果は新しい画像として追加）。外部で修正した画像は「画像を差し替え」で読み込めます（役割と順序は維持）。</p>
        <button
          class="btn btn-block btn-danger"
          onClick={() => {
            askConfirm(`「${asset.originalName}」をこの作品から外しますか？ 元のファイルは変わりません。`, '作品から外す', true).then((ok) => ok && deleteAsset(asset.id));
          }}
        >
          <IconTrash /> 作品から外す
        </button>
      </div>
      <input
        ref={replaceInput}
        type="file"
        accept="image/png,image/jpeg,.png,.jpg,.jpeg,image/*"
        class="sr-only"
        tabIndex={-1}
        aria-label="差し替える画像"
        data-testid="input-replace"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (file) replaceAssetFile(asset.id, file);
        }}
      />
    </aside>
  );
}
