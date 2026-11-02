import { useEffect, useRef, useState } from 'preact/hooks';
import {
  askConfirm,
  bundlesMap,
  downloadText,
  removeUserBundle,
  removeUserTemplate,
  saveUserBundle,
  saveUserTemplate,
  setState,
  setTarget,
  templatesMap,
  toast,
  useApp,
} from '../app/store';
import type { BundleTemplate, CheckRole, CheckTemplate, ImageFormat } from '../core/types';
import {
  BUILTIN_BUNDLES,
  BUILTIN_CHECK_TEMPLATES,
  cloneBundle,
  cloneCheckTemplate,
  isBuiltin,
  newCheckTemplate,
  newRole,
  parseTemplateJson,
  roleLabel,
  templateToJson,
  uniqueId,
  validateBundleTemplate,
  validateCheckTemplate,
} from '../core/templates';
import { IconClose, IconDownload, IconPlus, IconTrash } from './icons';

function takenIds(s: ReturnType<typeof useApp>): Set<string> {
  return new Set([...BUILTIN_CHECK_TEMPLATES, ...BUILTIN_BUNDLES, ...s.userTemplates, ...s.userBundles].map((t) => t.id));
}

function numOrNull(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

export function TemplateManager() {
  const s = useApp();
  const dialogRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const tmap = templatesMap(s);
  const bmap = bundlesMap(s);
  const selectedId = s.templateManager.selectedId ?? 'line-static';
  const selCheck = tmap.get(selectedId);
  const selBundle = bmap.get(selectedId);
  const close = () => setState({ templateManager: { open: false, selectedId: null } });
  const select = (id: string) => setState({ templateManager: { open: true, selectedId: id } });

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const duplicate = async () => {
    if (selCheck) {
      const c = cloneCheckTemplate(selCheck, takenIds(s));
      if (await saveUserTemplate(c)) select(c.id);
    } else if (selBundle) {
      const c = cloneBundle(selBundle, takenIds(s));
      if (await saveUserBundle(c)) select(c.id);
    }
  };

  const onImport = async (file: File) => {
    const text = await file.text();
    const r = parseTemplateJson(text, tmap);
    if (!r.ok) {
      toast(`読み込めません：${r.errors.join(' / ')}`, 'error');
      return;
    }
    const v = { ...r.value };
    if (takenIds(s).has(v.id)) {
      const old = v.id;
      v.id = uniqueId(v.id, takenIds(s));
      toast(`ID「${old}」は使用中のため「${v.id}」として取り込みました`);
    }
    const ok = r.kind === 'check-template' ? await saveUserTemplate(v as CheckTemplate) : await saveUserBundle(v as BundleTemplate);
    if (ok) {
      select(v.id);
      toast(`「${v.name}」を読み込みました`, 'success');
    }
  };

  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="tm-title" tabIndex={-1} ref={dialogRef}>
        <div class="modal-head">
          <h2 id="tm-title">チェックテンプレートと組合せセット</h2>
          <button class="icon-btn" aria-label="閉じる" onClick={close}>
            <IconClose />
          </button>
        </div>
        <div class="modal-body tm">
          <nav class="tm-list" aria-label="テンプレート一覧">
            <h3 class="h-small">チェックテンプレート</h3>
            <ul>
              {[...BUILTIN_CHECK_TEMPLATES, ...s.userTemplates].map((t) => (
                <li key={t.id}>
                  <button class={`tm-item ${t.id === selectedId ? 'on' : ''}`} aria-current={t.id === selectedId} onClick={() => select(t.id)}>
                    {t.name}
                    <span class="tm-tag">{isBuiltin(t.id) ? '標準' : '自作'}</span>
                  </button>
                </li>
              ))}
            </ul>
            <h3 class="h-small">組合せセット</h3>
            <ul>
              {[...BUILTIN_BUNDLES, ...s.userBundles].map((t) => (
                <li key={t.id}>
                  <button class={`tm-item ${t.id === selectedId ? 'on' : ''}`} aria-current={t.id === selectedId} onClick={() => select(t.id)}>
                    {t.name}
                    <span class="tm-tag">{isBuiltin(t.id) ? '標準' : '自作'}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div class="tm-list-actions">
              <button
                class="btn btn-small"
                onClick={async () => {
                  const t = newCheckTemplate(takenIds(s));
                  if (await saveUserTemplate(t)) select(t.id);
                }}
              >
                <IconPlus size={18} /> 新規テンプレート
              </button>
              <button
                class="btn btn-small"
                onClick={async () => {
                  const first = [...tmap.values()][0];
                  const b: BundleTemplate = {
                    schemaVersion: 1,
                    kind: 'bundle-template',
                    id: uniqueId('my-bundle', takenIds(s)),
                    name: '自作の組合せセット',
                    templates: [first.id],
                    outputs: [{ id: 'output-1', templateId: first.id, roles: [first.roles[0].id], archiveName: 'output-1.zip' }],
                  };
                  if (await saveUserBundle(b)) select(b.id);
                }}
              >
                <IconPlus size={18} /> 新規組合せセット
              </button>
              <button class="btn btn-small" onClick={() => importRef.current?.click()}>
                JSONを読み込む
              </button>
              <input
                ref={importRef}
                type="file"
                accept=".json,application/json"
                class="sr-only"
                tabIndex={-1}
                aria-label="テンプレートJSONを選ぶ"
                data-testid="input-template-json"
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0];
                  e.currentTarget.value = '';
                  if (f) onImport(f);
                }}
              />
            </div>
          </nav>
          <div class="tm-detail">
            {selCheck && (
              <CheckTemplateEditor
                key={`${selCheck.id}`}
                template={selCheck}
                onDuplicate={duplicate}
                onUse={() => {
                  setTarget({ kind: 'template', templateId: selCheck.id });
                  close();
                }}
              />
            )}
            {selBundle && (
              <BundleEditor
                key={selBundle.id}
                bundle={selBundle}
                onDuplicate={duplicate}
                onUse={() => {
                  setTarget({ kind: 'bundle', bundleId: selBundle.id });
                  close();
                }}
              />
            )}
            {!selCheck && !selBundle && <p class="muted">左の一覧から選んでください。</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function CheckTemplateEditor({ template, onDuplicate, onUse }: { template: CheckTemplate; onDuplicate: () => void; onUse: () => void }) {
  const s = useApp();
  const builtin = isBuiltin(template.id);
  const [draft, setDraft] = useState<CheckTemplate>(() => JSON.parse(JSON.stringify(template)));
  const [errors, setErrors] = useState<string[]>([]);
  const [counts, setCounts] = useState((template.allowedStickerCounts ?? []).join(','));
  const ro = builtin;
  const upd = (patch: Partial<CheckTemplate>) => setDraft((d) => ({ ...d, ...patch }));
  const updRole = (i: number, patch: Partial<CheckRole>) => setDraft((d) => ({ ...d, roles: d.roles.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const moveRole = (i: number, delta: number) =>
    setDraft((d) => {
      const roles = [...d.roles];
      const j = i + delta;
      if (j < 0 || j >= roles.length) return d;
      [roles[i], roles[j]] = [roles[j], roles[i]];
      return { ...d, roles };
    });
  const dirty = JSON.stringify(draft) !== JSON.stringify(template) || counts !== (template.allowedStickerCounts ?? []).join(',');

  const save = async () => {
    const t: CheckTemplate = JSON.parse(JSON.stringify(draft));
    const list = counts
      .split(/[,、\s]+/)
      .filter(Boolean)
      .map(Number);
    if (list.length) {
      t.allowedStickerCounts = list;
      if (!t.selectedStickerCount || !list.includes(t.selectedStickerCount)) t.selectedStickerCount = list[0];
    } else {
      delete t.allowedStickerCounts;
      delete t.selectedStickerCount;
    }
    const e = validateCheckTemplate(t);
    if (list.length && !t.roles.some((r) => r.id === 'sticker')) e.push('スタンプ数の選択肢は役割ID "sticker" に適用されます。役割 sticker がありません');
    setErrors(e);
    if (e.length) return;
    if (await saveUserTemplate(t)) toast('テンプレートを保存しました。使用中なら判定を更新します（検査済みの事実は再利用）', 'success');
  };

  const inUse = (s.project.target.kind === 'template' && s.project.target.templateId === template.id) ||
    (s.project.target.kind === 'bundle' && bundlesMap(s).get(s.project.target.bundleId)?.outputs.some((o) => o.templateId === template.id));

  return (
    <div class="editor">
      <div class="editor-head">
        <h3>{template.name}</h3>
        <span class={`src src-${template.sourceType === 'official-derived' ? 'official' : 'user'}`}>
          {template.sourceType === 'official-derived' ? '公式条件から作成（標準）' : '自作ルール'}
        </span>
      </div>
      {builtin && (
        <p class="banner banner-info">
          標準テンプレートは直接編集できません。「複製して編集」で自作テンプレートを作ってください。
          {template.sourceUrl && (
            <>
              {' '}
              出典：<span class="mono break">{template.sourceUrl}</span>（{template.checkedOn}確認）
            </>
          )}
        </p>
      )}
      <div class="editor-actions">
        <button class="btn btn-small btn-primary" onClick={onUse}>
          このテンプレートで検査
        </button>
        <button class="btn btn-small" onClick={onDuplicate}>
          {builtin ? '複製して編集' : '複製'}
        </button>
        <button class="btn btn-small" onClick={() => downloadText(templateToJson(template), `check-template_${template.id}.json`, `tpl:${template.id}`)}>
          <IconDownload size={18} /> JSON書出し
        </button>
        {!builtin && (
          <button
            class="btn btn-small btn-danger"
            onClick={async () => {
              if (inUse) {
                toast('使用中のテンプレートは削除できません。先に別のテンプレートへ切り替えてください。', 'error');
                return;
              }
              if (await askConfirm(`「${template.name}」を削除しますか？`, '削除する', true)) {
                await removeUserTemplate(template.id);
                setState({ templateManager: { open: true, selectedId: 'line-static' } });
              }
            }}
          >
            <IconTrash size={18} /> 削除
          </button>
        )}
      </div>

      <fieldset disabled={ro} class="form">
        <legend class="sr-only">テンプレートの設定</legend>
        <label class="field">
          <span>名前</span>
          <input value={draft.name} onInput={(e) => upd({ name: e.currentTarget.value })} />
        </label>
        <label class="field">
          <span>ID（英数字・-・_）</span>
          <input value={draft.id} disabled />
        </label>
        <label class="field wide">
          <span>説明・注意</span>
          <input value={draft.notice ?? ''} onInput={(e) => upd({ notice: e.currentTarget.value })} />
        </label>
        <label class="field">
          <span>完成ZIPの上限（bytes、空欄で上限なし）</span>
          <input inputMode="numeric" value={draft.maxArchiveBytes ?? ''} onInput={(e) => upd({ maxArchiveBytes: numOrNull(e.currentTarget.value) })} />
        </label>
        <label class="field">
          <span>スタンプ数の選択肢（例 8,16,24。空欄で使わない）</span>
          <input value={counts} onInput={(e) => setCounts(e.currentTarget.value)} />
        </label>
      </fieldset>

      <h4 class="h-small">役割（{draft.roles.length}）</h4>
      {draft.roles.map((r, i) => (
        <fieldset key={i} disabled={ro} class="form role-form">
          <legend>
            {i + 1}. {roleLabel(r)}
          </legend>
          <label class="field">
            <span>役割ID</span>
            <input value={r.id} onInput={(e) => updRole(i, { id: e.currentTarget.value })} />
          </label>
          <label class="field">
            <span>表示名</span>
            <input value={r.label ?? roleLabel(r)} onInput={(e) => updRole(i, { label: e.currentTarget.value })} />
          </label>
          <label class="field">
            <span>必要最少数</span>
            <input inputMode="numeric" value={r.count.min} onInput={(e) => updRole(i, { count: { ...r.count, min: Number(e.currentTarget.value) } })} />
          </label>
          <label class="field">
            <span>最多数（空欄で上限なし）</span>
            <input inputMode="numeric" value={r.count.max ?? ''} onInput={(e) => updRole(i, { count: { ...r.count, max: numOrNull(e.currentTarget.value) } })} />
          </label>
          <div class="field">
            <span>形式</span>
            <div class="checks">
              {(['png', 'jpeg'] as ImageFormat[]).map((f) => (
                <label key={f} class="check">
                  <input
                    type="checkbox"
                    checked={r.formats.includes(f)}
                    onChange={(e) => updRole(i, { formats: e.currentTarget.checked ? [...r.formats, f] : r.formats.filter((x) => x !== f) })}
                  />
                  {f.toUpperCase()}
                </label>
              ))}
            </div>
          </div>
          <label class="field">
            <span>寸法</span>
            <select
              value={r.dimensions.mode}
              onChange={(e) => {
                const mode = e.currentTarget.value as 'none' | 'exact' | 'max';
                const prev = r.dimensions.mode === 'none' ? { width: 370, height: 320 } : r.dimensions;
                updRole(i, { dimensions: mode === 'none' ? { mode } : { mode, width: prev.width, height: prev.height } });
              }}
            >
              <option value="none">指定なし</option>
              <option value="exact">一致（exact）</option>
              <option value="max">上限（max）</option>
            </select>
          </label>
          {r.dimensions.mode !== 'none' && (
            <>
              <label class="field">
                <span>幅 px</span>
                <input inputMode="numeric" value={r.dimensions.width} onInput={(e) => updRole(i, { dimensions: { ...(r.dimensions as { mode: 'exact'; width: number; height: number }), width: Number(e.currentTarget.value) } })} />
              </label>
              <label class="field">
                <span>高さ px</span>
                <input inputMode="numeric" value={r.dimensions.height} onInput={(e) => updRole(i, { dimensions: { ...(r.dimensions as { mode: 'exact'; width: number; height: number }), height: Number(e.currentTarget.value) } })} />
              </label>
            </>
          )}
          <label class="field">
            <span>1枚の容量上限（bytes、空欄でなし）</span>
            <input inputMode="numeric" value={r.maxBytes ?? ''} onInput={(e) => updRole(i, { maxBytes: numOrNull(e.currentTarget.value) })} />
          </label>
          <label class="field">
            <span>透明度</span>
            <select value={r.transparency} onChange={(e) => updRole(i, { transparency: e.currentTarget.value as CheckRole['transparency'] })}>
              <option value="required">背景透過が必要</option>
              <option value="optional">どちらでもよい</option>
              <option value="forbidden">透過なし</option>
            </select>
          </label>
          <label class="check field">
            <input type="checkbox" checked={r.evenDimensions} onChange={(e) => updRole(i, { evenDimensions: e.currentTarget.checked })} />
            幅・高さを偶数にする
          </label>
          <label class="field">
            <span>最低DPI（空欄で検査しない）</span>
            <input inputMode="numeric" value={r.minDpi ?? ''} onInput={(e) => updRole(i, { minDpi: numOrNull(e.currentTarget.value) })} />
          </label>
          <label class="field">
            <span>余白の目安 px（空欄で検査しない）</span>
            <input inputMode="numeric" value={r.marginAdvisoryPx ?? ''} onInput={(e) => updRole(i, { marginAdvisoryPx: numOrNull(e.currentTarget.value) })} />
          </label>
          <label class="field">
            <span>出力フォルダ（空欄でルート）</span>
            <input value={r.directory} onInput={(e) => updRole(i, { directory: e.currentTarget.value })} />
          </label>
          <label class="field">
            <span>出力名パターン</span>
            <input value={r.namePattern} onInput={(e) => updRole(i, { namePattern: e.currentTarget.value })} aria-describedby="pattern-help" />
          </label>
          <div class="ref-actions wide">
            <button type="button" class="btn btn-small" onClick={() => moveRole(i, -1)}>
              前へ
            </button>
            <button type="button" class="btn btn-small" onClick={() => moveRole(i, 1)}>
              後へ
            </button>
            <button type="button" class="btn btn-small btn-danger" onClick={() => setDraft((d) => ({ ...d, roles: d.roles.filter((_, j) => j !== i) }))}>
              この役割を削除
            </button>
          </div>
        </fieldset>
      ))}
      <p id="pattern-help" class="muted small">
        出力名パターン：{'{index:02}'}＝並び順を2桁、{'{index}'}＝並び順、{'{ext}'}＝中身の形式の拡張子、{'{original}'}＝元のファイル名、{'{stem}'}＝拡張子なしの元の名前。トリミングや自動リサイズはチェックテンプレートには含めません。
      </p>
      {!ro && (
        <>
          <button class="btn btn-small" onClick={() => setDraft((d) => ({ ...d, roles: [...d.roles, newRole(new Set(d.roles.map((r) => r.id)))] }))}>
            <IconPlus size={18} /> 役割を追加
          </button>
          {errors.length > 0 && (
            <ul class="banner banner-error" role="alert">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <div class="editor-actions sticky-actions">
            <button class="btn btn-primary" onClick={save} disabled={!dirty}>
              保存
            </button>
            <button
              class="btn"
              disabled={!dirty}
              onClick={() => {
                setDraft(JSON.parse(JSON.stringify(template)));
                setCounts((template.allowedStickerCounts ?? []).join(','));
                setErrors([]);
              }}
            >
              変更を取り消す
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function BundleEditor({ bundle, onDuplicate, onUse }: { bundle: BundleTemplate; onDuplicate: () => void; onUse: () => void }) {
  const s = useApp();
  const tmap = templatesMap(s);
  const builtin = isBuiltin(bundle.id);
  const [draft, setDraft] = useState<BundleTemplate>(() => JSON.parse(JSON.stringify(bundle)));
  const [errors, setErrors] = useState<string[]>([]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(bundle);
  const updOut = (i: number, patch: Partial<BundleTemplate['outputs'][number]>) =>
    setDraft((d) => ({ ...d, outputs: d.outputs.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));
  const save = async () => {
    const b: BundleTemplate = { ...draft, templates: [...new Set(draft.outputs.map((o) => o.templateId))] };
    const e = validateBundleTemplate(b, tmap);
    setErrors(e);
    if (e.length) return;
    setDraft(b);
    if (await saveUserBundle(b)) toast('組合せセットを保存しました', 'success');
  };
  const inUse = s.project.target.kind === 'bundle' && s.project.target.bundleId === bundle.id;
  return (
    <div class="editor">
      <div class="editor-head">
        <h3>{bundle.name}</h3>
        <span class="src src-user">組合せセット</span>
      </div>
      {bundle.note && <p class="muted">{bundle.note}</p>}
      <p class="muted small">各出力は選んだ役割だけを検査します。同じ画像を複数の出力・役割で使えます。条件は各テンプレートのまま（緩和しません）。</p>
      {builtin && <p class="banner banner-info">標準の組合せセットは直接編集できません。「複製して編集」を使ってください。</p>}
      <div class="editor-actions">
        <button class="btn btn-small btn-primary" onClick={onUse}>
          この組合せで検査
        </button>
        <button class="btn btn-small" onClick={onDuplicate}>
          {builtin ? '複製して編集' : '複製'}
        </button>
        <button class="btn btn-small" onClick={() => downloadText(templateToJson(bundle), `bundle-template_${bundle.id}.json`, `bundle:${bundle.id}`)}>
          <IconDownload size={18} /> JSON書出し
        </button>
        {!builtin && (
          <button
            class="btn btn-small btn-danger"
            onClick={async () => {
              if (inUse) {
                toast('使用中の組合せセットは削除できません', 'error');
                return;
              }
              if (await askConfirm(`「${bundle.name}」を削除しますか？`, '削除する', true)) {
                await removeUserBundle(bundle.id);
                setState({ templateManager: { open: true, selectedId: 'line-static' } });
              }
            }}
          >
            <IconTrash size={18} /> 削除
          </button>
        )}
      </div>
      <fieldset disabled={builtin} class="form">
        <legend class="sr-only">組合せセットの設定</legend>
        <label class="field wide">
          <span>名前</span>
          <input value={draft.name} onInput={(e) => setDraft((d) => ({ ...d, name: e.currentTarget.value }))} />
        </label>
      </fieldset>
      {draft.outputs.map((o, i) => {
        const t = tmap.get(o.templateId);
        return (
          <fieldset key={i} disabled={builtin} class="form role-form">
            <legend>
              出力 {i + 1}：{o.archiveName}
            </legend>
            <label class="field">
              <span>出力ID</span>
              <input value={o.id} onInput={(e) => updOut(i, { id: e.currentTarget.value })} />
            </label>
            <label class="field">
              <span>ZIP名</span>
              <input value={o.archiveName} onInput={(e) => updOut(i, { archiveName: e.currentTarget.value })} />
            </label>
            <label class="field">
              <span>テンプレート</span>
              <select
                value={o.templateId}
                onChange={(e) => {
                  const nt = tmap.get(e.currentTarget.value);
                  updOut(i, { templateId: e.currentTarget.value, roles: nt ? [nt.roles[0].id] : [] });
                }}
              >
                {[...tmap.values()].map((x) => (
                  <option value={x.id}>{x.name}</option>
                ))}
                {!t && <option value={o.templateId}>（見つかりません：{o.templateId}）</option>}
              </select>
            </label>
            <div class="field wide">
              <span>検査・出力する役割</span>
              <div class="checks">
                {t?.roles.map((r) => (
                  <label key={r.id} class="check">
                    <input
                      type="checkbox"
                      checked={o.roles.includes(r.id)}
                      onChange={(e) => updOut(i, { roles: e.currentTarget.checked ? [...o.roles, r.id] : o.roles.filter((x) => x !== r.id) })}
                    />
                    {roleLabel(r)}
                  </label>
                ))}
              </div>
            </div>
            <div class="ref-actions wide">
              <button type="button" class="btn btn-small btn-danger" onClick={() => setDraft((d) => ({ ...d, outputs: d.outputs.filter((_, j) => j !== i) }))}>
                この出力を削除
              </button>
            </div>
          </fieldset>
        );
      })}
      {!builtin && (
        <>
          <button
            class="btn btn-small"
            onClick={() => {
              const first = [...tmap.values()][0];
              const n = draft.outputs.length + 1;
              setDraft((d) => ({ ...d, outputs: [...d.outputs, { id: `output-${n}`, templateId: first.id, roles: [first.roles[0].id], archiveName: `output-${n}.zip` }] }));
            }}
          >
            <IconPlus size={18} /> 出力を追加
          </button>
          {errors.length > 0 && (
            <ul class="banner banner-error" role="alert">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <div class="editor-actions sticky-actions">
            <button class="btn btn-primary" onClick={save} disabled={!dirty}>
              保存
            </button>
            <button class="btn" disabled={!dirty} onClick={() => setDraft(JSON.parse(JSON.stringify(bundle)))}>
              変更を取り消す
            </button>
          </div>
        </>
      )}
    </div>
  );
}
