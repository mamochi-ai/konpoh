// 試し送り：架空のトーク画面でスタンプを試す。LINEへの送信や外部通信はしない。
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { askConfirm, evaluation, getState, openInEditor, showInCheck, useApp } from '../app/store';
import {
  adoptPair,
  addLocalToProject,
  exportTrialImage,
  imageFor,
  loadAfterImage,
  loadTrialFiles,
  releaseUnusedUrls,
  removeTrialImage,
  updateTrial,
  urlFor,
} from '../app/trialStore';
import {
  addCustomTopic,
  addPartnerMessage,
  addProjectImages,
  allTopics,
  BUILTIN_TOPICS,
  bgColor,
  editMessage,
  hasSentStickers,
  isDarkColor,
  isKeyInUseByPair,
  NOTE_TAGS,
  parseKey,
  projectKey,
  localKey,
  removeCustomTopic,
  removeItem,
  removePair,
  resetConversation,
  sendSticker,
  setNoteText,
  SIZE_LABEL,
  SIZE_PX,
  switchTopic,
  toggleTag,
  undoLastSticker,
  updateCustomTopic,
  type ComparePair,
  type ImageKey,
  type TrialBg,
  type TrialSize,
} from '../core/trial';
import { isLikelySheet, unsplitSheets } from '../core/sheet';
import { LINE_TEMPLATE } from '../core/templates';
import { Mascot, StatusPill } from './common';
import { IconClose, IconDownload, IconImage, IconPlus } from './icons';

const TAG_SHORT: Record<string, string> = { 'hard-to-read': '文字', edge: '縁', pose: '表情', ok: 'OK' };

function shortName(name: string, max = 16): string {
  if (name.length <= max) return name;
  const m = /(\.[A-Za-z0-9]{1,5})$/.exec(name);
  const ext = m ? m[1] : '';
  const body = name.slice(0, name.length - ext.length);
  const keep = Math.max(4, max - ext.length - 1);
  const head = Math.ceil(keep * 0.6);
  return `${body.slice(0, head)}…${body.slice(body.length - (keep - head))}${ext}`;
}

/** 試し送りの一覧に並ぶ画像（プロジェクトの画像＋試し送りで読み込んだ画像） */
function useStampKeys(): ImageKey[] {
  const s = useApp();
  const ids = new Set(s.project.assets.map((a) => a.id));
  return [...s.trial.projectAssetIds.filter((id) => ids.has(id)).map(projectKey), ...s.trial.localImages.filter((m) => s.trialBlobs[m.id]).map((m) => localKey(m.id))];
}

function isSheetKey(key: ImageKey): boolean {
  const s = getState();
  const k = parseKey(key);
  if (!k) return false;
  if (k.kind === 'project') {
    // 分割済みの元画像も「未分割」と表示しない対象は unsplitSheets で判断
    return unsplitSheets(s.project.assets, s.dims, LINE_TEMPLATE).some((a) => a.id === k.id);
  }
  const m = s.trial.localImages.find((x) => x.id === k.id);
  return !!m && isLikelySheet(m.width && m.height ? { width: m.width, height: m.height } : null, LINE_TEMPLATE);
}

function StickerImg({ k, label }: { k: ImageKey; label: string }) {
  const url = urlFor(k);
  if (!url) return <span class="sticker-missing">画像が見つかりません</span>;
  return <img class="sticker-img" src={url} alt={label} draggable={false} />;
}

// ================================================================ 左：お題と表示設定

