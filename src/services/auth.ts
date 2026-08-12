import { invoke } from "@tauri-apps/api/core";

export interface AuthStatus {
  signedIn: boolean;
  user: string | null;
  missingScopes: string[];
}

/** Emitted on `auth://device-code` once GitHub hands back a code to display. */
export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

// Rust serializes these structs with snake_case field names; normalize at the
// boundary so the rest of the frontend stays in one convention.
interface RawStatus {
  signed_in: boolean;
  user: string | null;
  missing_scopes: string[];
}

interface RawDeviceCode {
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export function normalizeStatus(raw: RawStatus): AuthStatus {
  return {
    signedIn: raw.signed_in,
    user: raw.user,
    missingScopes: raw.missing_scopes ?? [],
  };
}

export function normalizeDeviceCode(raw: RawDeviceCode): DeviceCode {
  return {
    userCode: raw.user_code,
    verificationUri: raw.verification_uri,
    expiresIn: raw.expires_in,
    interval: raw.interval,
  };
}

export const authApi = {
  status: async () => normalizeStatus(await invoke<RawStatus>("auth_status")),

  /**
   * Resolves only when the device flow finishes. Listen for
   * `auth://device-code` to render the code while this is pending.
   */
  signIn: async () => normalizeStatus(await invoke<RawStatus>("auth_sign_in")),

  cancelSignIn: () => invoke<void>("auth_cancel_sign_in"),

  signOut: async () => normalizeStatus(await invoke<RawStatus>("auth_sign_out")),

  openVerification: (url: string) =>
    invoke<void>("auth_open_verification", { url }),
};
