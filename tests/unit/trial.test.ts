// 試し送り：会話・メモ・比較の操作（画像やメモを消さないこと）
import { describe, expect, it } from 'vitest';
import {
  addCustomTopic,
  addLocalImages,
  addPair,
  addPartnerMessage,
  addProjectImages,
  BUILTIN_TOPICS,
  editMessage,
  hasSentStickers,
  isDarkColor,
  localKey,
  markAdopted,
  newTrialData,
  normalizeTrialData,
  projectKey,
  removeFromList,
  removeItem,
  resetConversation,
  sendSticker,
  setNoteText,
  switchTopic,
  toggleTag,
  undoLastSticker,
} from '../../src/core/trial';

const meta = (id: string, name: string) => ({ id, name, size: 1, sha256: 'x', addedAt: '' });

describe('お題', () => {
  it('5カテゴリ×3パターンを固定データで持つ', () => {
    const cats = [...new Set(BUILTIN_TOPICS.map((t) => t.category))];
    expect(cats).toEqual(['家族', '仕事', '友達', '待ち合わせ', 'ねぎらい']);
    expect(BUILTIN_TOPICS.length).toBe(15);
    expect(BUILTIN_TOPICS.map((t) => t.text)).toContain('ごめん、10分くらい遅れそう！');
  });
  it('切替：残して続ける／新しく始める。送ったスタンプは意図せず消えない', () => {
    let d = newTrialData();
    d = sendSticker(d, projectKey('a1'));
    expect(hasSentStickers(d)).toBe(true);
    const kept = switchTopic(d, 'b-2-1', 'keep');
    expect(kept.conversation.items.map((i) => i.kind)).toEqual(['text', 'sticker', 'text']);
    expect(kept.conversation.items[2].text).toBe('資料の確認をお願いします');
    const fresh = switchTopic(d, 'b-2-1', 'fresh');
    expect(fresh.conversation.items.length).toBe(1);
  });
  it('会話文の編集と自作のお題', () => {
    let d = newTrialData();
    const first = d.conversation.items[0].id;
    d = editMessage(d, first, 'ただいま！');
    expect(d.conversation.items[0].text).toBe('ただいま！');
    d = addPartnerMessage(d, '  ');
    expect(d.conversation.items.length).toBe(1);
    d = addPartnerMessage(d, 'おなかすいた');
    expect(d.conversation.items.length).toBe(2);
    const r = addCustomTopic(d, '週末どこ行く？');
    expect(r.topic!.category).toBe('自作');
    expect(switchTopic(r.data, r.topic!.id, 'fresh').conversation.items[0].text).toBe('週末どこ行く？');
  });
});

describe('取り消し・リセットで画像とメモを消さない', () => {
  it('最後の送信だけ取り消す／リセットは会話だけ', () => {
    let d = newTrialData();
    d = addLocalImages(d, [meta('i1', 'a.png'), meta('i2', 'b.png')]);
    d = setNoteText(d, localKey('i1'), '文字が小さい');
    d = sendSticker(d, localKey('i1'));
    d = sendSticker(d, localKey('i2'));
    d = undoLastSticker(d);
    expect(d.conversation.items.filter((i) => i.side === 'me').map((i) => i.imageKey)).toEqual([localKey('i1')]);
    d = resetConversation(d);
    expect(d.conversation.items.length).toBe(1);
    expect(d.localImages.length).toBe(2);
    expect(d.notes[localKey('i1')].text).toBe('文字が小さい');
    expect(undoLastSticker(d)).toBe(d); // 取り消すものがなければ何もしない
  });
  it('送信済みの1件を削除', () => {
    let d = sendSticker(newTrialData(), projectKey('a'));
    const id = d.conversation.items[1].id;
    d = removeItem(d, id);
    expect(d.conversation.items.length).toBe(1);
  });
});

