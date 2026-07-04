import { fromCognitoIdentityPool } from "@aws-sdk/credential-provider-cognito-identity";
import type { AwsCredentialIdentity } from "@aws-sdk/types";
import { forceRefreshIdToken } from "./auth.js";
import { CONFIG } from "./config.js";

/** Identity-Pool temp credentials from a raw id token (used inside the offscreen doc). */
export function transcribeCredentialsFromToken(
  idToken: string,
): () => Promise<AwsCredentialIdentity> {
  const login = `cognito-idp.${CONFIG.region}.amazonaws.com/${CONFIG.userPoolId}`;
  return fromCognitoIdentityPool({
    identityPoolId: CONFIG.identityPoolId,
    logins: { [login]: idToken },
    clientConfig: { region: CONFIG.region },
  });
}

/**
 * Fresh idToken + matching Identity-Pool provider for mid-meeting rotation. The offscreen
 * document shares the extension origin's localStorage with the popup, so the Cognito
 * session stored at sign-in is directly refreshable from here.
 */
export async function refreshedTranscribeCredentials(): Promise<{
  idToken: string;
  credentials: () => Promise<AwsCredentialIdentity>;
} | null> {
  const idToken = await forceRefreshIdToken();
  if (!idToken) return null;
  return { idToken, credentials: transcribeCredentialsFromToken(idToken) };
}
