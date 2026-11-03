import { evaluation, openInEditor, roleOps, setAlphaThreshold, setState, setStickerCount, useApp, renameProject } from '../app/store';
import { unsplitSheets } from '../core/sheet';
import type { RoleEval, ScopeEval } from '../core/rules';
import type { AssetRecord } from '../core/types';
import { LINE_TEMPLATE, stickerCountFor } from '../core/templates';
import { FindingList, Mascot, StatusIcon, StatusPill, STATUS_LABEL } from './common';
import { DetailPanel } from './DetailPanel';

export function TargetSettings() {
  const s = useApp();
  const t = LINE_TEMPLATE;
  return (
    <section class="card settings" aria-label="チェックの設定">
      <div class="field">
        <span>チェックする規格</span>
        <strong class="target-name">{t.name}</strong>
      </div>
      <div class="field">
        <label for={`count-${t.id}`}>スタンプ数</label>
        <select id={`count-${t.id}`} value={String(stickerCountFor(t, s.project.settings.stickerCounts))} onChange={(e) => setStickerCount(t.id, Number(e.currentTarget.value))}>
          {(t.allowedStickerCounts ?? []).map((n) => (
            <option value={n}>{n}個</option>
          ))}
        </select>
      </div>
      <div class="field">
        <label for="alpha-th">余白判定のalpha閾値</label>
        <select id="alpha-th" value={String(s.project.settings.alphaThreshold)} onChange={(e) => setAlphaThreshold(Number(e.currentTarget.value))}>
          {[0, 8, 16, 32, 64, 128].map((n) => (
            <option value={n}>alpha &gt; {n}{n === 8 ? '（初期値）' : ''}</option>
          ))}
        </select>
      </div>
      <div class="settings-actions">
        <button class="btn btn-small" onClick={roleOps.suggest} disabled={!s.project.assets.length}>
          名前から役割候補
        </button>
      </div>
      <p class="tpl-note">
        <span class="src src-official">公式条件から作成</span> {t.checkedOn ? `${t.checkedOn}確認の` : ''}LINE Creators Market ガイドライン（通常の静止画スタンプ）に基づく条件です。
        {t.byteConvention ? ` 容量換算：${t.byteConvention}。公式ページは単位換算を明示していません。` : ''}
      </p>
      <p class="tpl-note muted">規格チェックの合格は、LINEの審査合格や著作権の保証ではありません。</p>
    </section>
  );
}

function Card({ asset, label, suggested, roleLabelText }: { asset: AssetRecord; label: string; suggested?: boolean; roleLabelText: string }) {
  const s = useApp();
  const ev = evaluation(s);
  const st = ev.assets[asset.id]?.status ?? 'unchecked';
  const thumb = s.thumbs[asset.id];
  const selected = s.selectedAssetId === asset.id;
  const problems = ev.assets[asset.id]?.findings.filter((f) => f.severity !== 'info').length ?? 0;
  return (
    <button
      class={`card thumb-card st-border-${st} ${selected ? 'selected' : ''}`}
      aria-pressed={selected}
      aria-label={`${label} ${asset.originalName}（${roleLabelText}）：${STATUS_LABEL[st]}${problems ? `、指摘${problems}件` : ''}${suggested ? '、役割は候補' : ''}`}
      onClick={() => setState({ selectedAssetId: selected ? null : asset.id })}
    >
      <span class="thumb-top">
        <span class="thumb-label">{label}</span>
        <StatusIcon status={st} size={22} />
      </span>
      <span class="thumb-img checker">
        {thumb?.url ? <img src={thumb.url} alt="" loading="lazy" /> : <span class="thumb-missing">{thumb === undefined ? '…' : 'プレビューなし'}</span>}
      </span>
      <span class="thumb-name" title={asset.originalName}>
        {asset.originalName}
      </span>
      {suggested && <span class="badge-suggest">候補</span>}
    </button>
  );
}

