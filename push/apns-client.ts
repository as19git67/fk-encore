/**
 * Talking to Apple's push gateway (#765).
 *
 * APNs speaks HTTP/2 only, which Node's `fetch` does not; `node:http2`
 * does. One session per gateway (production, sandbox) is kept open and
 * reopened when it drops — Apple closes idle connections, and a provider
 * that opens a connection per notification is throttled.
 *
 * Credentials are Encore secrets: the .p8 key, its Key ID and the Team
 * ID. Without all three `apnsEnabled()` is false and every send is a
 * no-op, exactly as the VAPID leg behaves without its keys.
 */

import http2, { type ClientHttp2Session } from "node:http2";
import { secret } from "encore.dev/config";
import { ProviderTokenCache, type ApnsCredentials } from "./apns-jwt";
import { APNS_HOSTS, buildApnsMessage, type ApnsEnvironment } from "./apns-payload";
import type { PushPayload } from "./push.service";

const apnsKeyId = secret("ApnsKeyId");
const apnsTeamId = secret("ApnsTeamId");
const apnsPrivateKey = secret("ApnsPrivateKey");

/** The app's bundle id — the `apns-topic` every notification is sent under. */
export function apnsTopic(): string {
  return process.env.APNS_BUNDLE_ID?.trim() || "de.f4mil.photos";
}

let credentials: ApnsCredentials | null | undefined;
function loadCredentials(): ApnsCredentials | null {
  if (credentials !== undefined) return credentials;
  try {
    const keyId = apnsKeyId();
    const teamId = apnsTeamId();
    const privateKey = apnsPrivateKey();
    credentials = keyId && teamId && privateKey ? { keyId, teamId, privateKey } : null;
  } catch {
    credentials = null;
  }
  return credentials;
}

export function apnsEnabled(): boolean {
  return loadCredentials() !== null;
}

export interface ApnsSendResult {
  status: number;
  /** Apple's `reason` on a non-200 answer. */
  reason?: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

class ApnsGateway {
  private sessions = new Map<ApnsEnvironment, ClientHttp2Session>();
  private tokens: ProviderTokenCache | null = null;

  private session(env: ApnsEnvironment): ClientHttp2Session {
    const existing = this.sessions.get(env);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = http2.connect(APNS_HOSTS[env]);
    session.on("error", (err) => {
      console.warn(`[apns] session error (${env}): ${(err as Error).message}`);
    });
    session.on("close", () => {
      if (this.sessions.get(env) === session) this.sessions.delete(env);
    });
    this.sessions.set(env, session);
    return session;
  }

  private providerToken(): string {
    if (!this.tokens) {
      const creds = loadCredentials();
      if (!creds) throw new Error("APNs is not configured");
      this.tokens = new ProviderTokenCache(creds);
    }
    return this.tokens.get();
  }

  async send(deviceToken: string, env: ApnsEnvironment, payload: PushPayload): Promise<ApnsSendResult> {
    const message = buildApnsMessage(payload, apnsTopic());
    const body = JSON.stringify(message.body);
    const attempt = (): Promise<ApnsSendResult> =>
      new Promise((resolve, reject) => {
        const session = this.session(env);
        const req = session.request({
          ":method": "POST",
          ":path": `/3/device/${deviceToken}`,
          authorization: `bearer ${this.providerToken()}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...message.headers,
        });
        let status = 0;
        const chunks: Buffer[] = [];
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
          req.close(http2.constants.NGHTTP2_CANCEL);
          reject(new Error("APNs request timed out"));
        });
        req.on("response", (headers) => {
          status = Number(headers[":status"] ?? 0);
        });
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("error", reject);
        req.on("end", () => {
          let reason: string | undefined;
          if (chunks.length > 0) {
            try {
              reason = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { reason?: string }).reason;
            } catch {
              reason = undefined;
            }
          }
          resolve({ status, reason });
        });
        req.end(body);
      });

    const result = await attempt();
    if (result.status === 403 && result.reason === "ExpiredProviderToken" && this.tokens) {
      // Clock drift can age a token faster than our cache thinks; mint
      // again and retry once.
      this.tokens.invalidate();
      return attempt();
    }
    return result;
  }
}

let gateway: ApnsGateway | null = null;

/** Send one notification to one device. Throws on transport failure;
 * Apple's own refusals come back as a result. */
export async function sendApns(deviceToken: string, env: ApnsEnvironment, payload: PushPayload): Promise<ApnsSendResult> {
  if (!gateway) gateway = new ApnsGateway();
  return gateway.send(deviceToken, env, payload);
}
