import type { ComponentChildren } from 'preact';
import type { Finding, ImageStatus, RuleSource, Severity } from '../core/types';
import { IconCheck, IconError, IconInfo, IconUnknown, IconWarn } from './icons';

export const STATUS_LABEL: Record<ImageStatus, string> = { pass: '合格', warn: '要確認', error: 'エラー', unchecked: '未検査' };
export const SEVERITY_LABEL: Record<Severity, string> = { error: 'エラー', warning: '要確認', unknown: '未確認', info: '参考' };
export const SOURCE_LABEL: Record<RuleSource, string> = { official: '公式条件', app: 'アプリの推奨', user: '自作ルール' };

export function StatusIcon({ status, size = 20 }: { status: ImageStatus; size?: number }) {
  const cls = `st-icon st-${status}`;
  if (status === 'pass') return <IconCheck size={size} class={cls} />;
  if (status === 'warn') return <IconWarn size={size} class={cls} />;
  if (status === 'error') return <IconError size={size} class={cls} />;
  return <IconUnknown size={size} class={cls} />;
}

export function StatusPill({ status, text }: { status: ImageStatus; text?: string }) {
  return (
    <span class={`pill pill-${status}`}>
      <StatusIcon status={status} size={16} />
      {text ?? STATUS_LABEL[status]}
    </span>
  );
}

function SeverityIcon({ s }: { s: Severity }) {
  if (s === 'error') return <IconError size={18} class="st-icon st-error" />;
  if (s === 'warning') return <IconWarn size={18} class="st-icon st-warn" />;
  if (s === 'unknown') return <IconUnknown size={18} class="st-icon st-warn" />;
  return <IconInfo size={18} class="st-icon st-info" />;
}

export function FindingList({ findings, empty }: { findings: Finding[]; empty?: ComponentChildren }) {
  if (!findings.length) return <>{empty ?? null}</>;
  return (
    <ul class="findings">
      {findings.map((f, i) => (
        <li key={`${f.code}-${i}`} class={`finding sev-${f.severity}`}>
          <div class="finding-head">
            <SeverityIcon s={f.severity} />
            <span class="sev-label">{SEVERITY_LABEL[f.severity]}</span>
            <strong class="finding-title">{f.title}</strong>
          </div>
          {f.roleLabel && <div class="finding-role">役割：{f.roleLabel}</div>}
          {f.detail && <p class="finding-detail">{f.detail}</p>}
          {(f.measured || f.required) && (
            <dl class="finding-values">
              {f.measured && (
                <>
                  <dt>実測</dt>
                  <dd>{f.measured}</dd>
                </>
              )}
              {f.required && (
                <>
                  <dt>要求</dt>
                  <dd>{f.required}</dd>
                </>
              )}
            </dl>
          )}
          <span class={`src src-${f.source}`}>出典：{SOURCE_LABEL[f.source]}</span>
        </li>
      ))}
    </ul>
  );
}

export function Mascot({ kind, alt, size = 128 }: { kind: 'waiting' | 'checked' | 'packed'; alt: string; size?: number }) {
  return <img class="mascot" src={`./mascot/mascot-${kind}.png`} alt={alt} width={size} height={size} style={{ width: `${size}px`, height: `${size}px` }} />;
}

export function bytesText(n: number): string {
  return `${n.toLocaleString('ja-JP')} bytes（約${(n / 1_000_000).toLocaleString('ja-JP', { maximumFractionDigits: 2 })} MB）`;
}
