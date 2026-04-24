import { vi } from "vitest";

// Mock encore.dev and encore.dev/api to avoid ENCORE_RUNTIME_LIB error in unit tests
vi.mock("encore.dev", () => ({
  currentRequest: vi.fn(() => ({
    type: "api-call",
    headers: {},
  })),
}));

vi.mock("encore.dev/api", () => {
  class APIError extends Error {
    constructor(public code: string, message: string) {
      super(message);
      this.name = "APIError";
    }
    static abondoned(msg: string) { return new APIError("abondoned", msg); }
    static alreadyExists(msg: string) { return new APIError("already_exists", msg); }
    static deadlineExceeded(msg: string) { return new APIError("deadline_exceeded", msg); }
    static internal(msg: string) { return new APIError("internal", msg); }
    static invalidArgument(msg: string) { return new APIError("invalid_argument", msg); }
    static notFound(msg: string) { return new APIError("not_found", msg); }
    static outOfRange(msg: string) { return new APIError("out_of_range", msg); }
    static permissionDenied(msg: string) { return new APIError("permission_denied", msg); }
    static resourceExhausted(msg: string) { return new APIError("resource_exhausted", msg); }
    static unauthenticated(msg: string) { return new APIError("unauthenticated", msg); }
    static unavailable(msg: string) { return new APIError("unavailable", msg); }
    static unimplemented(msg: string) { return new APIError("unimplemented", msg); }
    static unknown(msg: string) { return new APIError("unknown", msg); }
  }

  return {
    api: (options: any, handler: any) => handler,
    APIError,
    Gateway: class Gateway {},
  };
});

vi.mock("~encore/auth", () => ({
  getAuthData: vi.fn(() => ({ userID: "1", permissions: [] })),
}));

// encore.dev/config is evaluated at module import time (secret() is
// typically called at the top of a file). Return a deterministic
// 32-zero-byte base64 string so modules that pass the secret into
// AES-GCM don't throw at import time; tests that need a real value
// override via vi.mocked() or call key-explicit helpers directly.
vi.mock("encore.dev/config", () => ({
  secret: vi.fn((_name: string) => {
    return () => Buffer.alloc(32).toString("base64");
  }),
}));

// `~encore/clients` is a codegen artifact that doesn't exist at test time.
// Provide no-op stubs for every cross-service call the code under test may
// trigger so unit tests can import services freely without spinning up the
// Encore runtime.
vi.mock("~encore/clients", () => ({
  realtime: {
    publishEvent: vi.fn(() => Promise.resolve()),
  },
  feed: {
    emitFeed: vi.fn(() => Promise.resolve()),
  },
  push: {
    fanoutFeed: vi.fn(() => Promise.resolve({ sent: 0, pruned: 0 })),
  },
  user: {
    listUserIdsWithPermission: vi.fn(() => Promise.resolve({ userIds: [] })),
  },
  sharedalbum: {
    fanoutAlbum: vi.fn(() => Promise.resolve()),
    fanoutPhoto: vi.fn(() => Promise.resolve()),
  },
}));
