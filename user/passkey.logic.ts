import crypto from "crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

type AuthenticatorTransportFuture = 'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb';

import db from "../db/database";
import type {
  PasskeyRow,
  PasskeyInfo,
  PasskeyRegistrationOptionsResponse,
  PasskeyRegistrationVerifyRequest,
  PasskeyAuthOptionsResponse,
  PasskeyAuthVerifyRequest,
  LoginResponse,
  ListPasskeysResponse,
  DeleteResponse,
  UserRow,
} from "../db/types";
import { toUser, getRolesForUser, getPermissionsForUser } from "./user.logic";

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
  db.prepare(`DELETE FROM challenges WHERE expires_at < datetime('now')`).run();
}

function storeChallenge(challenge: string, userId?: number): string {
  cleanupExpiredChallenges();
  const id = crypto.randomBytes(16).toString("base64url");
  db.prepare(
    `INSERT INTO challenges (id, challenge, user_id, expires_at) VALUES (?, ?, ?, datetime('now', '+5 minutes'))`
  ).run(id, challenge, userId ?? null);
  return id;
}

function getAndDeleteChallenge(
  challengeId: string
): { challenge: string; user_id: number | null } {
  const row = db
    .prepare(
      `SELECT challenge, user_id FROM challenges WHERE id = ? AND expires_at > datetime('now')`
    )
    .get(challengeId) as
    | { challenge: string; user_id: number | null }
    | undefined;

  if (!row) {
    throw new Error("challenge expired or invalid");
  }

  db.prepare(`DELETE FROM challenges WHERE id = ?`).run(challengeId);
  return row;
}

function getPasskeysForUser(userId: number): PasskeyRow[] {
  return db
    .prepare(`SELECT * FROM passkeys WHERE user_id = ?`)
    .all(userId) as PasskeyRow[];
}

function toPasskeyInfo(row: PasskeyRow): PasskeyInfo {
  return {
    credential_id: row.credential_id,
    name: row.name,
    device_type: row.device_type,
    backed_up: row.backed_up === 1,
    created_at: row.created_at,
  };
}

function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+24 hours'))`
  ).run(token, userId);
  return token;
}

// ---------- Registration ----------

export async function passkeyRegisterOptionsLogic(
  userId: number
): Promise<PasskeyRegistrationOptionsResponse> {
  const userRow = db
    .prepare(`SELECT * FROM users WHERE id = ?`)
    .get(userId) as UserRow | undefined;

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
      transports: JSON.parse(pk.transports) as AuthenticatorTransportFuture[],
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

  // credential.id is already a Base64URL string in @simplewebauthn/server v11+
  const credentialId = credential.id;
  // credential.publicKey is still a Uint8Array
  const publicKeyBase64 = Buffer.from(credential.publicKey).toString("base64url");
  const transports = JSON.stringify(req.credential.response?.transports ?? []);
  const name = req.name || "Passkey";

  db.prepare(
    `INSERT INTO passkeys (credential_id, user_id, public_key, counter, device_type, backed_up, transports, name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    credentialId,
    userId,
    publicKeyBase64,
    credential.counter,
    credentialDeviceType,
    credentialBackedUp ? 1 : 0,
    transports,
    name
  );

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
    .prepare(`SELECT * FROM passkeys WHERE credential_id = ?`)
    .get(credentialId) as PasskeyRow | undefined;

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
      transports: JSON.parse(passkey.transports) as AuthenticatorTransportFuture[],
    },
  });

  if (!verification.verified) {
    throw new Error("invalid credentials");
  }

  // Update counter
  db.prepare(`UPDATE passkeys SET counter = ? WHERE credential_id = ?`).run(
    verification.authenticationInfo.newCounter,
    credentialId
  );

  // Create session
  const userRow = db
    .prepare(`SELECT * FROM users WHERE id = ?`)
    .get(passkey.user_id) as UserRow;

  const token = createSession(userRow.id);

  return {
    user: { ...toUser(userRow), roles: getRolesForUser(userRow.id), permissions: getPermissionsForUser(userRow.id) },
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
    .prepare(`DELETE FROM passkeys WHERE credential_id = ? AND user_id = ?`)
    .run(credentialId, userId);

  if (result.changes === 0) {
    throw new Error("passkey not found");
  }

  return { success: true, message: "Passkey deleted" };
}

