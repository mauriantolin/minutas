import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
} from "amazon-cognito-identity-js";
import { CONFIG } from "./config";

const pool = new CognitoUserPool({
  UserPoolId: CONFIG.userPoolId,
  ClientId: CONFIG.userPoolClientId,
});

export function signIn(email: string, password: string): Promise<string> {
  const user = new CognitoUser({ Username: email, Pool: pool });
  const details = new AuthenticationDetails({ Username: email, Password: password });
  return new Promise((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: (s) => resolve(s.getIdToken().getJwtToken()),
      onFailure: reject,
    });
  });
}

export function currentToken(): Promise<string | null> {
  const user = pool.getCurrentUser();
  if (!user) return Promise.resolve(null);
  return new Promise((resolve) => {
    user.getSession((err: unknown, s: { getIdToken(): { getJwtToken(): string } } | null) =>
      resolve(err || !s ? null : s.getIdToken().getJwtToken()),
    );
  });
}

export function signOut() {
  pool.getCurrentUser()?.signOut();
}
