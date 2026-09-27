import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthCodeUrl: vi.fn(),
  acquireTokenByCode: vi.fn(),
  flowUpdate: vi.fn(),
  flowClear: vi.fn(),
  userUpdate: vi.fn(),
  userClear: vi.fn(),
  flowData: {} as Record<string, unknown>,
  userData: {} as Record<string, unknown>,
}));

vi.mock("@azure/msal-node", () => ({
  ConfidentialClientApplication: class {
    getAuthCodeUrl = mocks.getAuthCodeUrl;
    acquireTokenByCode = mocks.acquireTokenByCode;
  },
  CryptoProvider: class {
    generatePkceCodes = async () => ({
      challenge: "challenge",
      verifier: "verifier",
    });
  },
}));

vi.mock("@tanstack/react-start/server", () => ({
  useSession: async ({ name }: { name: string }) =>
    name === "forge-auth-flow"
      ? {
          data: mocks.flowData,
          update: mocks.flowUpdate,
          clear: mocks.flowClear,
        }
      : {
          data: mocks.userData,
          update: mocks.userUpdate,
          clear: mocks.userClear,
        },
}));

import {
  beginLogin,
  currentUser,
  finishLogin,
  safeReturnTo,
  signOut,
} from "./auth.server";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FORGE_ENTRA_TENANT_ID = "11111111-1111-1111-1111-111111111111";
  process.env.FORGE_ENTRA_CLIENT_ID = "22222222-2222-2222-2222-222222222222";
  process.env.FORGE_ENTRA_CLIENT_SECRET = "test-secret";
  process.env.FORGE_AUTH_REDIRECT_URI = "http://localhost:5321/auth/callback";
  process.env.FORGE_SESSION_SECRET = "0123456789abcdefghijklmnopqrstuv";
  mocks.flowData = {};
  mocks.userData = {};
});

test("login creates a protected flow and keeps only a local return path", async () => {
  mocks.getAuthCodeUrl.mockResolvedValue(
    "https://login.microsoftonline.com/example",
  );
  const response = await beginLogin(
    new Request(
      "http://localhost:5321/auth/login?returnTo=https://evil.example",
    ),
  );

  expect(response.headers.get("Location")).toBe(
    "https://login.microsoftonline.com/example",
  );
  expect(mocks.flowUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ returnTo: "/", codeVerifier: "verifier" }),
  );
  expect(mocks.getAuthCodeUrl).toHaveBeenCalledWith(
    expect.objectContaining({
      state: expect.any(String),
      nonce: expect.any(String),
      codeChallenge: "challenge",
    }),
  );
  expect(safeReturnTo("//evil.example")).toBe("/");
  expect(safeReturnTo("/\\evil.example")).toBe("/");
  expect(safeReturnTo("/projects?id=1")).toBe("/projects?id=1");
});

test("callback rejects a mismatched state before exchanging the code", async () => {
  mocks.flowData = {
    state: "expected",
    nonce: "nonce",
    codeVerifier: "verifier",
  };
  const response = await finishLogin(
    new Request("http://localhost:5321/auth/callback?state=wrong&code=code"),
  );

  expect(response.headers.get("Location")).toBe("/auth/error");
  expect(mocks.flowClear).toHaveBeenCalledOnce();
  expect(mocks.acquireTokenByCode).not.toHaveBeenCalled();
});

test("callback creates a session only for the configured tenant", async () => {
  mocks.flowData = {
    state: "expected",
    nonce: "nonce",
    codeVerifier: "verifier",
    returnTo: "/projects",
  };
  mocks.acquireTokenByCode.mockResolvedValue({
    idTokenClaims: {
      tid: process.env.FORGE_ENTRA_TENANT_ID,
      oid: "user-id",
      name: "Alex",
    },
  });

  const response = await finishLogin(
    new Request("http://localhost:5321/auth/callback?state=expected&code=code"),
  );
  expect(response.headers.get("Location")).toBe("/projects");
  expect(mocks.acquireTokenByCode).toHaveBeenCalledWith(
    expect.objectContaining({ nonce: "nonce", codeVerifier: "verifier" }),
  );
  expect(mocks.userUpdate).toHaveBeenCalledWith(
    expect.objectContaining({
      user: {
        tenantId: process.env.FORGE_ENTRA_TENANT_ID,
        objectId: "user-id",
        name: "Alex",
        groups: [],
      },
    }),
  );

  mocks.userUpdate.mockClear();
  mocks.acquireTokenByCode.mockResolvedValue({
    idTokenClaims: { tid: "other-tenant", oid: "user-id" },
  });
  const rejected = await finishLogin(
    new Request("http://localhost:5321/auth/callback?state=expected&code=code"),
  );
  expect(rejected.headers.get("Location")).toBe("/auth/error");
  expect(mocks.userUpdate).not.toHaveBeenCalled();
});

test("expired sessions are rejected and sign-out clears the session", async () => {
  mocks.userData = {
    user: {
      tenantId: process.env.FORGE_ENTRA_TENANT_ID,
      objectId: "user-id",
      name: "Alex",
    },
    expiresAt: Date.now() - 1,
  };
  expect(await currentUser()).toBeNull();
  await signOut();
  expect(mocks.userClear).toHaveBeenCalledOnce();
});
