import { useState } from "react";
import type { DeviceCode } from "../services/auth";
import type { AuthPhase } from "../hooks/useAuth";

interface SignInProps {
  phase: AuthPhase;
  deviceCode: DeviceCode | null;
  error: string | null;
  onSignIn: () => void;
  onCancel: () => void;
  onOpenVerification: () => void;
}

/**
 * Sign-in, set as a title page.
 *
 * Shared by desktop and iOS: the device flow has no redirect, so there is
 * nothing platform-specific to branch on.
 */
export function SignIn({
  phase,
  deviceCode,
  error,
  onSignIn,
  onCancel,
  onOpenVerification,
}: SignInProps) {
  const [copied, setCopied] = useState(false);

  const copyCode = async () => {
    if (!deviceCode) return;
    try {
      await navigator.clipboard.writeText(deviceCode.userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be unavailable; the code is on screen to type anyway.
    }
  };

  return (
    <div className="mobile-root flex h-full flex-col justify-center bg-paper px-8">
      <div className="mx-auto w-full max-w-sm">
        <p className="label mb-6">Prose</p>
        <h1 className="font-prose text-[2rem] leading-[1.15] text-ink">
          Read the draft.
          <br />
          Leave your notes
          <br />
          in the margin.
        </h1>

        <div className="mt-10 border-t border-edge pt-8">
          {phase === "awaiting-code" && deviceCode ? (
            <>
              <p className="label mb-3">Enter on GitHub</p>
              <button
                type="button"
                onClick={() => void copyCode()}
                className="w-full border-b-2 border-ink pb-3 text-left font-mono text-[1.75rem] tracking-[0.2em] text-ink active:opacity-60"
              >
                {deviceCode.userCode}
              </button>
              <p className="mt-2 h-4 text-xs text-ink-faint">
                {copied ? "Copied" : "Tap to copy"}
              </p>

              <button
                type="button"
                onClick={onOpenVerification}
                className="mt-7 w-full rounded-lg bg-ink py-3.5 text-sm font-medium text-paper active:opacity-80"
              >
                Open GitHub
              </button>
              <div className="mt-4 flex items-center justify-between">
                <span className="text-xs text-ink-faint">Waiting...</span>
                <button
                  type="button"
                  onClick={onCancel}
                  className="text-xs text-ink-dim active:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : phase === "awaiting-code" ? (
            <p className="text-sm text-ink-faint">Asking GitHub for a code...</p>
          ) : (
            <>
              <button
                type="button"
                onClick={onSignIn}
                disabled={phase === "checking"}
                className="w-full rounded-lg bg-ink py-4 text-sm font-medium text-paper disabled:opacity-30 active:opacity-80"
              >
                {phase === "checking" ? "Checking" : "Sign in with GitHub"}
              </button>
              <p className="mt-4 text-xs leading-relaxed text-ink-faint">
                Prose needs the <span className="font-mono">repo</span> scope to
                read pull requests and post review comments.
              </p>
            </>
          )}

          {error && (
            <p className="mt-6 border-l-2 border-danger pl-3 text-xs leading-relaxed text-danger">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
