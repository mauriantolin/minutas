import { fromCognitoIdentityPool } from "@aws-sdk/credential-provider-cognito-identity";
import type { AwsCredentialIdentity } from "@aws-sdk/types";
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
