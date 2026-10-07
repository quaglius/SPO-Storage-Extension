export { formatBytes } from '@spostorage/shared';

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(undefined, options);
}

export function formatPercent(value: number, decimals = 1): string {
  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} %`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const DIVISIONS: Array<{ amount: number; name: Intl.RelativeTimeFormatUnit }> = [
  { amount: 60, name: 'second' },
  { amount: 60, name: 'minute' },
  { amount: 24, name: 'hour' },
  { amount: 7, name: 'day' },
  { amount: 4.34524, name: 'week' },
  { amount: 12, name: 'month' },
  { amount: Number.POSITIVE_INFINITY, name: 'year' },
];

export function formatRelativeDate(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return isoDate;

  let duration = (date.getTime() - Date.now()) / 1000;

  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(duration), division.name);
    }
    duration /= division.amount;
  }

  return isoDate;
}

export function formatAbsoluteDate(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
}

export function formatUsd(value: number): string {
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function mbToLogPosition(mb: number, minMb = 1, maxMb = 500): number {
  const clamped = Math.max(minMb, Math.min(maxMb, mb));
  return (Math.log(clamped / minMb) / Math.log(maxMb / minMb)) * 100;
}

export function logPositionToMb(position: number, minMb = 1, maxMb = 500): number {
  const ratio = Math.max(0, Math.min(100, position)) / 100;
  return minMb * Math.pow(maxMb / minMb, ratio);
}

export function exportToCsv(headers: string[], rows: string[][]): string {
  const escape = (cell: string) => {
    if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
      return `"${cell.replace(/"/g, '""')}"`;
    }
    return cell;
  };
  return [headers.map(escape).join(','), ...rows.map((row) => row.map(escape).join(','))].join('\n');
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
