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
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function emailFromToken(token: string | null): string | null {
  if (!token) return null;
  try {
    // JWT payloads are base64url — map to base64 (and pad) before atob.
    const b64 = (token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { email?: string };
    return payload.email ?? null;
  } catch {
    return null;
  }
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
    () => ({ token, ready, email: emailFromToken(token), signIn, signOut }),
    [token, ready, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
