export interface ApiError {
  error: { code: string; message: string };
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'not measured';
  if (bytes === 0) return '0 B';
  const sign = bytes < 0 ? '-' : '';
  const abs = Math.abs(bytes);
  const tier = Math.min(Math.floor(Math.log(abs) / Math.log(1024)), UNITS.length - 1);
  const value = abs / Math.pow(1024, tier);
  return `${sign}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${UNITS[tier]}`;
}
