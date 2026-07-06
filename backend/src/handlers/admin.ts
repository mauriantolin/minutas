import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminDeleteUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import { isAdmin, json } from "../lib/http.js";

const cognito = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.USER_POOL_ID!;

const attrOf = (user: UserType, name: string): string | null =>
  user.Attributes?.find((a) => a.Name === name)?.Value ?? null;

const isUserAdmin = async (username: string): Promise<boolean> => {
  const { Groups } = await cognito.send(
    new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
    }),
  );
  return (Groups ?? []).some((g) => g.GroupName === "admin");
};

const parseBody = <T>(event: { body?: string }): T | null => {
  try {
    return JSON.parse(event.body ?? "{}") as T;
  } catch {
    return null;
  }
};

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event,
) => {
  if (!isAdmin(event)) return json(403, { error: "forbidden" });

  const claims = event.requestContext.authorizer.jwt.claims;
  const callerEmail = String(claims.email ?? "");
  const emailParam = event.pathParameters?.email
    ? decodeURIComponent(event.pathParameters.email)
    : undefined;

  switch (event.routeKey) {
    case "GET /admin/users": {
      const { Users = [] } = await cognito.send(
        new ListUsersCommand({ UserPoolId: USER_POOL_ID, Limit: 60 }),
      );
      const users = await Promise.all(
        Users.map(async (u) => ({
          email: attrOf(u, "email") ?? u.Username ?? null,
          status: u.UserStatus ?? null,
          enabled: u.Enabled ?? null,
          tenantId: attrOf(u, "custom:tenantId"),
          admin: await isUserAdmin(u.Username!),
          created: u.UserCreateDate?.toISOString() ?? null,
        })),
      );
      return json(200, { users });
    }

    case "POST /admin/users": {
      const body = parseBody<{
        email?: string;
        password?: string;
        tenantId?: string;
        admin?: boolean;
      }>(event);
      if (!body) return json(400, { error: "invalid json" });
      const { email, password, tenantId, admin } = body;
      if (!email || !password)
        return json(400, { error: "email and password required" });

      await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: email,
          MessageAction: "SUPPRESS",
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
            ...(tenantId
              ? [{ Name: "custom:tenantId", Value: tenantId }]
              : []),
          ],
        }),
      );
      await cognito.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: USER_POOL_ID,
          Username: email,
          Password: password,
          Permanent: true,
        }),
      );
      if (admin === true) {
        await cognito.send(
          new AdminAddUserToGroupCommand({
            UserPoolId: USER_POOL_ID,
            Username: email,
            GroupName: "admin",
          }),
        );
      }
      return json(201, { email });
    }

    case "DELETE /admin/users/{email}": {
      if (emailParam === callerEmail)
        return json(400, { error: "cannot delete yourself" });
      await cognito.send(
        new AdminDeleteUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: emailParam,
        }),
      );
      return json(200, { ok: true });
    }

    case "POST /admin/users/{email}/password": {
      const body = parseBody<{ password?: string }>(event);
      if (!body) return json(400, { error: "invalid json" });
      if (!body.password) return json(400, { error: "password required" });
      await cognito.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: USER_POOL_ID,
          Username: emailParam,
          Password: body.password,
          Permanent: true,
        }),
      );
      return json(200, { ok: true });
    }

    case "POST /admin/users/{email}/role": {
      const body = parseBody<{ admin?: boolean }>(event);
      if (!body || typeof body.admin !== "boolean")
        return json(400, { error: "admin boolean required" });
      await cognito.send(
        body.admin
          ? new AdminAddUserToGroupCommand({
              UserPoolId: USER_POOL_ID,
              Username: emailParam,
              GroupName: "admin",
            })
          : new AdminRemoveUserFromGroupCommand({
              UserPoolId: USER_POOL_ID,
              Username: emailParam,
              GroupName: "admin",
            }),
      );
      return json(200, { ok: true });
    }

    default:
      return json(404, { error: "not found" });
  }
};
