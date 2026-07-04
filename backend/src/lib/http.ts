import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

export function tenantOf(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): { tenantId: string; userName: string } {
  const claims = event.requestContext.authorizer.jwt.claims;
  return {
    tenantId: String(claims["custom:tenantId"] ?? claims.sub),
    userName: String(claims.name ?? claims.email ?? "Me"),
  };
}

export function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
    body: JSON.stringify(body),
  };
}
