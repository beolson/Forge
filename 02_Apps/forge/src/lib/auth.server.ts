import { randomBytes } from "node:crypto";
import {
  ConfidentialClientApplication,
  CryptoProvider,
} from "@azure/msal-node";
import { useSession as getServerSession } from "@tanstack/react-start/server";

const SESSION_AGE = 60 * 60 * 8;
const FLOW_AGE = 60 * 10;
const SCOPES = ["openid", "profile"];

export type ForgeUser = {
  tenantId: string;
  objectId: string;
  name: string;
  groups: string[];
};

type Flow = {
  state?: string;
  nonce?: string;
  codeVerifier?: string;
  returnTo?: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

function sessionOptions(name: string, maxAge: number) {
  const password = requiredEnv("FORGE_SESSION_SECRET");
  if (password.length < 32) {
    throw new Error("FORGE_SESSION_SECRET must contain at least 32 characters");
  }
  return {
    name,
    password,
    maxAge,
    cookie: {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: requiredEnv("FORGE_AUTH_REDIRECT_URI").startsWith("https://"),
      maxAge,
      path: "/",
    },
  };
}

export function userSession() {
  return getServerSession<{ user?: ForgeUser; expiresAt?: number }>(
    sessionOptions("forge-session", SESSION_AGE),
  );
}

function flowSession() {
  return getServerSession<Flow>(sessionOptions("forge-auth-flow", FLOW_AGE));
}

function config() {
  const tenantId = requiredEnv("FORGE_ENTRA_TENANT_ID");
  const clientId = requiredEnv("FORGE_ENTRA_CLIENT_ID");
  const clientSecret = requiredEnv("FORGE_ENTRA_CLIENT_SECRET");
  const redirectUri = requiredEnv("FORGE_AUTH_REDIRECT_URI");
  const parsedUri = new URL(redirectUri);
  if (
    parsedUri.pathname !== "/auth/callback" ||
    parsedUri.search ||
    parsedUri.hash
  ) {
    throw new Error("FORGE_AUTH_REDIRECT_URI must end at /auth/callback");
  }
  if (parsedUri.protocol !== "https:" && parsedUri.hostname !== "localhost") {
    throw new Error("FORGE_AUTH_REDIRECT_URI must use HTTPS outside localhost");
  }
  return { tenantId, clientId, clientSecret, redirectUri };
}

function msal() {
  const { tenantId, clientId, clientSecret } = config();
  return new ConfidentialClientApplication({
    auth: {
      clientId,
      clientSecret,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
  });
}

export function safeReturnTo(value: string | null): string {
  if (
    !value?.startsWith("/") ||
    value.startsWith("//") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 || character === "\\";
    })
  ) {
    return "/";
  }
  if (value.startsWith("/auth/")) return "/";
  return value;
}

export function redirectTo(path: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: path, "Cache-Control": "no-store" },
  });
}

export async function beginLogin(request: Request): Promise<Response> {
  const { redirectUri } = config();
  const url = new URL(request.url);
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const { challenge, verifier } =
    await new CryptoProvider().generatePkceCodes();
  const flow = await flowSession();
  await flow.update({
    state,
    nonce,
    codeVerifier: verifier,
    returnTo: safeReturnTo(url.searchParams.get("returnTo")),
  });
  const signInUrl = await msal().getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri,
    state,
    nonce,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    responseMode: "query",
  });
  return redirectTo(signInUrl);
}

export async function finishLogin(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const flow = await flowSession();
  const { state, nonce, codeVerifier, returnTo } = flow.data;
  await flow.clear();

  const returnedState = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (
    !state ||
    !nonce ||
    !codeVerifier ||
    !returnedState ||
    returnedState !== state ||
    !code ||
    url.searchParams.has("error")
  ) {
    return redirectTo("/auth/error");
  }

  try {
    const { tenantId, redirectUri } = config();
    const result = await msal().acquireTokenByCode({
      code,
      scopes: SCOPES,
      redirectUri,
      nonce,
      codeVerifier,
    });
    const claims = result.idTokenClaims as Record<string, unknown> | undefined;
    if (
      claims?.tid !== tenantId ||
      typeof claims.oid !== "string" ||
      !claims.oid
    ) {
      return redirectTo("/auth/error");
    }

    const session = await userSession();
    await session.update({
      user: {
        tenantId,
        objectId: claims.oid,
        name: typeof claims.name === "string" ? claims.name : "Microsoft user",
        groups: Array.isArray(claims.groups)
          ? claims.groups.filter(
              (group): group is string => typeof group === "string",
            )
          : [],
      },
      expiresAt: Date.now() + SESSION_AGE * 1000,
    });
    return redirectTo(safeReturnTo(returnTo ?? null));
  } catch {
    return redirectTo("/auth/error");
  }
}

export async function currentUser(): Promise<ForgeUser | null> {
  const session = await userSession();
  if (
    !session.data.user ||
    session.data.user.tenantId !== requiredEnv("FORGE_ENTRA_TENANT_ID") ||
    !session.data.user.objectId ||
    !session.data.expiresAt ||
    session.data.expiresAt <= Date.now()
  ) {
    return null;
  }
  return session.data.user;
}

export function isAdmin(user: ForgeUser): boolean {
  const groupId = process.env.FORGE_ADMIN_GROUP_ID;
  return Boolean(
    groupId &&
      (user.groups ?? []).some(
        (group) => group.toLowerCase() === groupId.toLowerCase(),
      ),
  );
}

export async function signOut(): Promise<void> {
  const session = await userSession();
  await session.clear();
}
