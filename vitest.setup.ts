import { vi } from "vitest";

// Mock encore.dev and encore.dev/api to avoid ENCORE_RUNTIME_LIB error in unit tests
vi.mock("encore.dev", () => ({
  currentRequest: vi.fn(() => ({
    type: "api-call",
    headers: {},
  })),
}));

// `encore.dev/log` ships as a thin native-module wrapper that hits the
// ENCORE_RUNTIME_LIB guard the moment it's imported. Tests don't care
// about log destinations — silence it with no-ops.
vi.mock("encore.dev/log", () => ({
  default: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    with: vi.fn(() => ({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

// `encore.dev/cron` evaluates `new CronJob(...)` at module import; the
// constructor reaches into the runtime. Stub it so the module loads
// without ENCORE_RUNTIME_LIB.
vi.mock("encore.dev/cron", () => ({
  CronJob: class {
    constructor(_id: string, _opts: unknown) {}
  },
}));

vi.mock("encore.dev/api", () => {
  class APIError extends Error {
    constructor(public code: string, message: string) {
      super(message);
      this.name = "APIError";
    }
    static abondoned(msg: string) { return new APIError("abondoned", msg); }
    static aborted(msg: string) { return new APIError("aborted", msg); }
    static alreadyExists(msg: string) { return new APIError("already_exists", msg); }
    static deadlineExceeded(msg: string) { return new APIError("deadline_exceeded", msg); }
    static failedPrecondition(msg: string) { return new APIError("failed_precondition", msg); }
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

  const api: any = (options: any, handler: any) => handler;
  // `api.raw` / `api.streamIn` / `api.streamOut` / `api.streamInOut`
  // mirror the same "unwrap the handler" semantics so unit tests can
  // call them directly without the Encore runtime.
  api.raw = (options: any, handler: any) => handler;
  api.streamIn = (options: any, handler: any) => handler;
  api.streamOut = (options: any, handler: any) => handler;
  api.streamInOut = (options: any, handler: any) => handler;
  api.static = (options: any) => options;

  return {
    api,
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
    connectionStatus: vi.fn(() => Promise.resolve({ connected: false })),
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
  aiqueue: {
    acquireSlot: vi.fn(() => Promise.resolve({ slotId: 1, status: "active", position: 0 })),
    pollSlot: vi.fn(() => Promise.resolve({ status: "active", position: 0 })),
    releaseSlot: vi.fn(() => Promise.resolve()),
    cancelSlot: vi.fn(() => Promise.resolve()),
  },
}));
