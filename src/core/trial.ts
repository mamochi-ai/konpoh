// 試し送り：架空のトーク画面でスタンプを試すためのデータと操作（純粋関数）。
// 実際のLINEへの送信や外部通信はしない。販売前チェックの結果とは別に管理する。

export const TRIAL_SCHEMA_VERSION = 1;

/** 画像の安定キー。プロジェクトの画像は p:assetId、試し送りで読み込んだ画像は t:id（ファイル名では紐付けない） */
export type ImageKey = string;
export const projectKey = (assetId: string): ImageKey => `p:${assetId}`;
export const localKey = (id: string): ImageKey => `t:${id}`;
export function parseKey(key: ImageKey): { kind: 'project' | 'local'; id: string } | null {
  if (key.startsWith('p:')) return { kind: 'project', id: key.slice(2) };
  if (key.startsWith('t:')) return { kind: 'local', id: key.slice(2) };
  return null;
}

export const NOTE_TAGS = [
  { id: 'hard-to-read', label: '文字が読みにくい' },
  { id: 'edge', label: '背景や白縁を調整したい' },
  { id: 'pose', label: '表情やポーズを調整したい' },
  { id: 'ok', label: 'このままでよさそう' },
] as const;
export type NoteTag = (typeof NOTE_TAGS)[number]['id'];

/** 利用者の感想（自動チェックの結果とは別物） */
export interface ImageNote {
  tags: NoteTag[];
  text: string;
  /** プロジェクトの画像の場合、メモを書いたときの版（差し替え後に古いメモだと分かるように） */
  version?: number;
  updatedAt: string;
}

export interface Topic {
  id: string;
  category: string;
  text: string;
  builtIn: boolean;
}

export interface ChatItem {
  id: string;
  side: 'partner' | 'me';
  kind: 'text' | 'sticker';
  text?: string;
  imageKey?: ImageKey;
}

export interface Conversation {
  topicId: string | null;
  items: ChatItem[];
}

export type TrialBg = 'light' | 'dark' | 'blue' | 'custom';
export type TrialSize = 's' | 'm' | 'l';

export interface TrialSettings {
  bg: TrialBg;
  customColor: string;
  size: TrialSize;
  /** true: 相手から受け取った側の見え方（スタンプが左） */
  receiverView: boolean;
}

/** 試し送りで読み込んだ画像の情報（画像本体は別の保存領域） */
export interface LocalImageMeta {
  id: string;
  name: string;
  size: number;
  sha256: string;
  addedAt: string;
  /** 比較のために残した「修正前」のコピーなど、由来の説明 */
  origin?: string;
  width?: number;
  height?: number;
}

export interface ComparePair {
  id: string;
  beforeKey: ImageKey;
  afterKey: ImageKey;
  createdAt: string;
  /** プロジェクトへ採用済みなら、その日時と対象 */
  adoptedAt?: string;
  adoptedAssetId?: string;
}

export interface TrialData {
  schemaVersion: 1;
  /** 一覧に並べたプロジェクトの画像（参照だけ。画像は複製しない） */
  projectAssetIds: string[];
  localImages: LocalImageMeta[];
  notes: Record<ImageKey, ImageNote>;
  customTopics: Topic[];
  settings: TrialSettings;
  conversation: Conversation;
  pairs: ComparePair[];
  updatedAt: string;
}

// ---------------------------------------------------------------- お題（固定データ。AI生成はしない）

const BUILTIN: [string, string[]][] = [
  ['家族', ['今日、帰りに牛乳買ってきてもらえる？', '晩ごはんできたよ', '今日はちょっと疲れたなあ']],
  ['仕事', ['資料の確認をお願いします', '対応してくれて助かりました！', '今日はここまでにしましょう。お疲れさまでした']],
  ['友達', ['これ、めっちゃよくない？', '試験受かった！', '今日は何もしたくない…']],
  ['待ち合わせ', ['ごめん、10分くらい遅れそう！', 'もう着いたよ。どのあたり？', '今から向かうね']],
  ['ねぎらい', ['やっと終わった…', '最近ちょっと忙しくて', '明日、大事な発表なんだ']],
];

export const BUILTIN_TOPICS: Topic[] = BUILTIN.flatMap(([category, texts], ci) =>
  texts.map((text, i) => ({ id: `b-${ci + 1}-${i + 1}`, category, text, builtIn: true })),
);
export const CUSTOM_CATEGORY = '自作';

export function allTopics(d: TrialData): Topic[] {
  return [...BUILTIN_TOPICS, ...d.customTopics];
}

