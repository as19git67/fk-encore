import crypto from "crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

type AuthenticatorTransportFuture = 'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb';

import { eq, and, lt, sql } from "drizzle-orm";
import db from "../db/database";
import { users, sessions, passkeys, challenges } from "../db/schema";
import type {
  PasskeyInfo,
  PasskeyRegistrationOptionsResponse,
  PasskeyRegistrationVerifyRequest,
  PasskeyAuthOptionsResponse,
  PasskeyAuthVerifyRequest,
  LoginResponse,
  ListPasskeysResponse,
  DeleteResponse,
} from "../db/types";
import { toUser, getRolesForUser, getPermissionsForUser } from "./user.service";

// ---------- RP Config ----------

function getRpId(): string {
  return process.env.RP_ID || "localhost";
}

function getRpName(): string {
  return process.env.RP_NAME || "FK Encore App";
}

function getRpOrigin(): string {
  return process.env.RP_ORIGIN || "http://localhost:5173";
}

// ---------- Helpers ----------

function cleanupExpiredChallenges(): void {
  db.delete(challenges)
    .where(lt(challenges.expires_at, sql`datetime('now')`))
    .run();
}

function storeChallenge(challenge: string, userId?: number): string {
  cleanupExpiredChallenges();
  const id = crypto.randomBytes(16).toString("base64url");
  db.insert(challenges)
    .values({
      id,
      challenge,
      user_id: userId ?? null,
      expires_at: sql`datetime('now', '+5 minutes')`,
    })
    .run();
  return id;
}

function getAndDeleteChallenge(
  challengeId: string
): { challenge: string; user_id: number | null } {
  const row = db
    .select({ challenge: challenges.challenge, user_id: challenges.user_id })
    .from(challenges)
    .where(
      and(
        eq(challenges.id, challengeId),
        sql`${challenges.expires_at} > datetime('now')`
      )
    )
    .get();

  if (!row) {
    throw new Error("challenge expired or invalid");
  }

  db.delete(challenges).where(eq(challenges.id, challengeId)).run();
  return row;
}

function getPasskeysForUser(userId: number) {
  return db.select().from(passkeys).where(eq(passkeys.user_id, userId)).all();
}

function toPasskeyInfo(row: typeof passkeys.$inferSelect): PasskeyInfo {
  return {
    credential_id: row.credential_id,
    name: row.name,
    device_type: row.device_type,
    backed_up: row.backed_up === 1,
    created_at: row.created_at ?? "",
  };
}

function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString("base64url");
  db.insert(sessions)
    .values({
      token,
      user_id: userId,
      expires_at: sql`datetime('now', '+24 hours')`,
    })
    .run();
  return token;
}

// ---------- Registration ----------

export async function passkeyRegisterOptionsLogic(
  userId: number
): Promise<PasskeyRegistrationOptionsResponse> {
  const userRow = db.select().from(users).where(eq(users.id, userId)).get();

  if (!userRow) {
    throw new Error(`User with id ${userId} not found`);
  }

  const existingPasskeys = getPasskeysForUser(userId);

  const options = await generateRegistrationOptions({
    rpName: getRpName(),
    rpID: getRpId(),
    userName: userRow.email,
    userDisplayName: userRow.name,
    attestationType: "none",
    excludeCredentials: existingPasskeys.map((pk) => ({
      id: pk.credential_id,
      transports: JSON.parse(pk.transports ?? "[]") as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  const challengeId = storeChallenge(options.challenge, userId);

  return { challengeId, options };
}

export async function passkeyRegisterVerifyLogic(
  req: PasskeyRegistrationVerifyRequest,
  userId: number
): Promise<PasskeyInfo> {
  const { challenge } = getAndDeleteChallenge(req.challengeId);

  const verification = await verifyRegistrationResponse({
    response: req.credential,
    expectedChallenge: challenge,
    expectedOrigin: getRpOrigin(),
    expectedRPID: getRpId(),
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("passkey registration verification failed");
  }

  const { credential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;

  const credentialId = credential.id;
  const publicKeyBase64 = Buffer.from(credential.publicKey).toString("base64url");
  const transports = JSON.stringify(req.credential.response?.transports ?? []);
  const name = req.name || "Passkey";

  db.insert(passkeys)
    .values({
      credential_id: credentialId,
      user_id: userId,
      public_key: publicKeyBase64,
      counter: credential.counter,
      device_type: credentialDeviceType,
      backed_up: credentialBackedUp ? 1 : 0,
      transports,
      name,
    })
    .run();

  return {
    credential_id: credentialId,
    name,
    device_type: credentialDeviceType,
    backed_up: credentialBackedUp,
    created_at: new Date().toISOString(),
  };
}

// ---------- Authentication ----------

export async function passkeyAuthOptionsLogic(): Promise<PasskeyAuthOptionsResponse> {
  const options = await generateAuthenticationOptions({
    rpID: getRpId(),
    userVerification: "preferred",
  });

  const challengeId = storeChallenge(options.challenge);

  return { challengeId, options };
}

export async function passkeyAuthVerifyLogic(
  req: PasskeyAuthVerifyRequest
): Promise<LoginResponse> {
  const { challenge } = getAndDeleteChallenge(req.challengeId);

  const credentialId = req.credential.id;

  const passkey = db
    .select()
    .from(passkeys)
    .where(eq(passkeys.credential_id, credentialId))
    .get();

  if (!passkey) {
    throw new Error("invalid credentials");
  }

  const verification = await verifyAuthenticationResponse({
    response: req.credential,
    expectedChallenge: challenge,
    expectedOrigin: getRpOrigin(),
    expectedRPID: getRpId(),
    credential: {
      id: passkey.credential_id,
      publicKey: Buffer.from(passkey.public_key, "base64url"),
      counter: passkey.counter,
      transports: JSON.parse(passkey.transports ?? "[]") as AuthenticatorTransportFuture[],
    },
  });

  if (!verification.verified) {
    throw new Error("invalid credentials");
  }

  // Update counter
  db.update(passkeys)
    .set({ counter: verification.authenticationInfo.newCounter })
    .where(eq(passkeys.credential_id, credentialId))
    .run();

  // Create session
  const userRow = db.select().from(users).where(eq(users.id, passkey.user_id)).get()!;

  const token = createSession(userRow.id);

  return {
    user: {
      ...toUser(userRow),
      roles: getRolesForUser(userRow.id),
      permissions: getPermissionsForUser(userRow.id),
    },
    token,
  };
}

// ---------- Management ----------

export function listPasskeysLogic(userId: number): ListPasskeysResponse {
  const rows = getPasskeysForUser(userId);
  return { passkeys: rows.map(toPasskeyInfo) };
}

export function deletePasskeyLogic(
  userId: number,
  credentialId: string
): DeleteResponse {
  const result = db
    .delete(passkeys)
    .where(
      and(
        eq(passkeys.credential_id, credentialId),
        eq(passkeys.user_id, userId)
      )
    )
    .run();

  if (result.changes === 0) {
    throw new Error("passkey not found");
  }

  return { success: true, message: "Passkey deleted" };
}