function RoleSection({ re, scopeId }: { re: RoleEval; scopeId: string }) {
  const s = useApp();
  const ev = evaluation(s);
  const n = re.refs.length;
  const short = Math.max(0, re.min - n);
  const over = re.max !== null ? Math.max(0, n - re.max) : 0;
  const refs = s.filter === 'attention' ? re.refs.filter((r) => ['warn', 'error'].includes(ev.assets[r.assetId]?.status)) : re.refs;
  const need = re.max === re.min ? `${re.min}` : re.max === null ? `${re.min}〜` : `${re.min}〜${re.max}`;
  return (
    <section class="role-section" aria-labelledby={`h-${scopeId}-${re.role.id}`}>
      <h3 id={`h-${scopeId}-${re.role.id}`} class="role-head">
        <span>{re.label}</span>
        <span class="role-count">
          {n}/{need}枚
        </span>
        {short > 0 && <span class="pill pill-error">不足{short}</span>}
        {over > 0 && <span class="pill pill-error">超過{over}</span>}
        <span class="role-spec">{specText(re)}</span>
      </h3>
      <div class="grid">
        {refs.map((r) => (
          <Card key={r.id} asset={r.asset} label={r.outputPath.replace(/^.*\//, '').replace(/\.(png|jpe?g)$/i, '')} suggested={r.suggested} roleLabelText={re.label} />
        ))}
        {s.filter === 'all' &&
          Array.from({ length: short }, (_, i) => (
            <div key={`empty-${i}`} class="card slot-empty" role="note" aria-label={`${re.label}の空き枠（不足）`}>
              <span class="pill pill-error">不足1</span>
              <span class="slot-text">{re.label}の空き枠</span>
            </div>
          ))}
      </div>
    </section>
  );
}

function specText(re: RoleEval): string {
  const r = re.role;
  const parts: string[] = [r.formats.map((f) => f.toUpperCase()).join('/')];
  if (r.dimensions.mode === 'exact') parts.push(`${r.dimensions.width}×${r.dimensions.height}px`);
  if (r.dimensions.mode === 'max') parts.push(`最大${r.dimensions.width}×${r.dimensions.height}px`);
  if (r.maxBytes) parts.push(`${r.maxBytes.toLocaleString()} bytes以下`);
  if (r.transparency === 'required') parts.push('背景透過');
  return parts.join('・');
}

function ScopeBlock({ se, multi }: { se: ScopeEval; multi: boolean }) {
  return (
    <section class="scope" aria-label={se.scope.label}>
      {multi && <h2 class="scope-head">{se.scope.label}</h2>}
      {se.roles.map((re) => (
        <RoleSection key={re.role.id} re={re} scopeId={se.scope.id} />
      ))}
    </section>
  );
}

export function CheckView() {
  const s = useApp();
  const ev = evaluation(s);
  const c = ev.imageCounts;
  const unassigned = s.project.assets.filter((a) => !ev.assets[a.id]?.inScope);
  const shownUnassigned = s.filter === 'attention' ? unassigned.filter((a) => ['warn', 'error'].includes(ev.assets[a.id]?.status)) : unassigned;
  const setFindings = ev.scopes.flatMap((se) => se.setFindings.map((f) => ({ ...f, roleLabel: ev.scopes.length > 1 ? `${se.scope.archiveName}${f.roleLabel ? `／${f.roleLabel}` : ''}` : f.roleLabel })));
  const beforeCheck = c.total === 0 || c.unchecked === c.total;
  const attentionCount = c.warn + c.error;
  const hasSuggested = s.project.refs.some((r) => r.suggested);
  return (
    <div class={`workspace ${s.selectedAssetId ? 'has-detail' : ''}`}>
      <div class="main-col">
        <div class="page-head">
          <div class="title-block">
            <h1>販売前チェック</h1>
            <label class="project-name">
              <span class="sr-only">作品名</span>
              <input value={s.project.name} onInput={(e) => renameProject(e.currentTarget.value)} aria-label="作品名" />
              <span class="muted"> / {c.total}枚</span>
            </label>
          </div>
          <div class="card summary" aria-label="検査結果の集計">
            <div class="sum-images">
              <span class="sum-title">画像</span>
              <span class="sum-item">
                <StatusIcon status="pass" /> <b>{c.pass}</b>枚 合格
              </span>
              <span class="sum-item">
                <StatusIcon status="warn" /> <b>{c.warn}</b>枚 要確認
              </span>
              <span class="sum-item">
                <StatusIcon status="error" /> <b>{c.error}</b>枚 エラー
              </span>
              <span class="sum-item">
                <StatusIcon status="unchecked" /> <b>{c.unchecked}</b>枚 未検査
              </span>
            </div>
            <div class="sum-rules">
              <span class="sum-title">ルール違反</span>
              <span class="sum-item">
                画像 <b>{ev.violationCount}</b>件 ・ セット <b>{ev.setViolationCount}</b>件
              </span>
            </div>
          </div>
          <div class="filters" role="group" aria-label="表示の絞込み">
            <button class={`chip ${s.filter === 'all' ? 'on' : ''}`} aria-pressed={s.filter === 'all'} onClick={() => setState({ filter: 'all' })}>
              すべて <span class="chip-n">{c.total}</span>
            </button>
            <button class={`chip ${s.filter === 'attention' ? 'on' : ''}`} aria-pressed={s.filter === 'attention'} onClick={() => setState({ filter: 'attention' })}>
              要確認だけ <span class="chip-n">{attentionCount}</span>
            </button>
          </div>
        </div>

        <TargetSettings />

        {ev.scopeErrors.length > 0 && (
          <div class="banner banner-error" role="alert">
            {ev.scopeErrors.join(' / ')}
          </div>
        )}

        {(() => {
          const big = unsplitSheets(s.project.assets, s.dims, LINE_TEMPLATE);
          if (!big.length) return null;
          return (
            <div class="banner banner-warn" role="status">
              <span>
                まだ分割していない一覧画像のような大きい画像が{big.length}枚あります。このままではスタンプに使えません。編集タブで分割・縮小できます。
                <span class="small"> 対象：{big.map((a) => a.originalName.length > 24 ? `${a.originalName.slice(0, 14)}…${a.originalName.slice(-8)}` : a.originalName).join('、')}</span>
              </span>
              <span class="banner-actions">
                <button class="btn btn-small btn-primary" onClick={() => openInEditor(big[0].id)}>
                  編集で分割する
                </button>
              </span>
            </div>
          );
        })()}

        {hasSuggested && (
          <div class="banner banner-warn" role="status">
            <span>ファイル名から付けた役割候補があります（カードに「候補」と表示）。内容を確認してから確定してください。</span>
            <span class="banner-actions">
              <button class="btn btn-small btn-primary" onClick={roleOps.confirmAll}>
                候補を確定
              </button>
              <button class="btn btn-small" onClick={roleOps.clearSuggested}>
                候補を解除
              </button>
            </span>
          </div>
        )}

        {(beforeCheck || ev.allClear) && (
          <div class={`card mascot-card ${ev.allClear ? 'clear' : ''}`}>
            {ev.allClear ? (
              <>
                <Mascot kind="checked" alt="検査完了のマーモット" size={120} />
                <div>
                  <strong>全部の機械チェックで指摘ゼロです</strong>
                  <p class="muted">見た目（透過の仕上がり等）は目で確認してください。審査合格の保証ではありません。</p>
                </div>
              </>
            ) : (
              <>
                <Mascot kind="waiting" alt="空き箱の横で待つマーモット" size={120} />
                <div>
                  {c.total === 0 ? (
                    <>
                      <strong>まだ画像がありません</strong>
                      <p class="muted">上の「画像を追加」または「ZIPを読み込む」から始めます。チェックだけ・梱包だけでも使えます。</p>
                    </>
                  ) : (
                    <>
                      <strong>{c.total}枚を読み込みました。まだ検査していません</strong>
                      <p class="muted">下の「検査を実行」で端末内で確認します。画像は変更しません。</p>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {setFindings.length > 0 && (
          <section class="card set-findings" aria-label="セット全体の指摘">
            <h2 class="h-small">セット全体の指摘（{setFindings.length}件）</h2>
            <FindingList findings={setFindings} />
          </section>
        )}

        {ev.scopes.map((se) => (
          <ScopeBlock key={se.scope.id} se={se} multi={ev.scopes.length > 1} />
        ))}

        {shownUnassigned.length > 0 && (
          <section class="role-section" aria-labelledby="h-unassigned">
            <h3 id="h-unassigned" class="role-head">
              <span>未割当・対象外</span>
              <span class="role-count">{unassigned.length}枚</span>
              <span class="role-spec">どの出力ZIPにも入りません。選んで役割を割り当てられます。</span>
            </h3>
            <div class="grid">
              {shownUnassigned.map((a) => (
                <Card key={a.id} asset={a} label="未割当" roleLabelText="未割当" />
              ))}
            </div>
          </section>
        )}

        {s.importNotes.length > 0 && (
          <details class="card import-notes" open>
            <summary>取り込まなかったファイル・注意（{s.importNotes.length}件）</summary>
            <ul>
              {s.importNotes.map((n, i) => (
                <li key={i}>
                  <span class="mono">{n.name}</span>：{n.reason}
                </li>
              ))}
            </ul>
            <button class="btn btn-small" onClick={() => setState({ importNotes: [] })}>
              一覧を消す
            </button>
          </details>
        )}
      </div>
      <DetailPanel />
    </div>
  );
}

export { StatusPill };
