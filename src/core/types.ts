// こつこつ梱包室：共通の型定義（UIから独立）

export type ImageFormat = 'png' | 'jpeg';
export type Container =
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'svg'
  | 'heic'
  | 'avif'
  | 'bmp'
  | 'tiff'
  | 'zip'
  | 'pdf'
  | 'unknown';

/** チェックテンプレート（編集テンプレートとは別の型・別の保存領域） */
export interface CheckRole {
  id: string;
  label?: string;
  count: { min: number; max: number | null };
  formats: ImageFormat[];
  dimensions:
    | { mode: 'none' }
    | { mode: 'exact' | 'max'; width: number; height: number };
  maxBytes: number | null;
  evenDimensions: boolean;
  transparency: 'required' | 'optional' | 'forbidden';
  minDpi: number | null;
  marginAdvisoryPx: number | null;
  directory: string;
  namePattern: string;
}

export type TemplateSourceType = 'official-derived' | 'user-workflow';

export interface CheckTemplate {
  schemaVersion: 1;
  kind: 'check-template';
  id: string;
  name: string;
  sourceType: TemplateSourceType;
  checkedOn: string | null;
  sourceUrl: string | null;
  notice?: string;
  maxArchiveBytes: number | null;
  byteConvention?: string;
  selectedStickerCount?: number;
  allowedStickerCounts?: number[];
  basedOn?: string;
  roles: CheckRole[];
}

export interface BundleOutput {
  id: string;
  templateId: string;
  roles: string[];
  archiveName: string;
}

export interface BundleTemplate {
  schemaVersion: 1;
  kind: 'bundle-template';
  id: string;
  name: string;
  templates: string[];
  outputs: BundleOutput[];
  note?: string;
}

export type AnyTemplate = CheckTemplate | BundleTemplate;

/** 素材（元ファイル）。チェックでは中身を変更しない */
export interface AssetRecord {
  id: string;
  originalName: string;
  sourcePath: string;
  blob: Blob;
  size: number;
  sha256: string;
  version: number;
  addedAt: string;
  replacedNames?: string[];
  /** 編集で作った画像なら、元画像と操作 */
  derivedFrom?: { assetId: string; originalName: string; op: 'split' | 'background'; detail: string };
}

/** 役割参照：一つの素材を複数の役割から参照できる */
export interface RoleRef {
  id: string;
  assetId: string;
  templateId: string;
  roleId: string;
  order: number;
  nameOverride?: string;
  suggested?: boolean;
}

export type ProjectTarget =
  | { kind: 'template'; templateId: string }
  | { kind: 'bundle'; bundleId: string };

export interface ProjectSettings {
  stickerCounts: Record<string, number>;
  alphaThreshold: number;
}

export interface Project {
  schemaVersion: 1;
  id: string;
  name: string;
  target: ProjectTarget;
  assets: AssetRecord[];
  refs: RoleRef[];
  settings: ProjectSettings;
  facts: Record<string, AssetFacts>;
  updatedAt: string;
}

export type DpiFact =
  | { status: 'ok'; x: number; y: number; source: 'pHYs' | 'JFIF'; raw: string }
  | { status: 'unknown'; reason: string };

export interface AlphaStats {
  totalPixels: number;
  /** alpha < 255 の画素数 */
  translucentPixels: number;
  /** alpha === 0 の画素数 */
  zeroAlphaPixels: number;
  /** alpha > threshold の画素を囲む矩形 */
  contentBox: { left: number; top: number; right: number; bottom: number } | null;
  margins: { left: number; top: number; right: number; bottom: number } | null;
  threshold: number;
}

/** 画像から得た事実（規則とは独立）。sha256とalphaThresholdが一致する間だけ有効 */
export interface AssetFacts {
  sha256: string;
  alphaThreshold: number;
  analyzedAt: string;
  bytes: number;
  container: Container;
  extFormat: string | null;
  width?: number;
  height?: number;
  pixelLimitExceeded?: boolean;
  png?: {
    colorType: number;
    bitDepth: number;
    interlace: number;
    animated: boolean;
    hasTrns: boolean;
    hasIccp: boolean;
  };
  jpeg?: { components: number; hasExif: boolean };
  hasAlphaChannel: boolean;
  dpi: DpiFact;
  decode: { ok: true } | { ok: false; reason: string };
  alpha?: AlphaStats;
}

export type Severity = 'error' | 'warning' | 'unknown' | 'info';
export type RuleSource = 'official' | 'app' | 'user';

export interface Finding {
  code: string;
  severity: Severity;
  title: string;
  detail?: string;
  measured?: string;
  required?: string;
  source: RuleSource;
  roleLabel?: string;
}

export type ImageStatus = 'pass' | 'warn' | 'error' | 'unchecked';
