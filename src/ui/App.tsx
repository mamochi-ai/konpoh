import { useEffect, useRef } from 'preact/hooks';
import { abortJob, answerConfirm, dismissToast, evaluation, getState, importFiles, saveNow, setState, useApp, type Tab } from '../app/store';
import { IconBox, IconClose, IconImage, IconLock, IconSave, IconZip, IconArrowRight } from './icons';
import { CheckView } from './CheckView';
import { PackView } from './PackView';
import { EditView } from './EditView';
import { TrialView } from './TrialView';
import { runCheck } from '../app/store';

const TABS: { id: Tab; label: string }[] = [
  { id: 'edit', label: '編集' },
  { id: 'check', label: 'チェック' },
  { id: 'trial', label: '試し送り' },
  { id: 'pack', label: '梱包' },
];

export function App() {
  const s = useApp();
  const imgInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const ev = evaluation(s);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (s.confirm) answerConfirm(false);
      else if (s.selectedAssetId) setState({ selectedAssetId: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s.selectedAssetId, s.confirm]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (getState().dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const onFiles = (input: HTMLInputElement | null) => {
    if (!input?.files) return;
    const files = Array.from(input.files);
    input.value = '';
    importFiles(files);
  };

  return (
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <IconBox size={28} />
          <span>こつこつ梱包室</span>
        </div>
        <nav class="tabs" role="tablist" aria-label="作業の切替">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={s.tab === t.id}
              aria-controls={`panel-${t.id}`}
              class={`tab ${s.tab === t.id ? 'active' : ''}`}
              onClick={() => setState({ tab: t.id })}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div class="top-actions">
          <button class="btn" onClick={() => imgInput.current?.click()} disabled={!!s.job}>
            <IconImage size={18} /> 画像を追加
          </button>
          <button class="btn" onClick={() => zipInput.current?.click()} disabled={!!s.job}>
            <IconZip size={18} /> ZIPを読み込む
          </button>
          <button class="btn" onClick={() => saveNow()} aria-describedby="save-state">
            <IconSave size={18} /> 保存
            {s.dirty && <span class="dot" aria-hidden="true" />}
          </button>
          <span id="save-state" class="sr-only">
            {s.dirty ? '未保存の変更があります' : '保存済み'}
          </span>
        </div>
        <input
          ref={imgInput}
          type="file"
          multiple
          accept="image/png,image/jpeg,.png,.jpg,.jpeg,image/*"
          class="sr-only"
          tabIndex={-1}
          aria-label="画像を追加"
          data-testid="input-images"
          onChange={(e) => onFiles(e.currentTarget)}
        />
        <input
          ref={zipInput}
          type="file"
          multiple
          accept=".zip,application/zip,application/x-zip-compressed"
          class="sr-only"
          tabIndex={-1}
          aria-label="ZIPを読み込む"
          data-testid="input-zip"
          onChange={(e) => onFiles(e.currentTarget)}
        />
      </header>

      {s.saveError && (
        <div class="banner banner-error" role="alert">
          {s.saveError}
          <button class="icon-btn" aria-label="閉じる" onClick={() => setState({ saveError: null })}>
            <IconClose size={18} />
          </button>
        </div>
      )}

      <div class="content" id={`panel-${s.tab}`} role="tabpanel" aria-labelledby={`tab-${s.tab}`}>
        {s.tab === 'check' && <CheckView />}
        {s.tab === 'pack' && <PackView />}
        {s.tab === 'edit' && <EditView />}
        {s.tab === 'trial' && <TrialView />}
      </div>

      <footer class="footbar">
        <span class="local-note">
          <IconLock size={18} /> 画像はこの端末内で処理します（外部へ送信しません）
        </span>
        <div class="foot-actions">
          {s.tab === 'check' && (
            <>
              <button class="btn" onClick={() => runCheck()} disabled={!!s.job || !s.project.assets.length}>
                検査を実行{ev.imageCounts.unchecked ? `（未検査${ev.imageCounts.unchecked}）` : ''}
              </button>
              <button class="btn btn-primary" onClick={() => setState({ tab: 'pack', selectedAssetId: null })}>
                梱包へ進む <IconArrowRight size={18} />
              </button>
            </>
          )}
          {s.tab === 'trial' && (
            <>
              <button class="btn" onClick={() => setState({ tab: 'check' })}>
                チェックへ
              </button>
              <button class="btn btn-primary" onClick={() => setState({ tab: 'pack', selectedAssetId: null })}>
                梱包へ進む <IconArrowRight size={18} />
              </button>
            </>
          )}
          {s.tab === 'pack' && (
            <button class="btn" onClick={() => setState({ tab: 'check' })}>
              チェックへ戻る
            </button>
          )}
          {s.tab === 'edit' && (
            <button class="btn btn-primary" onClick={() => setState({ tab: 'check' })}>
              チェックへ <IconArrowRight size={18} />
            </button>
          )}
        </div>
      </footer>

      {s.job && (
        <div class="jobbar" role="status" aria-live="polite">
          <div class="job-text">
            <strong>{s.job.label}</strong>
            <span>
              {s.job.done}/{s.job.total}
              {s.job.detail ? ` ・ ${s.job.detail}` : ''}
            </span>
          </div>
          <progress max={Math.max(1, s.job.total)} value={s.job.done} aria-label={s.job.label} />
          <button class="btn" onClick={abortJob}>
            中止
          </button>
        </div>
      )}

      <div class="toasts" aria-live="polite">
        {s.toasts.map((t) => (
          <div key={t.id} class={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <span>{t.text}</span>
            <button class="icon-btn" aria-label="通知を閉じる" onClick={() => dismissToast(t.id)}>
              <IconClose size={18} />
            </button>
          </div>
        ))}
      </div>


      {s.confirm && (
        <div class="modal-backdrop confirm-backdrop">
          <div class="confirm-box" role="alertdialog" aria-modal="true" aria-labelledby="confirm-msg">
            <p id="confirm-msg">{s.confirm.message}</p>
            <div class="confirm-actions">
              <button class="btn" onClick={() => answerConfirm(false)} autoFocus>
                やめる
              </button>
              <button class={`btn ${s.confirm.danger ? 'btn-danger-solid' : 'btn-primary'}`} onClick={() => answerConfirm(true)}>
                {s.confirm.okLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
