import { api, APIError } from "encore.dev/api";
import type {
  PasskeyRegistrationOptionsResponse,
  PasskeyRegistrationVerifyRequest,
  PasskeyAuthOptionsResponse,
  PasskeyAuthVerifyRequest,
  PasskeyInfo,
  LoginResponse,
  ListPasskeysResponse,
  DeleteResponse,
} from "../db/types";
import {
  passkeyRegisterOptionsLogic,
  passkeyRegisterVerifyLogic,
  passkeyAuthOptionsLogic,
  passkeyAuthVerifyLogic,
  listPasskeysLogic,
  deletePasskeyLogic,
} from "./passkey.service";
import { getAuthData } from "~encore/auth";

// ========== Registration (auth required — user must be logged in to add a passkey) ==========

/** Get passkey registration options — auth required */
export const passkeyRegisterOptions = api(
  { expose: true, auth: true, method: "POST", path: "/auth/passkey/register/options" },
  async (): Promise<PasskeyRegistrationOptionsResponse> => {
    const authData = getAuthData()!;
    try {
      return await passkeyRegisterOptionsLogic(Number(authData.userID));
    } catch (err: any) {
      if (err.message?.includes("not found")) {
        throw APIError.notFound(err.message);
      }
      throw err;
    }
  }
);

/** Verify passkey registration — auth required */
export const passkeyRegisterVerify = api(
  { expose: true, auth: true, method: "POST", path: "/auth/passkey/register/verify" },
  async (req: PasskeyRegistrationVerifyRequest): Promise<PasskeyInfo> => {
    const authData = getAuthData()!;
    try {
      return await passkeyRegisterVerifyLogic(req, Number(authData.userID));
    } catch (err: any) {
      if (err.message?.includes("expired")) {
        throw APIError.invalidArgument(err.message);
      }
      if (err.message?.includes("failed")) {
        throw APIError.invalidArgument(err.message);
      }
      throw err;
    }
  }
);

// ========== Authentication (no auth — this IS the login) ==========

/** Get passkey authentication options — no auth */
export const passkeyAuthOptions = api(
  { expose: true, method: "POST", path: "/auth/passkey/login/options" },
  async (): Promise<PasskeyAuthOptionsResponse> => {
    return await passkeyAuthOptionsLogic();
  }
);

/** Verify passkey authentication — no auth */
export const passkeyAuthVerify = api(
  { expose: true, method: "POST", path: "/auth/passkey/login/verify" },
  async (req: PasskeyAuthVerifyRequest): Promise<LoginResponse> => {
    try {
      return await passkeyAuthVerifyLogic(req);
    } catch (err: any) {
      if (err.message?.includes("invalid credentials")) {
        throw APIError.unauthenticated(err.message);
      }
      if (err.message?.includes("expired")) {
        throw APIError.invalidArgument(err.message);
      }
      throw err;
    }
  }
);

// ========== Management (auth required) ==========

/** List passkeys for the current user — auth required */
export const listPasskeys = api(
  { expose: true, auth: true, method: "GET", path: "/auth/passkeys" },
  async (): Promise<ListPasskeysResponse> => {
    const authData = getAuthData()!;
    return listPasskeysLogic(Number(authData.userID));
  }
);

/** Delete a passkey — auth required */
export const deletePasskey = api(
  { expose: true, auth: true, method: "DELETE", path: "/auth/passkeys/:credentialId" },
  async ({ credentialId }: { credentialId: string }): Promise<DeleteResponse> => {
    const authData = getAuthData()!;
    try {
      return deletePasskeyLogic(Number(authData.userID), credentialId);
    } catch (err: any) {
      if (err.message?.includes("not found")) {
        throw APIError.notFound(err.message);
      }
      throw err;
    }
  }
);

