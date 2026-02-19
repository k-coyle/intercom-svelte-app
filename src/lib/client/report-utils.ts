export const MAX_LOOKBACK_DAYS = 365;

export function parseLookbackDays(raw: string | number): number {
  const parsed =
    typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      'Please enter a lookback window in days (for example: 30, 90, 365).'
    );
  }

  return Math.min(Math.floor(parsed), MAX_LOOKBACK_DAYS);
}

export function formatUnixDate(unix: number | null, withTime = false): string {
  if (unix == null) return '';
  const d = new Date(unix * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return withTime ? d.toLocaleString() : d.toLocaleDateString();
}

export function escapeCsv(value: string): string {
  if (value.includes('"') || value.includes(',') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function downloadCsv(
  filename: string,
  headers: string[],
  rows: Array<Array<string | number | boolean | null | undefined>>
) {
  const lines: string[] = [];
  lines.push(headers.map(escapeCsv).join(','));

  for (const row of rows) {
    const serialized = row.map((v) => escapeCsv(String(v ?? '')));
    lines.push(serialized.join(','));
  }

  const csv = lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function fetchJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}
