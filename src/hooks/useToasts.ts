import { useCallback, useRef, useState } from "react";
import type { Toast } from "../components";

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSequence = useRef(0);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((toast: Omit<Toast, "id">) => {
    const id = `t${++toastSequence.current}`;
    setToasts((current) => [...current, { ...toast, id }]);
    return id;
  }, []);

  const reportError = useCallback(
    (error: unknown, title = "Something went wrong") => {
      pushToast({
        kind: "error",
        title,
        detail: String(error),
        timeoutMs: 8000,
      });
    },
    [pushToast],
  );

  return { toasts, dismissToast, pushToast, reportError };
}
