import { useEffect } from "react";

export interface ToastAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export interface Toast {
  id: string;
  kind: "error" | "info";
  title: string;
  detail?: string;
  actions?: ToastAction[];
  // Auto-dismiss delay in ms. Toasts carrying actions omit this so the
  // user always gets a chance to act.
  timeoutMs?: number;
}

interface ToastsProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

export function Toasts({ toasts, onDismiss }: ToastsProps) {
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const { id, timeoutMs } = toast;
  useEffect(() => {
    if (!timeoutMs) return;
    const h = setTimeout(() => onDismiss(id), timeoutMs);
    return () => clearTimeout(h);
  }, [id, timeoutMs, onDismiss]);

  return (
    <div
      className={`toast ${toast.kind}`}
      role={toast.kind === "error" ? "alert" : "status"}
    >
      <div className="toast-body">
        <div className="toast-title">{toast.title}</div>
        {toast.detail && <div className="toast-detail">{toast.detail}</div>}
        {toast.actions && toast.actions.length > 0 && (
          <div className="toast-actions">
            {toast.actions.map((a) => (
              <button
                key={a.label}
                className={a.primary ? "primary" : ""}
                onClick={() => {
                  a.onClick();
                  onDismiss(toast.id);
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        className="toast-close"
        onClick={() => onDismiss(toast.id)}
        title="Dismiss"
        aria-label="Dismiss notification"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path
            fill="currentColor"
            d="M2 1 1 2l3 3-3 3 1 1 3-3 3 3 1-1-3-3 3-3-1-1-3 3z"
          />
        </svg>
      </button>
    </div>
  );
}
