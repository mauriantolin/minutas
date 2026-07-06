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

export function isAdmin(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): boolean {
  const raw = event.requestContext.authorizer.jwt.claims["cognito:groups"];
  const groups = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.replace(/^\[|\]$/g, "").split(/[\s,]+/)
      : [];
  return groups.map((g) => String(g).trim()).includes("admin");
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
