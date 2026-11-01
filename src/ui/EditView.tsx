import { useRef, useState } from 'preact/hooks';
import { exportOriginal, replaceAssetFile, useApp } from '../app/store';
import { Mascot } from './common';
import { IconDownload, IconSwap } from './icons';

/** 画像編集は第2段階。ここでは未実装の編集操作を動くように見せない。 */
export function EditView() {
  const s = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<string | null>(null);
  return (
    <div class="workspace single">
      <div class="main-col">
        <div class="page-head">
          <div class="title-block">
            <h1>
              編集 <span class="pill pill-unchecked">準備中</span>
            </h1>
          </div>
        </div>
        <div class="card mascot-card">
          <Mascot kind="waiting" alt="空き箱の横で待つマーモット" size={112} />
          <div>
            <strong>画像編集機能はまだありません</strong>
            <p>いまできることは次の2つです。</p>
            <ol>
              <li>元画像をそのまま書き出す（バイトは変えません）</li>
              <li>外部のアプリで修正した画像を読み込んで差し替える（役割・順序は維持し、再検査します）</li>
            </ol>
            <p class="muted small">分割・余白調整・表紙作成などは今後の別モジュールで追加予定です。外部AIへ自動送信することはありません。</p>
          </div>
        </div>
        {s.project.assets.length > 0 && (
          <section class="card">
            <h2 class="h-small">画像（{s.project.assets.length}件）</h2>
            <ul class="edit-list">
              {s.project.assets.map((a) => (
                <li key={a.id}>
                  <span class="thumb-mini checker">{s.thumbs[a.id]?.url ? <img src={s.thumbs[a.id]!.url!} alt="" /> : null}</span>
                  <span class="break edit-name">{a.originalName}</span>
                  <span class="edit-actions">
                    <button class="btn btn-small" onClick={() => exportOriginal(a.id)} aria-label={`${a.originalName} の元画像を書き出す`}>
                      <IconDownload size={18} /> 元画像を書き出す
                    </button>
                    <button
                      class="btn btn-small"
                      disabled={!!s.job}
                      onClick={() => {
                        setTarget(a.id);
                        input.current?.click();
                      }}
                      aria-label={`${a.originalName} を修正済み画像で差し替える`}
                    >
                      <IconSwap size={18} /> 修正画像で差し替え
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,.png,.jpg,.jpeg,image/*"
          class="sr-only"
          tabIndex={-1}
          aria-label="差し替える画像"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (f && target) replaceAssetFile(target, f);
          }}
        />
      </div>
    </div>
  );
}
