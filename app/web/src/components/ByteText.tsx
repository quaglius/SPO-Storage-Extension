import { formatBytes } from '../lib/format.js';

interface ByteTextProps {
  bytes: number;
  measured?: boolean;
  className?: string;
}

export function ByteText({ bytes, measured = true, className = '' }: ByteTextProps) {
  return <span className={className}>{measured ? formatBytes(bytes) : 'not measured'}</span>;
}
