/**
 * The assistant calls the app, never the database: every tool goes through
 * `~encore/clients`, so the asking user's auth data travels with the call and
 * the target service applies its own permission checks a second time.
 *
 * Lookup is by service and endpoint name because the catalog generated from
 * the OpenAPI spec names its operations that way (`GET:photo.listAlbums`).
 * Only services imported here can be reached; a generated entry for any other
 * service fails with a clear error rather than at build time.
 */

import { documents, finance, meter, photo } from "~encore/clients";

type Endpoint = (params?: unknown) => Promise<unknown>;

const SERVICES: Record<string, unknown> = { documents, finance, meter, photo };

export function endpoint(service: string, name: string): Endpoint {
  const client = SERVICES[service] as Record<string, unknown> | undefined;
  const fn = client?.[name];
  if (typeof fn !== "function") throw new Error(`no client for ${service}.${name}`);
  return fn as Endpoint;
}

/** Call an endpoint of another service as the current user. */
export async function call<T>(service: string, name: string, params?: unknown): Promise<T> {
  return (await endpoint(service, name)(params)) as T;
}
