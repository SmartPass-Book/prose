import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  authApi,
  normalizeDeviceCode,
  normalizeStatus,
  type AuthStatus,
  type DeviceCode,
} from "../services/auth";

export type AuthPhase =
  | "checking"
  | "signed-out"
  | "awaiting-code"
  | "signed-in";

/**
 * Owns the GitHub device-flow sign-in.
 *
 * The polling loop lives in Rust (so the `interval` and `slow_down` backoff
 * rules are enforced in one place), which means `signIn()` is a single promise
 * that stays pending for as long as the user takes. The code to display
 * arrives separately on the `auth://device-code` event.
 */
export function useAuth() {
  const [phase, setPhase] = useState<AuthPhase>("checking");
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [deviceCode, setDeviceCode] = useState<DeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards against a stale event from an abandoned attempt resurrecting the
  // code screen after the user cancelled or signed in.
  const attemptRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void authApi
      .status()
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setPhase(next.signedIn ? "signed-in" : "signed-out");
      })
      .catch(() => {
        if (!cancelled) setPhase("signed-out");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<Parameters<typeof normalizeStatus>[0]>(
      "auth://status",
      (event) => {
        const next = normalizeStatus(event.payload);
        setStatus(next);
        setPhase(next.signedIn ? "signed-in" : "signed-out");
      },
    ).then((stop) => {
      unlisten = stop;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<Parameters<typeof normalizeDeviceCode>[0]>(
      "auth://device-code",
      (event) => {
        const attempt = attemptRef.current;
        setDeviceCode(normalizeDeviceCode(event.payload));
        // Only advance if this attempt is still the live one.
        setPhase((current) =>
          attempt === attemptRef.current && current !== "signed-in"
            ? "awaiting-code"
            : current,
        );
      },
    ).then((stop) => {
      unlisten = stop;
    });
    return () => unlisten?.();
  }, []);

  const signIn = useCallback(async () => {
    attemptRef.current += 1;
    setError(null);
    setDeviceCode(null);
    setPhase("awaiting-code");
    try {
      const next = await authApi.signIn();
      setStatus(next);
      setPhase(next.signedIn ? "signed-in" : "signed-out");
    } catch (e) {
      setError(String(e));
      setPhase("signed-out");
    } finally {
      setDeviceCode(null);
    }
  }, []);

  const cancelSignIn = useCallback(async () => {
    attemptRef.current += 1;
    await authApi.cancelSignIn().catch(() => {});
    setDeviceCode(null);
    setError(null);
    setPhase("signed-out");
  }, []);

  const signOut = useCallback(async () => {
    try {
      const next = await authApi.signOut();
      setStatus(next);
      setPhase("signed-out");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const openVerification = useCallback(async () => {
    if (!deviceCode) return;
    await authApi.openVerification(deviceCode.verificationUri).catch(() => {});
  }, [deviceCode]);

  return {
    state: { deviceCode, error, phase, status },
    actions: { cancelSignIn, openVerification, signIn, signOut },
  };
}
