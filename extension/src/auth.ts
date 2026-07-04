import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
} from "amazon-cognito-identity-js";
import { fromCognitoIdentityPool } from "@aws-sdk/credential-provider-cognito-identity";
import type { AwsCredentialIdentity } from "@aws-sdk/types";
import { CONFIG } from "./config.js";

const pool = new CognitoUserPool({
  UserPoolId: CONFIG.userPoolId,
  ClientId: CONFIG.userPoolClientId,
});

export function signIn(email: string, password: string): Promise<string> {
  const user = new CognitoUser({ Username: email, Pool: pool });
  const details = new AuthenticationDetails({ Username: email, Password: password });
  return new Promise((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: (session) => resolve(session.getIdToken().getJwtToken()),
      onFailure: reject,
    });
  });
}

export function currentIdToken(): Promise<string | null> {
  const user = pool.getCurrentUser();
  if (!user) return Promise.resolve(null);
  return new Promise((resolve) => {
    user.getSession((err: unknown, session: { getIdToken(): { getJwtToken(): string } } | null) => {
      resolve(err || !session ? null : session.getIdToken().getJwtToken());
    });
  });
}

/** Temporary AWS credentials scoped (by the Identity Pool role) to Transcribe streaming. */
export function transcribeCredentials(idToken: string): () => Promise<AwsCredentialIdentity> {
  const login = `cognito-idp.${CONFIG.region}.amazonaws.com/${CONFIG.userPoolId}`;
  return fromCognitoIdentityPool({
    identityPoolId: CONFIG.identityPoolId,
    logins: { [login]: idToken },
    clientConfig: { region: CONFIG.region },
  });
}