// ---------------------------------------------------------------- 初期値と読込

export const DEFAULT_SETTINGS: TrialSettings = { bg: 'light', customColor: '#e8f0e6', size: 'm', receiverView: false };

let seq = 0;
export function newId(prefix: string): string {
  seq = (seq + 1) % 1e6;
  const r = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${r}`;
}

export function topicMessage(t: Topic): ChatItem {
  return { id: newId('msg'), side: 'partner', kind: 'text', text: t.text };
}

export function newTrialData(): TrialData {
  const first = BUILTIN_TOPICS[0];
  return {
    schemaVersion: 1,
    projectAssetIds: [],
    localImages: [],
    notes: {},
    customTopics: [],
    settings: { ...DEFAULT_SETTINGS },
    conversation: { topicId: first.id, items: [topicMessage(first)] },
    pairs: [],
    updatedAt: new Date().toISOString(),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const COLOR_RE = /^#[0-9a-f]{6}$/i;

/** 保存データを読み込む。未知の版や壊れた値は捨てて初期値で補う */
export function normalizeTrialData(raw: unknown): TrialData {
  const d = newTrialData();
  if (!isObj(raw) || raw.schemaVersion !== TRIAL_SCHEMA_VERSION) return d;
  if (Array.isArray(raw.projectAssetIds)) d.projectAssetIds = [...new Set(raw.projectAssetIds.filter((x): x is string => typeof x === 'string'))];
  if (Array.isArray(raw.localImages)) {
    d.localImages = raw.localImages.filter((m): m is LocalImageMeta => isObj(m) && typeof m.id === 'string' && typeof m.name === 'string');
  }
  if (isObj(raw.notes)) {
    for (const [k, v] of Object.entries(raw.notes)) {
      if (!parseKey(k) || !isObj(v)) continue;
      const tags = Array.isArray(v.tags) ? v.tags.filter((t): t is NoteTag => NOTE_TAGS.some((x) => x.id === t)) : [];
      const text = typeof v.text === 'string' ? v.text.slice(0, 2000) : '';
      d.notes[k] = { tags, text, version: typeof v.version === 'number' ? v.version : undefined, updatedAt: String(v.updatedAt ?? '') };
    }
  }
  if (Array.isArray(raw.customTopics)) {
    d.customTopics = raw.customTopics
      .filter((t): t is Topic => isObj(t) && typeof t.id === 'string' && typeof t.text === 'string')
      .map((t) => ({ id: t.id, category: CUSTOM_CATEGORY, text: t.text.slice(0, 500), builtIn: false }));
  }
  if (isObj(raw.settings)) {
    const s = raw.settings;
    d.settings = {
      bg: ['light', 'dark', 'blue', 'custom'].includes(s.bg as string) ? (s.bg as TrialBg) : DEFAULT_SETTINGS.bg,
      customColor: typeof s.customColor === 'string' && COLOR_RE.test(s.customColor) ? s.customColor : DEFAULT_SETTINGS.customColor,
      size: ['s', 'm', 'l'].includes(s.size as string) ? (s.size as TrialSize) : DEFAULT_SETTINGS.size,
      receiverView: s.receiverView === true,
    };
  }
  if (isObj(raw.conversation) && Array.isArray(raw.conversation.items)) {
    d.conversation = {
      topicId: typeof raw.conversation.topicId === 'string' ? raw.conversation.topicId : null,
      items: raw.conversation.items.filter(
        (i): i is ChatItem =>
          isObj(i) && typeof i.id === 'string' && (i.side === 'partner' || i.side === 'me') && (i.kind === 'text' ? typeof i.text === 'string' : i.kind === 'sticker' && typeof i.imageKey === 'string'),
      ),
    };
  }
  if (Array.isArray(raw.pairs)) {
    d.pairs = raw.pairs.filter((p): p is ComparePair => isObj(p) && typeof p.id === 'string' && typeof p.beforeKey === 'string' && typeof p.afterKey === 'string');
  }
  d.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : d.updatedAt;
  return d;
}

const touch = (d: TrialData): TrialData => ({ ...d, updatedAt: new Date().toISOString() });

// ---------------------------------------------------------------- 会話

export function sendSticker(d: TrialData, key: ImageKey): TrialData {
  const item: ChatItem = { id: newId('msg'), side: 'me', kind: 'sticker', imageKey: key };
  return touch({ ...d, conversation: { ...d.conversation, items: [...d.conversation.items, item] } });
}

/** 最後に送ったスタンプを取り消す（相手のメッセージは残す） */
export function undoLastSticker(d: TrialData): TrialData {
  const items = d.conversation.items;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].side === 'me') return touch({ ...d, conversation: { ...d.conversation, items: items.filter((_, j) => j !== i) } });
  }
  return d;
}

export function removeItem(d: TrialData, itemId: string): TrialData {
  return touch({ ...d, conversation: { ...d.conversation, items: d.conversation.items.filter((i) => i.id !== itemId) } });
}

/** 会話を、選んでいるお題の最初のメッセージだけに戻す。画像とメモは消さない */
export function resetConversation(d: TrialData): TrialData {
  const t = allTopics(d).find((x) => x.id === d.conversation.topicId);
  return touch({ ...d, conversation: { topicId: t?.id ?? null, items: t ? [topicMessage(t)] : [] } });
}

/**
 * お題を切り替える。
 * keep: 今の会話を残し、新しいお題の相手メッセージを続けて表示
 * fresh: 新しいお題で会話を始め直す
 */
export function switchTopic(d: TrialData, topicId: string, mode: 'keep' | 'fresh'): TrialData {
  const t = allTopics(d).find((x) => x.id === topicId);
  if (!t) return d;
  const items = mode === 'keep' ? [...d.conversation.items, topicMessage(t)] : [topicMessage(t)];
  return touch({ ...d, conversation: { topicId, items } });
}

export function hasSentStickers(d: TrialData): boolean {
  return d.conversation.items.some((i) => i.side === 'me');
}

export function editMessage(d: TrialData, itemId: string, text: string): TrialData {
  const v = text.slice(0, 500);
  return touch({ ...d, conversation: { ...d.conversation, items: d.conversation.items.map((i) => (i.id === itemId && i.kind === 'text' ? { ...i, text: v } : i)) } });
}

export function addPartnerMessage(d: TrialData, text: string): TrialData {
  const v = text.trim().slice(0, 500);
  if (!v) return d;
  return touch({ ...d, conversation: { ...d.conversation, items: [...d.conversation.items, { id: newId('msg'), side: 'partner', kind: 'text', text: v }] } });
}

// ---------------------------------------------------------------- 自作のお題

export function addCustomTopic(d: TrialData, text: string): { data: TrialData; topic: Topic | null } {
  const v = text.trim().slice(0, 500);
  if (!v) return { data: d, topic: null };
  const topic: Topic = { id: newId('topic'), category: CUSTOM_CATEGORY, text: v, builtIn: false };
  return { data: touch({ ...d, customTopics: [...d.customTopics, topic] }), topic };
}

export function updateCustomTopic(d: TrialData, id: string, text: string): TrialData {
  const v = text.trim().slice(0, 500);
  if (!v) return d;
  return touch({ ...d, customTopics: d.customTopics.map((t) => (t.id === id ? { ...t, text: v } : t)) });
}

export function removeCustomTopic(d: TrialData, id: string): TrialData {
  return touch({ ...d, customTopics: d.customTopics.filter((t) => t.id !== id), conversation: d.conversation.topicId === id ? { ...d.conversation, topicId: null } : d.conversation });
}

// ---------------------------------------------------------------- メモ（利用者の感想）

export function toggleTag(d: TrialData, key: ImageKey, tag: NoteTag, version?: number): TrialData {
  const cur = d.notes[key] ?? { tags: [], text: '', updatedAt: '' };
  let tags = cur.tags.includes(tag) ? cur.tags.filter((t) => t !== tag) : [...cur.tags, tag];
  // 「このままでよさそう」と調整したい目印は同時に付けない
  if (tag === 'ok' && tags.includes('ok')) tags = ['ok'];
  else if (tag !== 'ok') tags = tags.filter((t) => t !== 'ok');
  return touch({ ...d, notes: { ...d.notes, [key]: { ...cur, tags, version, updatedAt: new Date().toISOString() } } });
}

export function setNoteText(d: TrialData, key: ImageKey, text: string, version?: number): TrialData {
  const cur = d.notes[key] ?? { tags: [], text: '', updatedAt: '' };
  return touch({ ...d, notes: { ...d.notes, [key]: { ...cur, text: text.slice(0, 2000), version, updatedAt: new Date().toISOString() } } });
}

// ---------------------------------------------------------------- 画像の一覧

export function addProjectImages(d: TrialData, assetIds: string[]): TrialData {
  const ids = [...d.projectAssetIds];
  for (const id of assetIds) if (!ids.includes(id)) ids.push(id);
  return touch({ ...d, projectAssetIds: ids });
}

export function addLocalImages(d: TrialData, metas: LocalImageMeta[]): TrialData {
  return touch({ ...d, localImages: [...d.localImages, ...metas] });
}

/** 一覧から外す。プロジェクトの画像は参照を外すだけ（画像もメモも消さない） */
export function removeFromList(d: TrialData, key: ImageKey): TrialData {
  const k = parseKey(key);
  if (!k) return d;
  if (k.kind === 'project') return touch({ ...d, projectAssetIds: d.projectAssetIds.filter((x) => x !== k.id) });
  // 試し送りで読み込んだ画像は削除。比較の組で使われていれば残す
  if (d.pairs.some((p) => p.beforeKey === key || p.afterKey === key)) return d;
  const notes = { ...d.notes };
  delete notes[key];
  return touch({ ...d, localImages: d.localImages.filter((m) => m.id !== k.id), notes });
}

export function isKeyInUseByPair(d: TrialData, key: ImageKey): boolean {
  return d.pairs.some((p) => p.beforeKey === key || p.afterKey === key);
}

/**
 * 試し送りで読み込んだ画像をプロジェクトに追加したあと、同じ画像が二重にならないよう参照を付け替える。
 * メモ・会話・比較の組の参照もプロジェクトの画像へ移す。
 */
export function convertLocalToProject(d: TrialData, localId: string, assetId: string): TrialData {
  const from = localKey(localId);
  const to = projectKey(assetId);
  const notes = { ...d.notes };
  if (notes[from]) {
    notes[to] = { ...notes[from], version: 1 };
    delete notes[from];
  }
  return touch({
    ...d,
    localImages: d.localImages.filter((m) => m.id !== localId),
    projectAssetIds: d.projectAssetIds.includes(assetId) ? d.projectAssetIds : [...d.projectAssetIds, assetId],
    notes,
    conversation: { ...d.conversation, items: d.conversation.items.map((i) => (i.imageKey === from ? { ...i, imageKey: to } : i)) },
    pairs: d.pairs.map((p) => ({ ...p, beforeKey: p.beforeKey === from ? to : p.beforeKey, afterKey: p.afterKey === from ? to : p.afterKey })),
  });
}

// ---------------------------------------------------------------- 修正前後の比較

export function addPair(d: TrialData, beforeKey: ImageKey, afterKey: ImageKey): { data: TrialData; pair: ComparePair } {
  const pair: ComparePair = { id: newId('pair'), beforeKey, afterKey, createdAt: new Date().toISOString() };
  return { data: touch({ ...d, pairs: [...d.pairs, pair] }), pair };
}

export function removePair(d: TrialData, id: string): TrialData {
  return touch({ ...d, pairs: d.pairs.filter((p) => p.id !== id) });
}

/**
 * 修正後をプロジェクトに採用したあとの記録。
 * 修正前がプロジェクトの画像だった場合、差し替えで消える元の画像を keptBeforeKey（試し送り側のコピー）として残す。
 */
export function markAdopted(d: TrialData, pairId: string, assetId: string, keptBefore?: { meta: LocalImageMeta; key: ImageKey }): TrialData {
  let next = { ...d };
  if (keptBefore) next = { ...next, localImages: [...next.localImages, keptBefore.meta] };
  next.pairs = next.pairs.map((p) =>
    p.id === pairId ? { ...p, beforeKey: keptBefore ? keptBefore.key : p.beforeKey, adoptedAt: new Date().toISOString(), adoptedAssetId: assetId } : p,
  );
  // 修正前のメモは修正前のコピーへ移す（差し替え後の画像に古い感想が付かないように）
  if (keptBefore) {
    const pair = d.pairs.find((p) => p.id === pairId);
    if (pair && next.notes[pair.beforeKey]) {
      const notes = { ...next.notes, [keptBefore.key]: next.notes[pair.beforeKey] };
      delete notes[pair.beforeKey];
      next.notes = notes;
    }
  }
  return touch(next);
}

// ---------------------------------------------------------------- 表示

export const SIZE_PX: Record<TrialSize, number> = { s: 112, m: 150, l: 190 };
export const SIZE_LABEL: Record<TrialSize, string> = { s: '小さめ', m: '標準', l: '大きめ' };

export function bgColor(s: TrialSettings): string {
  if (s.bg === 'dark') return '#1f2523';
  if (s.bg === 'blue') return '#dbe8f1';
  if (s.bg === 'custom') return s.customColor;
  return '#fbfaf6';
}

/** 背景が暗いか（相手の吹き出しや文字の色を切り替える） */
export function isDarkColor(hex: string): boolean {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return false;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => {
    const c = parseInt(x, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.25;
}
