export interface OfflineFingerprint {
  han: number;
  paras: number;
  pmed: number | null;
  smed: number | null;
  secs: number;
  secavg: number | null;
  person: '第一' | '第三';
  quote: '无' | '「」' | '""';
  wo: number;
  ta: number;
  jp: number;
  dq: number;
}

export function fingerprint(text: string): OfflineFingerprint;
