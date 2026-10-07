interface ArchivedFileIndicatorProps {
  show: boolean;
  className?: string;
}

export function ArchivedFileIndicator({ show, className = '' }: ArchivedFileIndicatorProps) {
  if (!show) return null;

  return (
    <span
      className={`inline-flex cursor-help text-warn ${className}`.trim()}
      title="This file had unique permissions; link access may not match exactly"
      aria-label="This file had unique permissions; link access may not match exactly"
    >
      ⚠
    </span>
  );
}
