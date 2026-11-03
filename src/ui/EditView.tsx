import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { addDerivedAssets, evaluation, exportOriginal, replaceAssetFile, setEdit, setState, toast, useApp } from '../app/store';
import { decodeAssetRaster } from '../app/imaging';
import type { AssetRecord } from '../core/types';
import {
  backgroundMask,
  cellsFromLines,
  contentRect,
  estimateBackground,
  findGapLines,
  gridLines,
  prepareCell,
  removeBackground,
  SIZE_PRESETS,
  type Raster,
  type Rgb,
} from '../core/edit/raster';
import { encodePng } from '../core/edit/png';
import { Mascot } from './common';
import { IconDownload, IconSwap } from './icons';

const yieldTick = () => new Promise<void>((r) => setTimeout(r, 0));

function stemOf(name: string): string {
  return name.replace(/\.[^.]*$/, '') || 'image';
}

function hex(c: Rgb): string {
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
function fromHex(h: string): Rgb {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255];
}

/** Rasterをcanvasに描く。子要素は画像の上に重ねる */
function RasterView({ raster, bg = 'checker', children, onPick, label }: { raster: Raster; bg?: string; children?: ComponentChildren; onPick?: (x: number, y: number) => void; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = raster.width;
    c.height = raster.height;
    const ctx = c.getContext('2d');
    ctx?.putImageData(new ImageData(new Uint8ClampedArray(raster.data), raster.width, raster.height), 0, 0);
  }, [raster]);
  return (
    <div class={`raster-wrap preview-bg-${bg}`}>
      <div class="raster-box">
        <canvas
          ref={ref}
          role="img"
          aria-label={label}
          class={onPick ? 'pickable' : ''}
          onClick={(e) => {
            if (!onPick) return;
            const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
            onPick(Math.floor(((e.clientX - r.left) / r.width) * raster.width), Math.floor(((e.clientY - r.top) / r.height) * raster.height));
          }}
        />
        {children}
      </div>
    </div>
  );
}

function BgSwitch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div class="seg seg-inline" role="radiogroup" aria-label="確認用の背景">
      {(
        [
          ['checker', '市松'],
          ['white', '白'],
          ['black', '黒'],
        ] as const
      ).map(([k, l]) => (
        <button key={k} role="radio" aria-checked={value === k} class={`seg-btn ${value === k ? 'on' : ''}`} onClick={() => onChange(k)}>
          {l}
        </button>
      ))}
    </div>
  );
}

function Stepper({ id, label, value, min, max, onChange }: { id: string; label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div class="field">
      <label for={id}>{label}</label>
      <div class="stepper">
        <button class="btn btn-small" aria-label={`${label}を減らす`} disabled={value <= min} onClick={() => onChange(value - 1)}>
          −
        </button>
        <input id={id} inputMode="numeric" value={value} onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.currentTarget.value) || min)))} />
        <button class="btn btn-small" aria-label={`${label}を増やす`} disabled={value >= max} onClick={() => onChange(value + 1)}>
          ＋
        </button>
      </div>
    </div>
  );
}

function useRoleOptions() {
  const s = useApp();
  const ev = evaluation(s);
  const opts = ev.scopes.flatMap((se) =>
    se.roles.map((re) => ({ value: `${se.scope.template.id}|${re.role.id}`, label: ev.scopes.length > 1 ? `${se.scope.template.name}／${re.label}` : re.label, roleId: re.role.id })),
  );
  return opts.filter((o, i) => opts.findIndex((x) => x.value === o.value) === i);
}

// ================================================================ 背景透過

