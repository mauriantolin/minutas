import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  type CognitoUserSession,
} from "amazon-cognito-identity-js";
import { CONFIG } from "./config.js";

const pool = new CognitoUserPool({
  UserPoolId: CONFIG.userPoolId,
  ClientId: CONFIG.userPoolClientId,
});

export interface AuthTokens {
  idToken: string;
  /** Long-lived; lets the service worker refresh idTokens on its own (auto-capture). */
  refreshToken: string;
}

export function signIn(email: string, password: string): Promise<AuthTokens> {
  const user = new CognitoUser({ Username: email, Pool: pool });
  const details = new AuthenticationDetails({ Username: email, Password: password });
  return new Promise((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: (session) =>
        resolve({
          idToken: session.getIdToken().getJwtToken(),
          refreshToken: session.getRefreshToken().getToken(),
        }),
      onFailure: reject,
    });
  });
}

export function currentSession(): Promise<AuthTokens | null> {
  const user = pool.getCurrentUser();
  if (!user) return Promise.resolve(null);
  return new Promise((resolve) => {
    user.getSession((err: unknown, session: CognitoUserSession | null) => {
      resolve(
        err || !session
          ? null
          : {
              idToken: session.getIdToken().getJwtToken(),
              refreshToken: session.getRefreshToken().getToken(),
            },
      );
    });
  });
}

/**
 * Force a token refresh regardless of remaining validity. `getSession` returns the cached
 * idToken until it actually expires (60 min), so mid-meeting rotation at ~50 min must go
 * through `refreshSession` to get a fresh 60-min token before the old one dies mid-stream.
 */
export function forceRefreshIdToken(): Promise<string | null> {
  const user = pool.getCurrentUser();
  if (!user) return Promise.resolve(null);
  return new Promise((resolve) => {
    user.getSession((err: unknown, session: CognitoUserSession | null) => {
      if (err || !session) return resolve(null);
      user.refreshSession(session.getRefreshToken(), (err2: unknown, fresh: CognitoUserSession | null) => {
        resolve(err2 || !fresh ? null : fresh.getIdToken().getJwtToken());
      });
    });
  });
}
