"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { currentToken, signIn as cognitoSignIn, signOut as cognitoSignOut } from "@/lib/auth";

interface AuthContextValue {
  /** Cognito id token; null when signed out (only meaningful once `ready`). */
  token: string | null;
  /** True once the initial session restore resolved. */
  ready: boolean;
  /** Email claim decoded from the id token; null when signed out. */
  email: string | null;
  /** True when the id token's `cognito:groups` includes "admin". */
  isAdmin: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function decodeClaims(token: string | null): Record<string, unknown> | null {
  if (!token) return null;
  try {
    // JWT payloads are base64url — map to base64 (and pad) before atob.
    const b64 = (token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function emailFromToken(token: string | null): string | null {
  return (decodeClaims(token)?.email as string | undefined) ?? null;
}

function isAdminFromToken(token: string | null): boolean {
  const groups = decodeClaims(token)?.["cognito:groups"];
  if (Array.isArray(groups)) return groups.includes("admin");
  if (typeof groups === "string") return groups.split(/[\s,]+/).includes("admin");
  return false;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    currentToken().then((t) => {
      setToken(t);
      setReady(true);
    });
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    setToken(await cognitoSignIn(email, password));
  }, []);

  const signOut = useCallback(() => {
    cognitoSignOut();
    setToken(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      ready,
      email: emailFromToken(token),
      isAdmin: isAdminFromToken(token),
      signIn,
      signOut,
    }),
    [token, ready, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