function BackgroundTool({ asset, raster }: { asset: AssetRecord; raster: Raster }) {
  const s = useApp();
  const est = useMemo(() => estimateBackground(raster), [raster]);
  const [color, setColor] = useState<Rgb>(est.kind === 'color' ? est.rgb : [255, 255, 255]);
  const [tolerance, setTolerance] = useState(30);
  const [contiguous, setContiguous] = useState(true);
  const [soften, setSoften] = useState(true);
  const [view, setView] = useState('checker');
  const hasRoles = s.project.refs.some((r) => r.assetId === asset.id);
  const [transfer, setTransfer] = useState(hasRoles);
  const [busy, setBusy] = useState(false);
  const result = useMemo(() => removeBackground(raster, { color, tolerance, contiguous, soften }), [raster, color, tolerance, contiguous, soften]);
  const total = raster.width * raster.height;
  const pct = Math.round((result.removed / total) * 1000) / 10;

  const add = async () => {
    setBusy(true);
    try {
      await yieldTick();
      const bytes = encodePng(result.raster);
      const detail = `背景色${hex(color)}・許容${tolerance}・${contiguous ? '外側からつながる部分' : '同じ色すべて'}${soften ? '・境界なめらか' : ''}`;
      const ids = await addDerivedAssets(asset, [{ name: `${stemOf(asset.originalName)}-transparent.png`, bytes }], 'background', detail, { transferRoles: transfer });
      toast(`透過した画像を追加しました${transfer ? '（役割を引き継ぎました）' : ''}。元の画像はそのまま残っています。`, 'success');
      setEdit({ assetId: ids[0] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="tool">
      <p class="muted small">
        単色の背景を、色の近さで透明にします。AIによる切り抜きではありません。写真やグラデーションの背景、絵の中で背景と同じ色の部分（外側とつながっているもの）はうまく扱えません。結果は新しい画像として追加し、元の画像は変えません。
      </p>
      {est.kind === 'transparent' && <p class="banner banner-info">この画像の外周はすでに透明です。白い部分などを消したい場合は、下で背景色を選んでください。</p>}
      <div class="tool-grid">
        <div class="tool-controls card">
          <div class="field">
            <span>背景色（元の画像をタップしても選べます）</span>
            <div class="color-row">
              <span class="swatch" style={{ background: hex(color) }} aria-hidden="true" />
              <input id="bg-color" type="color" value={hex(color)} onChange={(e) => setColor(fromHex(e.currentTarget.value))} aria-label="背景色" />
              <span class="mono">{hex(color)}</span>
              {est.kind === 'color' && (
                <button class="btn btn-small" onClick={() => setColor(est.rgb)}>
                  自動推定に戻す
                </button>
              )}
            </div>
          </div>
          <div class="field">
            <label for="bg-tol">色の許容幅：{tolerance}</label>
            <input id="bg-tol" type="range" min={0} max={120} step={2} value={tolerance} onChange={(e) => setTolerance(Number(e.currentTarget.value))} />
            <span class="muted small">大きくすると背景に近い色も消えます。絵の白い部分が欠けたら小さくしてください。</span>
          </div>
          <label class="check">
            <input id="bg-contig" type="checkbox" checked={contiguous} onChange={(e) => setContiguous(e.currentTarget.checked)} />
            外側からつながっている部分だけ消す（おすすめ）
          </label>
          <label class="check">
            <input id="bg-soft" type="checkbox" checked={soften} onChange={(e) => setSoften(e.currentTarget.checked)} />
            境目をなめらかにする
          </label>
          <p class="small">
            透明にした画素：{result.removed.toLocaleString()} / {total.toLocaleString()}（{pct}%）
          </p>
          {hasRoles && (
            <label class="check">
              <input id="bg-transfer" type="checkbox" checked={transfer} onChange={(e) => setTransfer(e.currentTarget.checked)} />
              元の画像の役割（スタンプ番号など）を新しい画像に引き継ぐ
            </label>
          )}
          <button class="btn btn-primary" disabled={busy || result.removed === 0 || !!s.job} onClick={add}>
            {busy ? '作成中…' : '透過した画像を追加'}
          </button>
        </div>
        <div class="tool-preview">
          <div class="preview-head">
            <h3 class="h-small">結果</h3>
            <BgSwitch value={view} onChange={setView} />
          </div>
          <RasterView raster={result.raster} bg={view} label="背景を透明にした結果" />
          <h3 class="h-small">元の画像（タップで背景色を選ぶ）</h3>
          <div class="orig-small">
            <RasterView
              raster={raster}
              bg="checker"
              label="元の画像。タップした位置の色を背景色にします"
              onPick={(x, y) => {
                const p = (y * raster.width + x) * 4;
                setColor([raster.data[p], raster.data[p + 1], raster.data[p + 2]]);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ================================================================ 一覧画像の分割

type Sel = { axis: 'x' | 'y'; i: number } | null;

function SplitTool({ asset, raster }: { asset: AssetRecord; raster: Raster }) {
  const s = useApp();
  const W = raster.width;
  const H = raster.height;
  const bg = useMemo(() => estimateBackground(raster), [raster]);
  const [tol] = useState(30);
  const mask = useMemo(() => backgroundMask(raster, bg, tol), [raster, bg, tol]);
  const [minGap, setMinGap] = useState(8);
  const [rows, setRows] = useState(2);
  const [cols, setCols] = useState(2);
  const [xs, setXs] = useState<number[]>([]);
  const [ys, setYs] = useState<number[]>([]);
  const [sel, setSel] = useState<Sel>(null);
  const [trim, setTrim] = useState(true);
  const [presetId, setPresetId] = useState('line-sticker');
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [view, setView] = useState('checker');
  const [busy, setBusy] = useState<string | null>(null);
  const roleOptions = useRoleOptions();
  const defaultAssign = roleOptions.find((o) => o.roleId === 'sticker')?.value ?? '';
  const [assign, setAssign] = useState(defaultAssign);
  const boxRef = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState('');

  const detect = () => {
    const nx = findGapLines(mask, W, H, 'x', minGap);
    const ny = findGapLines(mask, W, H, 'y', minGap);
    setXs(nx);
    setYs(ny);
    setRows(ny.length + 1);
    setCols(nx.length + 1);
    setSel(null);
    setExcluded(new Set());
    setNote(nx.length + ny.length ? `すき間から ${ny.length + 1}行 × ${nx.length + 1}列 を見つけました。線は指でずらすか、選んでボタンで調整できます。` : 'すき間が見つかりませんでした。行・列の数を指定して等分してください。');
  };
  const grid = (r = rows, c = cols) => {
    setXs(gridLines(W, c));
    setYs(gridLines(H, r));
    setSel(null);
    setExcluded(new Set());
    setNote(`${r}行 × ${c}列 に等分しました。`);
  };
  useEffect(() => {
    const nx = findGapLines(mask, W, H, 'x', minGap);
    const ny = findGapLines(mask, W, H, 'y', minGap);
    if (nx.length + ny.length) detect();
    else {
      setRows(1);
      setCols(1);
      grid(1, 1);
      setNote('すき間が見つからないので1枚のままです。一覧画像なら行・列の数を指定して「等分する」を押してください。');
    }
  }, [raster]);

  const cells = useMemo(() => cellsFromLines(W, H, xs, ys), [W, H, xs, ys]);
  const empty = useMemo(() => new Set(cells.filter((c) => !contentRect(mask, W, c)).map((c) => c.index)), [cells, mask]);
  const chosen = cells.filter((c) => !empty.has(c.index) && !excluded.has(c.index));
  const preset = SIZE_PRESETS.find((p) => p.id === presetId)!;

  const sortedXs = [...xs].sort((a, b) => a - b);
  const sortedYs = [...ys].sort((a, b) => a - b);
  const setLine = (axis: 'x' | 'y', i: number, v: number) => {
    const list = axis === 'x' ? sortedXs : sortedYs;
    const lo = (i > 0 ? list[i - 1] : 0) + 1;
    const hi = (i < list.length - 1 ? list[i + 1] : axis === 'x' ? W : H) - 1;
    const next = [...list];
    next[i] = Math.max(lo, Math.min(hi, Math.round(v)));
    if (axis === 'x') setXs(next);
    else setYs(next);
    setExcluded(new Set());
  };
  const addLine = (axis: 'x' | 'y') => {
    const list = axis === 'x' ? sortedXs : sortedYs;
    const bounds = [0, ...list, axis === 'x' ? W : H];
    let best = 0;
    for (let i = 1; i < bounds.length - 1; i++) if (bounds[i + 1] - bounds[i] > bounds[best + 1] - bounds[best]) best = i;
    const v = Math.round((bounds[best] + bounds[best + 1]) / 2);
    const next = [...list, v].sort((a, b) => a - b);
    if (axis === 'x') setXs(next);
    else setYs(next);
    setSel({ axis, i: next.indexOf(v) });
    setExcluded(new Set());
  };
  const removeLine = () => {
    if (!sel) return;
    if (sel.axis === 'x') setXs(sortedXs.filter((_, j) => j !== sel.i));
    else setYs(sortedYs.filter((_, j) => j !== sel.i));
    setSel(null);
    setExcluded(new Set());
  };

  const drag = useRef<{ axis: 'x' | 'y'; i: number } | null>(null);
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    const box = boxRef.current;
    if (!d || !box) return;
    const r = box.getBoundingClientRect();
    const v = d.axis === 'x' ? ((e.clientX - r.left) / r.width) * W : ((e.clientY - r.top) / r.height) * H;
    setLine(d.axis, d.i, v);
  };

  const run = async () => {
    setBusy('切り出し中…');
    try {
      const items = [];
      let k = 0;
      for (const c of chosen) {
        k++;
        setBusy(`切り出し中… ${k}/${chosen.length}`);
        await yieldTick();
        const piece = prepareCell(raster, mask, c, { trim, preset });
        if (!piece) continue;
        items.push({ name: `${stemOf(asset.originalName)}-${String(k).padStart(2, '0')}.png`, bytes: encodePng(piece) });
      }
      const [tid, rid] = assign ? assign.split('|') : [];
      const detail = `${rows}行×${cols}列から${items.length}枚・${preset.label}${trim ? '・余白を詰める' : ''}`;
      await addDerivedAssets(asset, items, 'split', detail, assign ? { assign: { templateId: tid, roleId: rid } } : {});
      toast(`${items.length}枚を切り出して追加しました${assign ? '（役割を割り当てました）' : ''}。チェックタブで結果を確認できます。`, 'success');
    } finally {
      setBusy(null);
    }
  };

  const selValue = sel ? (sel.axis === 'x' ? sortedXs : sortedYs)[sel.i] : null;

  return (
    <div class="tool">
      <p class="muted small">
        1枚に並んだ絵を、分割線で切り分けて別々の画像にします。線は指でドラッグするか、線を選んで下のボタンで1pxずつ動かせます。結果は新しい画像として追加し、元の画像は変えません。
      </p>
      {bg.kind === 'color' && (
        <div class="banner banner-warn">
          <span>背景が透明ではありません（{hex(bg.rgb)}）。このまま切ると背景色も残ります。先に背景を透明にするのがおすすめです。</span>
          <button class="btn btn-small" onClick={() => setEdit({ tool: 'background' })}>
            背景透過へ
          </button>
        </div>
      )}
      <div class="tool-grid">
        <div class="tool-controls card">
          <div class="row-wrap">
            <button class="btn btn-small" onClick={detect}>
              すき間から自動で探す
            </button>
            <Stepper id="split-gap" label="すき間の最小幅px" value={minGap} min={1} max={200} onChange={setMinGap} />
          </div>
          <div class="row-wrap">
            <Stepper id="split-rows" label="行" value={rows} min={1} max={12} onChange={setRows} />
            <Stepper id="split-cols" label="列" value={cols} min={1} max={12} onChange={setCols} />
            <button class="btn btn-small" onClick={() => grid()}>
              等分する
            </button>
          </div>
          <div class="row-wrap">
            <button class="btn btn-small" onClick={() => addLine('x')}>
              縦線を追加
            </button>
            <button class="btn btn-small" onClick={() => addLine('y')}>
              横線を追加
            </button>
          </div>
          {note && <p class="small" role="status">{note}</p>}
          <div class="line-adjust" aria-live="polite">
            {sel && selValue !== null ? (
              <>
                <strong>
                  {sel.axis === 'x' ? '縦' : '横'}の線 {sel.i + 1}：{selValue}px
                </strong>
                <div class="row-wrap">
                  {[-10, -1, 1, 10].map((d) => (
                    <button key={d} class="btn btn-small" onClick={() => setLine(sel.axis, sel.i, selValue + d)} aria-label={`${Math.abs(d)}px ${d < 0 ? (sel.axis === 'x' ? '左' : '上') : sel.axis === 'x' ? '右' : '下'}へ`}>
                      {d < 0 ? (sel.axis === 'x' ? '←' : '↑') : sel.axis === 'x' ? '→' : '↓'}
                      {Math.abs(d)}
                    </button>
                  ))}
                  <button class="btn btn-small btn-danger" onClick={removeLine}>
                    この線を消す
                  </button>
                </div>
              </>
            ) : (
              <span class="muted small">線をタップすると、ここで位置を細かく調整できます。</span>
            )}
          </div>
          <label class="check">
            <input id="split-trim" type="checkbox" checked={trim} onChange={(e) => setTrim(e.currentTarget.checked)} />
            絵の周りの余白を詰める
          </label>
          <div class="field">
            <label for="split-preset">大きさの調整</label>
            <select id="split-preset" value={presetId} onChange={(e) => setPresetId(e.currentTarget.value)}>
              {SIZE_PRESETS.map((p) => (
                <option value={p.id}>{p.label}</option>
              ))}
            </select>
            <span class="muted small">縮小だけ行い、拡大はしません。72dpiのPNGで保存します。</span>
          </div>
          <div class="field">
            <label for="split-assign">切り出した画像の役割</label>
            <select id="split-assign" value={assign} onChange={(e) => setAssign(e.currentTarget.value)}>
              <option value="">割り当てない</option>
              {roleOptions.map((o) => (
                <option value={o.value}>{o.label}（順番に追加）</option>
              ))}
            </select>
          </div>
          <p class="small">
            {cells.length}マス中 <b>{chosen.length}枚</b>を切り出します
            {empty.size ? `（空のマス${empty.size}個は除外）` : ''}
            {excluded.size ? `（手動で除外${excluded.size}個）` : ''}
          </p>
          <button class="btn btn-primary" disabled={!!busy || chosen.length === 0 || !!s.job} onClick={run}>
            {busy ?? `${chosen.length}枚を切り出して追加`}
          </button>
        </div>
        <div class="tool-preview">
          <div class="preview-head">
            <h3 class="h-small">
              分割の確認（{W}×{H}px）
            </h3>
            <BgSwitch value={view} onChange={setView} />
          </div>
          <div
            class="split-stage"
            onPointerMove={(e) => onMove(e as unknown as PointerEvent)}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
          >
            <RasterView raster={raster} bg={view} label={`${asset.originalName} の分割プレビュー`}>
              <div class="split-overlay" ref={boxRef}>
                {cells.map((c) => {
                  const off = empty.has(c.index) || excluded.has(c.index);
                  return (
                    <button
                      key={`c${c.index}`}
                      class={`cell-tag ${off ? 'off' : ''}`}
                      style={{ left: `${(c.x / W) * 100}%`, top: `${(c.y / H) * 100}%` }}
                      disabled={empty.has(c.index)}
                      aria-pressed={!off}
                      aria-label={empty.has(c.index) ? `マス${c.index + 1}：空のため除外` : `マス${c.index + 1}を${off ? '含める' : '除外する'}`}
                      onClick={() =>
                        setExcluded((prev) => {
                          const n = new Set(prev);
                          if (n.has(c.index)) n.delete(c.index);
                          else n.add(c.index);
                          return n;
                        })
                      }
                    >
                      {empty.has(c.index) ? '空' : off ? '除外' : chosen.findIndex((x) => x.index === c.index) + 1}
                    </button>
                  );
                })}
                {(['x', 'y'] as const).map((axis) =>
                  (axis === 'x' ? sortedXs : sortedYs).map((v, i) => (
                    <button
                      key={`${axis}${i}`}
                      class={`split-line split-${axis} ${sel?.axis === axis && sel.i === i ? 'on' : ''}`}
                      style={axis === 'x' ? { left: `${(v / W) * 100}%` } : { top: `${(v / H) * 100}%` }}
                      aria-label={`${axis === 'x' ? '縦' : '横'}の分割線${i + 1}（${v}px）。選んで位置を調整`}
                      onPointerDown={(e) => {
                        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                        drag.current = { axis, i };
                        setSel({ axis, i });
                      }}
                      onPointerMove={(e) => onMove(e as unknown as PointerEvent)}
                      onPointerUp={() => (drag.current = null)}
                      onClick={() => setSel({ axis, i })}
                    >
                      <span class="split-line-bar" />
                    </button>
                  )),
                )}
              </div>
            </RasterView>
          </div>
        </div>
      </div>
    </div>
  );
}

// ================================================================ 画面

export function EditView() {
  const s = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<string | null>(null);
  const assetId = s.edit.assetId && s.project.assets.some((a) => a.id === s.edit.assetId) ? s.edit.assetId : (s.project.assets[0]?.id ?? null);
  const asset = s.project.assets.find((a) => a.id === assetId);
  const [raster, setRaster] = useState<Raster | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    setRaster(null);
    setLoadErr(null);
    if (!asset) return;
    let alive = true;
    decodeAssetRaster(asset).then(
      (r) => alive && setRaster(r),
      (e) => alive && setLoadErr((e as Error).message),
    );
    return () => {
      alive = false;
    };
  }, [asset?.id, asset?.version]);

  return (
    <div class="workspace single edit-ws">
      <div class="main-col">
        <div class="page-head">
          <div class="title-block">
            <h1>編集</h1>
            <p class="muted">一覧画像の分割と背景透過。元の画像は変更せず、結果を新しい画像として追加します。外部へは送信しません。</p>
          </div>
        </div>

        {!asset ? (
          <div class="card mascot-card">
            <Mascot kind="waiting" alt="空き箱の横で待つマーモット" size={112} />
            <div>
              <strong>編集する画像がありません</strong>
              <p class="muted">上の「画像を追加」から一覧画像などを読み込んでください。</p>
            </div>
          </div>
        ) : (
          <>
            <section class="card edit-picker" aria-label="編集する画像">
              <div class="field">
                <label for="edit-asset">編集する画像</label>
                <select id="edit-asset" value={asset.id} onChange={(e) => setEdit({ assetId: e.currentTarget.value })}>
                  {s.project.assets.map((a) => (
                    <option value={a.id}>
                      {a.originalName}
                      {a.derivedFrom ? `（${a.derivedFrom.op === 'split' ? '分割' : '透過'}で作成）` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div class="seg tool-switch" role="tablist" aria-label="編集の種類">
                {(
                  [
                    ['split', '一覧画像の分割'],
                    ['background', '背景透過'],
                  ] as const
                ).map(([k, l]) => (
                  <button key={k} role="tab" aria-selected={s.edit.tool === k} class={`seg-btn ${s.edit.tool === k ? 'on' : ''}`} onClick={() => setEdit({ tool: k })}>
                    {l}
                  </button>
                ))}
              </div>
              {asset.derivedFrom && (
                <p class="small muted">
                  「{asset.derivedFrom.originalName}」から{asset.derivedFrom.op === 'split' ? '分割' : '背景透過'}で作成：{asset.derivedFrom.detail}
                </p>
              )}
            </section>

            {loadErr && (
              <div class="banner banner-error" role="alert">
                この画像は編集できません：{loadErr}
              </div>
            )}
            {!raster && !loadErr && <p class="muted">画像を読み込んでいます…</p>}
            {raster && s.edit.tool === 'split' && <SplitTool key={`${asset.id}:${asset.version}`} asset={asset} raster={raster} />}
            {raster && s.edit.tool === 'background' && <BackgroundTool key={`${asset.id}:${asset.version}`} asset={asset} raster={raster} />}
          </>
        )}

        {s.project.assets.length > 0 && (
          <details class="card">
            <summary class="details-summary">元画像の書出し・外部で直した画像での差し替え（{s.project.assets.length}件）</summary>
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
          </details>
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
        <button class="btn" onClick={() => setState({ tab: 'check' })}>
          チェックで結果を確認する
        </button>
      </div>
    </div>
  );
}