describe('メモは安定IDで管理（同名ファイルでも混ざらない）', () => {
  it('同じ名前の2枚に別々のメモ', () => {
    let d = addLocalImages(newTrialData(), [meta('x1', 'same.png'), meta('x2', 'same.png')]);
    d = toggleTag(d, localKey('x1'), 'hard-to-read');
    expect(d.notes[localKey('x1')].tags).toEqual(['hard-to-read']);
    expect(d.notes[localKey('x2')]).toBeUndefined();
  });
  it('「このままでよさそう」と調整の目印は同時に付かない', () => {
    let d = toggleTag(newTrialData(), 'p:a', 'hard-to-read');
    d = toggleTag(d, 'p:a', 'ok');
    expect(d.notes['p:a'].tags).toEqual(['ok']);
    d = toggleTag(d, 'p:a', 'pose');
    expect(d.notes['p:a'].tags).toEqual(['pose']);
  });
  it('一覧から外す：プロジェクト画像は参照だけ外しメモは残す。比較で使う画像は消さない', () => {
    let d = addProjectImages(newTrialData(), ['a', 'b', 'a']);
    expect(d.projectAssetIds).toEqual(['a', 'b']);
    d = setNoteText(d, 'p:a', 'メモ');
    d = removeFromList(d, 'p:a');
    expect(d.projectAssetIds).toEqual(['b']);
    expect(d.notes['p:a'].text).toBe('メモ');
    d = addLocalImages(d, [meta('n1', 'new.png')]);
    d = addPair(d, 'p:b', localKey('n1')).data;
    expect(removeFromList(d, localKey('n1')).localImages.length).toBe(1);
  });
});

describe('修正前後の比較と採用', () => {
  it('採用時、差し替えで消える修正前をコピーとして残し、メモも移す', () => {
    let d = addProjectImages(newTrialData(), ['a']);
    d = setNoteText(d, 'p:a', '文字が読みにくい');
    d = addLocalImages(d, [meta('after', 'a-fixed.png')]);
    const { data, pair } = addPair(d, 'p:a', localKey('after'));
    const kept = { meta: meta('before-copy', 'a.png'), key: localKey('before-copy') };
    const done = markAdopted(data, pair.id, 'a', kept);
    const p = done.pairs[0];
    expect(p.beforeKey).toBe(localKey('before-copy'));
    expect(p.afterKey).toBe(localKey('after'));
    expect(p.adoptedAssetId).toBe('a');
    expect(done.notes['p:a']).toBeUndefined();
    expect(done.notes[localKey('before-copy')].text).toBe('文字が読みにくい');
    expect(done.localImages.map((m) => m.id)).toEqual(['after', 'before-copy']);
  });
});

describe('保存データの読込', () => {
  it('往復で同じ・未知の版や壊れた値は初期値', () => {
    let d = addLocalImages(newTrialData(), [meta('i', 'a.png')]);
    d = toggleTag(d, 't:i', 'edge');
    d = { ...d, settings: { bg: 'custom', customColor: '#123456', size: 'l', receiverView: true } };
    expect(normalizeTrialData(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(normalizeTrialData({ schemaVersion: 99 }).localImages).toEqual([]);
    const bad = normalizeTrialData({ schemaVersion: 1, settings: { bg: 'neon', customColor: 'red', size: 'xl' }, notes: { 'zz': {}, 'p:a': { tags: ['ok', 'nope'], text: 1 } } });
    expect(bad.settings.bg).toBe('light');
    expect(bad.settings.customColor).toBe('#e8f0e6');
    expect(bad.notes).toEqual({ 'p:a': { tags: ['ok'], text: '', version: undefined, updatedAt: '' } });
  });
  it('暗い色の判定', () => {
    expect(isDarkColor('#1f2523')).toBe(true);
    expect(isDarkColor('#fbfaf6')).toBe(false);
    expect(isDarkColor('#dbe8f1')).toBe(false);
  });
});