function TopicPanel() {
  const s = useApp();
  const d = s.trial;
  const topics = allTopics(d);
  const [pending, setPending] = useState<string | null>(null);
  const [newTopic, setNewTopic] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const cur = topics.find((t) => t.id === d.conversation.topicId);
  // 狭い画面では表示の設定を最初は閉じて、会話を上の方に見せる
  const [wide] = useState(() => typeof window === 'undefined' || !window.matchMedia || window.matchMedia('(min-width: 700px)').matches);
  const cats = [...new Set(topics.map((t) => t.category))];

  const choose = (id: string) => {
    if (id === d.conversation.topicId) return;
    if (hasSentStickers(d)) setPending(id);
    else updateTrial((x) => switchTopic(x, id, 'fresh'));
  };

  return (
    <section class="card trial-side" aria-label="会話のお題と表示設定">
      <div class="field">
        <label for="trial-topic">会話のお題</label>
        <select id="trial-topic" value={d.conversation.topicId ?? ''} onChange={(e) => choose(e.currentTarget.value)}>
          {!cur && <option value="">（お題なし）</option>}
          {cats.map((c) => (
            <optgroup key={c} label={c}>
              {topics
                .filter((t) => t.category === c)
                .map((t) => (
                  <option value={t.id}>{t.text}</option>
                ))}
            </optgroup>
          ))}
        </select>
      </div>
      {pending && (
        <div class="topic-switch" role="alertdialog" aria-label="お題の切り替え">
          <p class="small">送ったスタンプがあります。お題をどう切り替えますか？</p>
          <div class="row-wrap">
            <button
              class="btn btn-small btn-primary"
              onClick={() => {
                updateTrial((x) => switchTopic(x, pending, 'keep'));
                setPending(null);
              }}
            >
              会話を残して続ける
            </button>
            <button
              class="btn btn-small"
              onClick={() => {
                updateTrial((x) => switchTopic(x, pending, 'fresh'));
                setPending(null);
              }}
            >
              新しく始める
            </button>
            <button class="btn btn-small" onClick={() => setPending(null)}>
              やめる
            </button>
          </div>
        </div>
      )}

      <details class="trial-details" open={d.customTopics.length > 0}>
        <summary>自作のお題（{d.customTopics.length}）</summary>
        <div class="row-wrap">
          <input id="trial-new-topic" class="grow" placeholder="相手のメッセージ（例：週末どこ行く？）" value={newTopic} onInput={(e) => setNewTopic(e.currentTarget.value)} aria-label="自作のお題" />
          <button
            class="btn btn-small"
            disabled={!newTopic.trim()}
            onClick={() => {
              let created: string | null = null;
              updateTrial((x) => {
                const r = addCustomTopic(x, newTopic);
                created = r.topic?.id ?? null;
                return r.data;
              });
              setNewTopic('');
              if (created) choose(created);
            }}
          >
            <IconPlus size={18} /> 追加
          </button>
        </div>
        {cur && !cur.builtIn ? null : (
          <button
            class="btn btn-small"
            onClick={() => {
              const first = d.conversation.items.find((i) => i.side === 'partner' && i.kind === 'text');
              if (first?.text) updateTrial((x) => addCustomTopic(x, first.text!).data);
            }}
          >
            今の最初のメッセージを自作のお題に保存
          </button>
        )}
        <ul class="custom-topics">
          {d.customTopics.map((t) => (
            <li key={t.id}>
              {editing === t.id ? (
                <>
                  <input value={editText} onInput={(e) => setEditText(e.currentTarget.value)} aria-label="お題を編集" class="grow" />
                  <button
                    class="btn btn-small"
                    onClick={() => {
                      updateTrial((x) => updateCustomTopic(x, t.id, editText));
                      setEditing(null);
                    }}
                  >
                    保存
                  </button>
                </>
              ) : (
                <>
                  <span class="grow break">{t.text}</span>
                  <button
                    class="btn btn-small"
                    onClick={() => {
                      setEditing(t.id);
                      setEditText(t.text);
                    }}
                  >
                    編集
                  </button>
                  <button class="btn btn-small btn-danger" onClick={() => updateTrial((x) => removeCustomTopic(x, t.id))} aria-label={`自作のお題「${t.text}」を削除`}>
                    削除
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </details>

      <details class="trial-details" open={wide}>
        <summary>表示の設定（背景・サイズ・見え方）</summary>
        <div class="field">
          <span id="lbl-bg">背景</span>
          <div class="seg" role="radiogroup" aria-labelledby="lbl-bg">
            {(
              [
                ['light', '明るい'],
                ['dark', '暗い'],
                ['blue', '淡い青'],
                ['custom', '好きな色'],
              ] as [TrialBg, string][]
            ).map(([k, l]) => (
              <button key={k} role="radio" aria-checked={d.settings.bg === k} class={`seg-btn ${d.settings.bg === k ? 'on' : ''}`} onClick={() => updateTrial((x) => ({ ...x, settings: { ...x.settings, bg: k } }))}>
                {l}
              </button>
            ))}
          </div>
          {d.settings.bg === 'custom' && (
            <label class="color-row">
              <input
                id="trial-color"
                type="color"
                value={d.settings.customColor}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  updateTrial((x) => ({ ...x, settings: { ...x.settings, customColor: v } }));
                }}
              />
              <span class="mono">{d.settings.customColor}</span>
            </label>
          )}
        </div>
        <div class="field">
          <span id="lbl-size">表示サイズ</span>
          <div class="seg" role="radiogroup" aria-labelledby="lbl-size">
            {(['s', 'm', 'l'] as TrialSize[]).map((k) => (
              <button key={k} role="radio" aria-checked={d.settings.size === k} class={`seg-btn ${d.settings.size === k ? 'on' : ''}`} onClick={() => updateTrial((x) => ({ ...x, settings: { ...x.settings, size: k } }))}>
                {SIZE_LABEL[k]}
              </button>
            ))}
          </div>
          <span class="muted small">表示の大きさだけを変えます（画像は変えません）。実際のLINEでは端末や設定により表示が異なります。</span>
        </div>
        <div class="field">
          <span id="lbl-view">見え方</span>
          <div class="seg" role="radiogroup" aria-labelledby="lbl-view">
            {(
              [
                [false, '自分が送る'],
                [true, '相手が受け取る'],
              ] as [boolean, string][]
            ).map(([v, l]) => (
              <button key={l} role="radio" aria-checked={d.settings.receiverView === v} class={`seg-btn ${d.settings.receiverView === v ? 'on' : ''}`} onClick={() => updateTrial((x) => ({ ...x, settings: { ...x.settings, receiverView: v } }))}>
                {l}
              </button>
            ))}
          </div>
        </div>
      </details>

      <p class={`trial-save small ${s.trialSave.status === 'error' ? 'bad' : ''}`} role="status">
        {s.trialSave.status === 'error'
          ? s.trialSave.message
          : s.trialSave.status === 'saving'
            ? '保存中…'
            : s.trialSave.status === 'saved'
              ? 'この端末に保存しました'
              : '画像・メモ・お題・表示設定はこの端末に自動で保存します'}
        <br />
        <span class="muted">ブラウザのデータを削除すると、保存した内容も消えます。</span>
      </p>
    </section>
  );
}

// ================================================================ 中央：模擬トーク

function ChatFrame({ items, selected, onSelect, editable, compact, label }: { items: ReturnType<typeof getState>['trial']['conversation']['items']; selected?: string | null; onSelect?: (id: string | null) => void; editable?: boolean; compact?: boolean; label: string }) {
  const s = useApp();
  const st = s.trial.settings;
  const bg = bgColor(st);
  const dark = isDarkColor(bg);
  const ref = useRef<HTMLDivElement>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const lastId = items[items.length - 1]?.id;
  const toBottom = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  useEffect(toBottom, [lastId, items.length, st.size]);

  return (
    <div
      ref={ref}
      class={`chat-frame ${dark ? 'dark' : ''} ${compact ? 'compact' : ''}`}
      style={{ background: bg, ['--stk' as string]: `${SIZE_PX[st.size]}px` }}
      role="log"
      aria-label={label}
      data-testid={compact ? undefined : 'chat-frame'}
    >
      {items.length === 0 && <p class="chat-empty">お題を選ぶと、相手のメッセージが表示されます。</p>}
      {items.map((it) => {
        // 「相手が受け取る」表示では左右を入れ替える
        const mine = it.side === 'me';
        const right = st.receiverView ? !mine : mine;
        if (it.kind === 'text') {
          return (
            <div key={it.id} class={`chat-row ${right ? 'right' : 'left'}`}>
              {!right && <span class="chat-avatar" aria-hidden="true">相</span>}
              {editable && editId === it.id ? (
                <span class="bubble-edit">
                  <textarea value={editText} onInput={(e) => setEditText(e.currentTarget.value)} aria-label="相手のメッセージを編集" rows={2} />
                  <span class="row-wrap">
                    <button
                      class="btn btn-small btn-primary"
                      onClick={() => {
                        updateTrial((x) => editMessage(x, it.id, editText));
                        setEditId(null);
                      }}
                    >
                      保存
                    </button>
                    <button class="btn btn-small" onClick={() => setEditId(null)}>
                      やめる
                    </button>
                    <button
                      class="btn btn-small btn-danger"
                      onClick={() => {
                        updateTrial((x) => removeItem(x, it.id));
                        setEditId(null);
                      }}
                    >
                      削除
                    </button>
                  </span>
                </span>
              ) : editable ? (
                <button
                  class="bubble"
                  aria-label={`相手のメッセージ「${it.text}」。タップで編集`}
                  onClick={() => {
                    setEditId(it.id);
                    setEditText(it.text ?? '');
                  }}
                >
                  {it.text}
                </button>
              ) : (
                <span class="bubble">{it.text}</span>
              )}
            </div>
          );
        }
        const img = imageFor(it.imageKey!);
        const name = img?.name ?? '削除された画像';
        return (
          <div key={it.id} class={`chat-row ${right ? 'right' : 'left'}`}>
            {!right && st.receiverView && <span class="chat-avatar" aria-hidden="true">相</span>}
            {onSelect ? (
              <button
                class={`chat-sticker ${selected === it.id ? 'selected' : ''}`}
                aria-pressed={selected === it.id}
                aria-label={`送ったスタンプ ${name}。選んで削除・メモ・比較ができます`}
                onClick={() => onSelect(selected === it.id ? null : it.id)}
              >
                <StickerImg k={it.imageKey!} label={name} />
              </button>
            ) : (
              <span class="chat-sticker">
                <StickerImg k={it.imageKey!} label={name} />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ChatPanel({ onOpenSheet, onCompareFrom }: { onOpenSheet: (k: ImageKey) => void; onCompareFrom: (k: ImageKey) => void }) {
  const s = useApp();
  const d = s.trial;
  const [selected, setSelected] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const sel = d.conversation.items.find((i) => i.id === selected && i.kind === 'sticker');
  const sent = d.conversation.items.filter((i) => i.side === 'me').length;
  return (
    <section class="trial-chat" aria-label="試し送りのトーク画面">
      <p class="chat-notice">
        <IconImage size={16} /> アプリ内のプレビューです。LINEへは送信されません
      </p>
      <p class="muted small chat-viewlabel">{d.settings.receiverView ? '相手が受け取ったときの見え方（スタンプは左）' : '自分が送ったときの見え方（スタンプは右）'}</p>
      <ChatFrame items={d.conversation.items} selected={selected} onSelect={setSelected} editable label="試し送りの会話" />
      {sel ? (
        <div class="chat-actions selected-actions" role="group" aria-label="選んだスタンプの操作">
          <span class="small break">選択中：{shortName(imageFor(sel.imageKey!)?.name ?? '削除された画像', 22)}</span>
          <div class="row-wrap">
            <button class="btn btn-small" onClick={() => onOpenSheet(sel.imageKey!)} disabled={!imageFor(sel.imageKey!)}>
              メモ
            </button>
            <button class="btn btn-small" onClick={() => onCompareFrom(sel.imageKey!)} disabled={!imageFor(sel.imageKey!)}>
              比較の修正前にする
            </button>
            <button
              class="btn btn-small btn-danger"
              onClick={() => {
                updateTrial((x) => removeItem(x, sel.id));
                setSelected(null);
              }}
            >
              この送信を削除
            </button>
            <button class="btn btn-small" onClick={() => setSelected(null)}>
              選択をやめる
            </button>
          </div>
        </div>
      ) : (
        <div class="chat-actions" role="group" aria-label="会話の操作">
          <form
            class="row-wrap partner-add"
            onSubmit={(e) => {
              e.preventDefault();
              updateTrial((x) => addPartnerMessage(x, msg));
              setMsg('');
            }}
          >
            <input id="trial-partner-msg" class="grow" placeholder="相手のメッセージを追加" value={msg} onInput={(e) => setMsg(e.currentTarget.value)} aria-label="相手のメッセージを追加" />
            <button class="btn btn-small" type="submit" disabled={!msg.trim()}>
              追加
            </button>
          </form>
          <div class="row-wrap">
            <button class="btn btn-small" disabled={!sent} onClick={() => updateTrial(undoLastSticker)}>
              最後の送信を取り消す
            </button>
            <button
              class="btn btn-small"
              disabled={d.conversation.items.length <= 1 && !sent}
              onClick={async () => {
                if (await askConfirm('会話をリセットしますか？ 読み込んだ画像とメモはそのまま残ります。', '会話をリセット')) updateTrial(resetConversation);
              }}
            >
              会話をリセット
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ================================================================ 比較

function ComparePanel({ pair, onClose }: { pair: ComparePair; onClose: () => void }) {
  const s = useApp();
  const [side, setSide] = useState<'before' | 'after'>('before');
  const [busy, setBusy] = useState(false);
  const first = s.trial.conversation.items.find((i) => i.side === 'partner' && i.kind === 'text') ?? { id: 'p', side: 'partner' as const, kind: 'text' as const, text: BUILTIN_TOPICS[0].text };
  const before = imageFor(pair.beforeKey);
  const after = imageFor(pair.afterKey);
  const adopted = pair.adoptedAssetId ? s.project.assets.find((a) => a.id === pair.adoptedAssetId) : null;
  const ev = evaluation(s);
  const adoptedStatus = adopted ? ev.assets[adopted.id]?.status : null;
  const beforeIsProject = parseKey(pair.beforeKey)?.kind === 'project';
  const frame = (k: ImageKey, label: string) => (
    <div class="compare-col">
      <h3 class="h-small">
        {label}：<span class="break">{shortName(imageFor(k)?.name ?? '見つかりません', 24)}</span>
      </h3>
      <ChatFrame items={[first, { id: `c-${k}`, side: 'me', kind: 'sticker', imageKey: k }]} compact label={`${label}の表示`} />
    </div>
  );
  return (
    <section class="trial-chat compare" aria-label="修正前後の比較">
      <div class="compare-head">
        <h2 class="h-small">修正前後の比較</h2>
        <button class="btn btn-small" onClick={onClose}>
          比較を閉じる
        </button>
      </div>
      <p class="muted small">同じ会話文・同じ背景・同じ表示サイズで並べています。実際のLINEでは端末や設定により表示が異なります。</p>
      <div class="seg compare-switch" role="radiogroup" aria-label="表示する方">
        {(
          [
            ['before', '修正前'],
            ['after', '修正後'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="radio" aria-checked={side === k} class={`seg-btn ${side === k ? 'on' : ''}`} onClick={() => setSide(k)}>
            {l}
          </button>
        ))}
      </div>
      <div class={`compare-grid show-${side}`}>
        {frame(pair.beforeKey, '修正前')}
        {frame(pair.afterKey, '修正後')}
      </div>
      <div class="adopt-box">
        {pair.adoptedAt ? (
          <div class="banner banner-warn" role="status">
            <span>
              採用済みです。{adopted ? `プロジェクトの「${shortName(adopted.originalName, 24)}」` : 'プロジェクトの画像'}は修正後の画像になり、以前のチェック結果は使っていません。
              {adoptedStatus === 'unchecked' ? ' 再チェックが必要です。' : ''}
            </span>
            {adopted && (
              <button class="btn btn-small btn-primary" onClick={() => showInCheck(adopted.id)}>
                チェックで再検査する
              </button>
            )}
          </div>
        ) : (
          <>
            <p class="small">
              {beforeIsProject
                ? `プロジェクトの「${shortName(before?.name ?? '', 24)}」を修正後の画像に差し替えます。役割と並び順はそのまま、チェック結果は使わずに「未検査」に戻ります。修正前は比較用にこの画面に残ります。`
                : '修正後の画像を、新しい画像としてプロジェクトに追加します（未検査）。'}
            </p>
            <div class="row-wrap">
              <button
                class="btn btn-primary"
                disabled={busy || !after}
                onClick={async () => {
                  if (!(await askConfirm(beforeIsProject ? '修正後の画像でプロジェクトの画像を差し替えますか？ チェックはやり直しになります。' : '修正後の画像をプロジェクトに追加しますか？', '採用する'))) return;
                  setBusy(true);
                  try {
                    await adoptPair(pair.id);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                修正後をプロジェクトに採用
              </button>
              <button
                class="btn btn-small btn-danger"
                onClick={async () => {
                  if (await askConfirm('この比較の組を削除しますか？（画像はプロジェクトや一覧に残ります）', '削除する', true)) {
                    updateTrial((x) => removePair(x, pair.id));
                    onClose();
                  }
                }}
              >
                この組を削除
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

// ================================================================ 右：スタンプ一覧

function StampPanel({ onOpenSheet, onOpenPicker, onOpenPair, open, setOpen }: { onOpenSheet: (k: ImageKey) => void; onOpenPicker: () => void; onOpenPair: (id: string) => void; open: boolean; setOpen: (v: boolean) => void }) {
  const s = useApp();
  const keys = useStampKeys();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const afterKeys = new Set(s.trial.pairs.map((p) => p.afterKey));
  const beforeKeys = new Set(s.trial.pairs.map((p) => p.beforeKey));
  return (
    <section class={`card trial-stamps ${open ? 'open' : 'closed'}`} aria-label="スタンプ一覧">
      <div class="stamps-head">
        <h2 class="h-small">スタンプ（{keys.length}）</h2>
        <button class="btn btn-small stamps-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '一覧を閉じる' : 'スタンプを開く'}
        </button>
      </div>
      <div class="stamps-body">
        <div class="row-wrap">
          <button class="btn btn-small" onClick={onOpenPicker} disabled={!s.project.assets.length}>
            プロジェクトの画像から選ぶ
          </button>
          <button class="btn btn-small" disabled={busy} onClick={() => input.current?.click()}>
            画像を読み込む
          </button>
        </div>
        <input
          ref={input}
          type="file"
          multiple
          accept="image/png,image/jpeg,.png,.jpg,.jpeg"
          class="sr-only"
          tabIndex={-1}
          aria-label="試し送りする画像を読み込む"
          data-testid="trial-input"
          onChange={async (e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = '';
            if (!files.length) return;
            setBusy(true);
            try {
              await loadTrialFiles(files);
            } finally {
              setBusy(false);
            }
          }}
        />
        {keys.length === 0 ? (
          <div class="trial-empty">
            <Mascot kind="waiting" alt="空き箱の横で待つマーモット" size={96} />
            <p>
              <strong>梱包する前に、ひとこと送ってみる？</strong>
            </p>
            <p class="muted small">プロジェクトの画像を選ぶか、PNG・JPEGを読み込むと、タップで会話に送れます。画像は外部へ送信しません。</p>
          </div>
        ) : (
          <>
            <p class="muted small">タップで会話に送ります。「…」で詳しく見る・メモ。</p>
            <ul class="stamp-grid">
              {keys.map((k) => {
                const img = imageFor(k)!;
                const note = s.trial.notes[k];
                const sheet = isSheetKey(k);
                return (
                  <li key={k} class="stamp-item">
                    <button class="stamp-send checker" aria-label={`${img.name} を送る`} onClick={() => updateTrial((x) => sendSticker(x, k))}>
                      <StickerImg k={k} label="" />
                    </button>
                    <span class="stamp-name" title={img.name}>
                      {shortName(img.name)}
                    </span>
                    <span class="stamp-tags">
                      {sheet && <span class="pick-tag tag-count">未分割の一覧画像</span>}
                      {afterKeys.has(k) && <span class="pick-tag tag-background">修正後</span>}
                      {beforeKeys.has(k) && <span class="pick-tag">修正前</span>}
                      {note?.tags.map((t) => (
                        <span key={t} class={`note-dot note-${t}`} title={NOTE_TAGS.find((x) => x.id === t)?.label}>
                          {TAG_SHORT[t]}
                        </span>
                      ))}
                      {note?.text ? <span class="note-dot note-text">メモ</span> : null}
                    </span>
                    <button class="btn btn-small stamp-more" aria-label={`${img.name} の詳細とメモ`} onClick={() => onOpenSheet(k)}>
                      …
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {s.trial.pairs.length > 0 && (
          <details class="trial-details">
            <summary>比較の組（{s.trial.pairs.length}）</summary>
            <ul class="pair-list">
              {s.trial.pairs.map((p) => (
                <li key={p.id}>
                  <button class="btn btn-small" onClick={() => onOpenPair(p.id)}>
                    {shortName(imageFor(p.beforeKey)?.name ?? '?', 14)} → {shortName(imageFor(p.afterKey)?.name ?? '?', 14)}
                    {p.adoptedAt ? '（採用済み）' : ''}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}

// ================================================================ 画像の詳細とメモ

function ImageSheet({ k, onClose, compareMode, onPair }: { k: ImageKey; onClose: () => void; compareMode: boolean; onPair: (id: string) => void }) {
  const s = useApp();
  const img = imageFor(k);
  const after = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState(s.trial.notes[k]?.text ?? '');
  useEffect(() => closeRef.current?.focus(), []);
  if (!img) return null;
  const pk = parseKey(k)!;
  const note = s.trial.notes[k];
  const ev = evaluation(s);
  const status = pk.kind === 'project' ? ev.assets[pk.id]?.status : null;
  const stale = pk.kind === 'project' && note?.version !== undefined && note.version !== img.version;
  const inList = pk.kind === 'project' ? s.trial.projectAssetIds.includes(pk.id) : true;
  const usedByPair = isKeyInUseByPair(s.trial, k);
  const saveText = () => {
    if (text !== (note?.text ?? '')) updateTrial((x) => setNoteText(x, k, text, img.version));
  };
  return (
    <div class="modal-backdrop sheet-backdrop" onClick={(e) => e.target === e.currentTarget && (saveText(), onClose())}>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div class="sheet-head">
          <h2 id="sheet-title" class="h-small break">
            {img.name}
          </h2>
          <button
            ref={closeRef}
            class="icon-btn"
            aria-label="閉じる"
            onClick={() => {
              saveText();
              onClose();
            }}
          >
            <IconClose />
          </button>
        </div>
        <div class="sheet-body">
          <div class="sheet-preview checker">
            <StickerImg k={k} label={img.name} />
          </div>
          <p class="small muted">
            {pk.kind === 'project' ? 'プロジェクトの画像' : `試し送りで読み込んだ画像${img.origin ? `（${img.origin}）` : ''}`}
            {isSheetKey(k) ? '。未分割の一覧画像です（分割は編集タブで行えます）' : ''}
          </p>

          {compareMode && (
            <div class="banner banner-info">
              <span>この画像を「修正前」にします。修正した画像（外部のアプリやAIで直したものも可）を読み込むと、並べて比べられます。</span>
              <button class="btn btn-small btn-primary" onClick={() => after.current?.click()}>
                修正後の画像を読み込む
              </button>
            </div>
          )}

          <section class="sheet-section" aria-labelledby="auto-check">
            <h3 id="auto-check" class="h-small">
              自動チェック
            </h3>
            {pk.kind === 'project' ? (
              <div class="row-wrap">
                <StatusPill status={status ?? 'unchecked'} />
                <button class="btn btn-small" onClick={() => showInCheck(pk.id)}>
                  チェックで見る
                </button>
              </div>
            ) : (
              <p class="small muted">プロジェクトに入っていない画像なので、自動チェックはしていません。</p>
            )}
            <p class="small muted">試し送りをしても、チェックの合格にはなりません。</p>
          </section>

          <section class="sheet-section" aria-labelledby="my-note">
            <h3 id="my-note" class="h-small">
              あなたのメモ（自動チェックの結果とは別）
            </h3>
            {stale && <p class="small bad">このメモは差し替える前の画像に書いたものです。</p>}
            <div class="tag-toggles" role="group" aria-label="目印">
              {NOTE_TAGS.map((t) => {
                const on = !!note?.tags.includes(t.id);
                return (
                  <button key={t.id} class={`tag-toggle note-${t.id} ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => updateTrial((x) => toggleTag(x, k, t.id, img.version))}>
                    {t.label}
                  </button>
                );
              })}
            </div>
            <textarea id="trial-note-text" rows={3} placeholder="気づいたことを自由に（例：「ありがとう」の文字が小さい）" value={text} onInput={(e) => setText(e.currentTarget.value)} onBlur={saveText} aria-label="自由記入のメモ" />
          </section>

          <section class="sheet-section" aria-label="操作">
            <div class="sheet-actions">
              <button
                class="btn btn-primary"
                onClick={() => {
                  saveText();
                  updateTrial((x) => sendSticker(x, k));
                  onClose();
                }}
              >
                会話に送る
              </button>
              {!compareMode && (
                <button class="btn" onClick={() => after.current?.click()}>
                  修正版を読み込んで比較
                </button>
              )}
              <button class="btn" onClick={() => exportTrialImage(k)}>
                <IconDownload size={18} /> 元画像を書き出す
              </button>
              {pk.kind === 'project' ? (
                <button
                  class="btn"
                  onClick={() => {
                    saveText();
                    openInEditor(pk.id);
                  }}
                >
                  編集で開く
                </button>
              ) : (
                <button
                  class="btn"
                  onClick={async () => {
                    saveText();
                    await addLocalToProject(k);
                    onClose();
                  }}
                >
                  プロジェクトに追加
                </button>
              )}
              {inList && (
                <button
                  class="btn btn-danger"
                  disabled={usedByPair}
                  title={usedByPair ? '比較の組で使っているため外せません' : undefined}
                  onClick={async () => {
                    const msg = pk.kind === 'project' ? '一覧から外しますか？ プロジェクトの画像とメモは残ります。' : 'この画像を試し送りから削除しますか？ この画像のメモも消えます（プロジェクトには影響しません）。';
                    if (await askConfirm(msg, pk.kind === 'project' ? '一覧から外す' : '削除する', true)) {
                      await removeTrialImage(k);
                      onClose();
                    }
                  }}
                >
                  {pk.kind === 'project' ? '一覧から外す' : '試し送りから削除'}
                </button>
              )}
            </div>
            {pk.kind === 'local' && <p class="small muted">編集やチェックをするには、先に「プロジェクトに追加」してください。</p>}
          </section>
        </div>
        <input
          ref={after}
          type="file"
          accept="image/png,image/jpeg,.png,.jpg,.jpeg"
          class="sr-only"
          tabIndex={-1}
          aria-label="修正後の画像を読み込む"
          data-testid="trial-after-input"
          onChange={async (e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (!f) return;
            saveText();
            const id = await loadAfterImage(k, f);
            if (id) {
              onClose();
              onPair(id);
            }
          }}
        />
      </div>
    </div>
  );
}

// ================================================================ プロジェクトの画像から選ぶ

function ProjectPicker({ onClose }: { onClose: () => void }) {
  const s = useApp();
  const ev = evaluation(s);
  const already = new Set(s.trial.projectAssetIds);
  const sheets = new Set(unsplitSheets(s.project.assets, s.dims, LINE_TEMPLATE).map((a) => a.id));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const assets = s.project.assets;
  const inRoles = assets.filter((a) => ev.assets[a.id]?.inScope && !already.has(a.id) && !sheets.has(a.id));
  const ordered = useMemo(() => {
    // スタンプの並び順（01, 02 …）を優先
    const order = new Map<string, number>();
    let n = 0;
    for (const se of ev.scopes) for (const re of se.roles) for (const r of re.refs) if (!order.has(r.assetId)) order.set(r.assetId, n++);
    return [...assets].sort((a, b) => (order.get(a.id) ?? 1e6) - (order.get(b.id) ?? 1e6));
  }, [assets, ev]);
  return (
    <div class="modal-backdrop sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="picker-title">
        <div class="sheet-head">
          <h2 id="picker-title" class="h-small">
            プロジェクトの画像から選ぶ
          </h2>
          <button class="icon-btn" aria-label="閉じる" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div class="sheet-body">
          <p class="small muted">画像はコピーせず、プロジェクトの画像をそのまま使います。未分割の一覧画像は、編集タブで分割すると選べます。</p>
          <button class="btn btn-small" disabled={!inRoles.length} onClick={() => setPicked(new Set(inRoles.map((a) => a.id)))}>
            役割を割り当てた画像をすべて選ぶ（{inRoles.length}）
          </button>
          <ul class="picker-grid">
            {ordered.map((a) => {
              const isSheet = sheets.has(a.id);
              const done = already.has(a.id);
              const on = picked.has(a.id);
              return (
                <li key={a.id}>
                  <button
                    class={`picker-item ${on ? 'on' : ''}`}
                    disabled={isSheet || done}
                    aria-pressed={on}
                    onClick={() =>
                      setPicked((prev) => {
                        const n = new Set(prev);
                        if (n.has(a.id)) n.delete(a.id);
                        else n.add(a.id);
                        return n;
                      })
                    }
                  >
                    <span class="pick-thumb checker">{s.thumbs[a.id]?.url ? <img src={s.thumbs[a.id]!.url!} alt="" /> : null}</span>
                    <span class="pick-name">{shortName(a.originalName, 15)}</span>
                    <span class="small">{isSheet ? '未分割の一覧画像' : done ? '追加済み' : on ? '選択中' : ''}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div class="sheet-actions">
            <button
              class="btn btn-primary"
              disabled={!picked.size}
              onClick={() => {
                updateTrial((x) => addProjectImages(x, ordered.filter((a) => picked.has(a.id)).map((a) => a.id)));
                onClose();
              }}
            >
              選んだ{picked.size}枚を一覧に追加
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ================================================================ 画面全体

export function TrialView() {
  const s = useApp();
  const [sheet, setSheet] = useState<{ key: ImageKey; compare: boolean } | null>(null);
  const [picker, setPicker] = useState(false);
  const [pairId, setPairId] = useState<string | null>(null);
  const [stampsOpen, setStampsOpen] = useState(true);
  const keys = useStampKeys();
  const pair = pairId ? s.trial.pairs.find((p) => p.id === pairId) : null;

  // 使っていない画像の表示用URLを解放（繰り返し表示でメモリが増え続けないように）
  useEffect(() => {
    const active = new Set<ImageKey>(keys);
    for (const i of s.trial.conversation.items) if (i.imageKey) active.add(i.imageKey);
    for (const p of s.trial.pairs) {
      active.add(p.beforeKey);
      active.add(p.afterKey);
    }
    if (sheet) active.add(sheet.key);
    releaseUnusedUrls(active);
  });
  useEffect(() => () => releaseUnusedUrls(new Set()), []);

  return (
    <div class="trial-ws">
      <div class="trial-head">
        <h1>試し送り</h1>
        <p class="muted">架空のトーク画面で、文字の読みやすさや印象、会話での使いやすさを確かめます。編集やチェックの前でも使えます。</p>
      </div>
      <div class="trial-grid">
        <TopicPanel />
        {pair ? (
          <ComparePanel pair={pair} onClose={() => setPairId(null)} />
        ) : (
          <ChatPanel onOpenSheet={(k) => setSheet({ key: k, compare: false })} onCompareFrom={(k) => setSheet({ key: k, compare: true })} />
        )}
        <StampPanel onOpenSheet={(k) => setSheet({ key: k, compare: false })} onOpenPicker={() => setPicker(true)} onOpenPair={setPairId} open={stampsOpen} setOpen={setStampsOpen} />
      </div>
      {sheet && <ImageSheet k={sheet.key} compareMode={sheet.compare} onClose={() => setSheet(null)} onPair={(id) => setPairId(id)} />}
      {picker && <ProjectPicker onClose={() => setPicker(false)} />}
    </div>
  );
}
