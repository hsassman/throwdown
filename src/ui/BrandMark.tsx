export function BrandMark({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={`brand-mark ${className ?? ""}`}
      role={compact ? undefined : "img"} aria-label={compact ? undefined : "ShadowBox"} aria-hidden={compact || undefined}>
      {compact ? (
        <svg viewBox="0 0 44 44" aria-hidden="true">
          <path d="M21 7H10l-4 4v9l4 4h8v8H7v5h12l5-5V23l-4-4h-8v-7h9zM24 7h10l4 4v8l-3 3 3 3v8l-4 4h-8v-5h6v-7h-6v-5h6v-8h-8z" fill="currentColor" />
        </svg>
      ) : (
        <span className="brand-mark-face" aria-hidden="true">
          <span>Shadow</span><span>Box</span>
        </span>
      )}
    </span>
  );
}

export function UiIcon({ name }: { name: "settings" | "back" | "camera" | "open" | "lock" | "close" }) {
  const paths = {
    settings: "M10 3h4l.7 2.4 2 .9 2.2-1.1 2 3.5-1.8 1.7.2 2.2 1.8 1.7-2 3.5-2.4-.6-1.8 1.2-.5 2.6h-4l-.6-2.5-1.9-1-2.5.7-2-3.5 1.8-1.8v-2.1L3 9l2-3.5 2.5.7 1.9-1zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    back: "m14 5-7 7 7 7",
    camera: "M3 6h12v12H3zM15 10l6-4v12l-6-4",
    open: "m10 6 6 6-6 6",
    lock: "M7 11h10v9H7zM9 11V8a3 3 0 0 1 6 0v3",
    close: "m6 6 12 12M18 6 6 18",
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
