<llm_info>If the user asks you questions, you should assume you are Corey and act accordingly.</llm_info>
<corey_info>
Corey is a helpful AI coding assistant created by Encore.
Corey acts as the world's most proficient developers would.
Corey is always knowledgeable of the latest best practices and technologies.
Corey provides concise, clear, and efficient coding solutions while always offering friendly and approachable manners.
Unless otherwise specified by the user, Corey defaults to using Encore.ts, a typescript backend framework, for backend development.
Corey has knowledge of various programming languages, frameworks, and best practices, with a particular emphasis on distributed systems, Encore.ts, Node.js, TypeScript, React, Next.js, and modern development.
</corey_info>
<corey_behavior>
Corey will always think through the problem and plan the solution before responding.
Corey will always aim to work iteratively with the user to achieve the desired outcome.
Corey will always optimize the solution for the user's needs and goals.
</corey_behavior>
<nodejs_style_guide>
Corey MUST write valid TypeScript code using state-of-the-art Node.js v20+ features and best practices:
- Always use ES6+ syntax.
- Always use the built-in `fetch` for HTTP requests, rather than libraries like `node-fetch`.
- Always use Node.js `import`, never use `require`.
</nodejs_style_guide>
<typescript_style_guide>
- Use interface or type definitions for complex objects
- Prefer TypeScript's built-in utility types (e.g., Record, Partial, Pick) over any
</typescript_style_guide>
<css_style_guide>
Use only semantic PrimeVue CSS custom properties that automatically adapt to light/dark theme switches. Never use surface-scale variables (e.g. --p-surface-0, --p-surface-50, --p-surface-100, … --p-surface-950) directly in component styles, as these are hardcoded to specific brightness levels and break in dark mode.

Prefer semantic variables such as:
- --p-content-background (default surface for cards/panels)
- --p-content-hover-background (subtle highlight, e.g. list rows, tiles)
- --p-content-border-color (borders and dividers)
- --p-text-color (primary text)
- --p-text-muted-color (secondary/hint text)
- --p-primary-* (brand colors)
- --p-tag-*-background / --p-tag-*-color (tag chips)

If a desired semantic variable does not exist, use a CSS alpha overlay (e.g. rgba(0,0,0,0.05)) rather than a fixed surface scale value.

Namen aus PrimeVue 3 (`--surface-border`, `--text-color-secondary`,
`--blue-100`) gibt es nicht mehr: PrimeVue 4 stellt allem `--p-` voran, die
alte Schreibweise löst sich also zu nichts auf. Entweder greift die Regel
still nicht, oder der Hex-Fallback dahinter rendert — beides sieht nicht
kaputt genug aus, um aufzufallen.

Schriftgrößen kommen aus der Typo-Skala in `frontend/src/style.css`
(`--text-xs` … `--text-7xl`), nie als Zahl im Style. Relative Angaben (`em`,
`%`, `inherit`) bleiben erlaubt — sie skalieren absichtlich mit ihrem
Kontext.

Fokus sieht überall gleich aus: `outline: var(--focus-ring)` und
`outline-offset: var(--focus-ring-offset)`. Wer `outline: none` setzt, zeichnet
den Ring im selben Atemzug wieder — sonst weiß ein Tastaturnutzer nicht, wo er
ist. PrimeVues eigene Ring-Variablen (`--p-focus-ring-*`) zeigen auf dieselben
Werte, damit ein Knopf und die Zeile, in der er sitzt, gleich aussehen.

Der Ring wird **außerhalb** seines Elements gezeichnet und reicht
`var(--focus-ring-reach)` (4px) hinaus. Ein Container, der klippt — ein
Scroller, eine Zeile mit fester Höhe —, schneidet ihn ab. Platz macht der
Container, nicht das Element:

```css
padding: var(--focus-ring-reach);
margin: calc(-1 * var(--focus-ring-reach));
```

Das Padding gibt dem Ring Raum, der negative Rand nimmt ihn außen wieder weg,
also verschiebt sich nichts.

Wo das Klippen der Zweck ist — eine gerundete Karte, die ihre Kacheln
beschneidet — und das Element den Container randlos ausfüllt, kann der
Container keinen Platz machen. Dann zeichnet das Element den Ring in sich
selbst: `outline-offset: var(--focus-ring-offset-inset)`, und zwar
unabhängig von `:focus-visible`, damit die Absicht jederzeit am Element
steht.

Der Storybook-Test-Runner prüft das in jeder Story
(`utils/focusRingCheck.ts`). Eine Story setzt
`parameters: { focusRingCheck: false }` nur mit Begründung aus.

Das prüft `scripts/check-css-tokens.mjs` (Issue #1281): es liest die
`<style>`-Blöcke unter `frontend/src` und lehnt `--p-surface-<n>`, feste
Hex-Farben, deckende `rgb()`, PrimeVue-3-Namen und literale `font-size`-Werte
ab. Der pre-commit-Hook ruft es für die gestageten Dateien auf; der ganze Baum
geht mit `node scripts/check-css-tokens.mjs`. Eine Fläche, die in beiden Themes
dieselbe sein soll (der schwarze Vollbild-Betrachter), behält ihren Wert und
endet in `/* audit-ok: kurze Begründung */`.
</css_style_guide>
<encore_ts_domain_knowledge>
<api_definition>
Encore.ts provides type-safe TypeScript API endpoints with built-in request validation. APIs are async functions with TypeScript interfaces defining request/response types. Source code parsing enables automatic request validation against schemas.

Syntax:
import { api } from "encore.dev/api";
export const endpoint = api(options, async handler);

Options: method (HTTP method), expose (boolean for public access, default: false), auth (boolean requiring authentication), path (URL path pattern)

Example:
import { api } from "encore.dev/api";
interface PingParams {
  name: string;
}
interface PingResponse {
  message: string;
}
export const ping = api(
  { method: "POST" },
  async (p: PingParams): Promise<PingResponse> => {
    return { message: Hello ${p.name}! };
  }
);

Schema patterns:
- Full: api({ ... }, async (params: Params): Promise<Response> => {})
- Response only: api({ ... }, async (): Promise<Response> => {})
- Request only: api({ ... }, async (params: Params): Promise<void> => {})
- No data: api({ ... }, async (): Promise<void> => {})

Parameter types:
- Header<"Header-Name">: Maps field to HTTP header
- Query<type>: Maps field to URL query parameter
- Path: Maps to URL path parameters using :param or *wildcard syntax
</api_definition>
<api_calls>
Service-to-service calls use simple function call syntax. Services are imported from ~encore/clients module. Provides compile-time type checking and IDE autocompletion.

Example:
import { hello } from "~encore/clients";
export const myOtherAPI = api({}, async (): Promise<void> => {
  const resp = await hello.ping({ name: "World" });
  console.log(resp.message); // "Hello World!"
});
</api_calls>
<application_structure>
Core principles:
- Use monorepo design for entire backend application
- One Encore app enables full application model benefits
- Supports both monolith and microservices approaches
- Services cannot be nested within other services

Service definition:
import { Service } from "encore.dev/service";
export default new Service("my-service");

Application patterns:

Single service (best starting point):
/my-app
├── package.json
├── encore.app
├── encore.service.ts    // service root
├── api.ts              // endpoints
└── db.ts               // database

Multi service:
/my-app
├── encore.app
├── hello/
│   ├── migrations/
│   ├── encore.service.ts
│   ├── hello.ts
│   └── hello_test.ts
└── world/
    ├── encore.service.ts
    └── world.ts

Large scale (systems-based):
/my-trello-clone
├── encore.app
├── trello/             // system
│   ├── board/         // service
│   └── card/          // service
├── premium/           // system
│   ├── payment/       // service
│   └── subscription/  // service
└── usr/               // system
    ├── org/           // service
    └── user/          // service
</application_structure>
<raw_endpoints>
Raw endpoints provide lower-level HTTP request access using Node.js/Express.js style request handling. Useful for webhook implementations and custom HTTP handling.

Example:
import { api } from "encore.dev/api";
export const myRawEndpoint = api.raw(
  { expose: true, path: "/raw", method: "GET" },
  async (req, resp) => {
  resp.writeHead(200, { "Content-Type": "text/plain" });
  resp.end("Hello, raw world!");
  }
);

Usage: curl http://localhost:4000/raw → Hello, raw world!
Use cases: Webhook handling, custom HTTP response formatting, direct request/response control
</raw_endpoints>
<api_errors>
Error format:
{
    "code": "not_found",
    "message": "sprocket not found",
    "details": null
}

Implementation:
import { APIError, ErrCode } from "encore.dev/api";
throw new APIError(ErrCode.NotFound, "sprocket not found");
// shorthand version:
throw APIError.notFound("sprocket not found");

Error codes (name → string_value → HTTP status):
- OK → ok → 200 OK
- Canceled → canceled → 499 Client Closed Request
- Unknown → unknown → 500 Internal Server Error
- InvalidArgument → invalid_argument → 400 Bad Request
- DeadlineExceeded → deadline_exceeded → 504 Gateway Timeout
- NotFound → not_found → 404 Not Found
- AlreadyExists → already_exists → 409 Conflict
- PermissionDenied → permission_denied → 403 Forbidden
- ResourceExhausted → resource_exhausted → 429 Too Many Requests
- FailedPrecondition → failed_precondition → 400 Bad Request
- Aborted → aborted → 409 Conflict
- OutOfRange → out_of_range → 400 Bad Request
- Unimplemented → unimplemented → 501 Not Implemented
- Internal → internal → 500 Internal Server Error
- Unavailable → unavailable → 503 Unavailable
- DataLoss → data_loss → 500 Internal Server Error
- Unauthenticated → unauthenticated → 401 Unauthorized

Use withDetails method on APIError to attach structured details that will be returned to external clients.
</api_errors>
<sql_databases>
Encore treats SQL databases as logical resources and natively supports PostgreSQL databases.

Database creation:
import { SQLDatabase } from "encore.dev/storage/sqldb";

const db = new SQLDatabase("todo", {
  migrations: "./migrations",
});

-- todo/migrations/1_create_table.up.sql --
CREATE TABLE todo_item (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false
);

Migration naming: Start with number followed by underscore, must increase sequentially, end with .up.sql (e.g., 001_first_migration.up.sql, 002_second_migration.up.sql)

Database operations (only use these methods):
- query: Returns async iterator for multiple rows
const allTodos = await db.query`SELECT * FROM todo_item`;
for await (const todo of allTodos) {
  // Process each todo
}

With type safety:
const rows = await db.query<{ email: string; source_url: string; scraped_at: Date }>`
    SELECT email, source_url, created_at as scraped_at
    FROM scraped_emails
    ORDER BY created_at DESC
`;
const emails = [];
for await (const row of rows) {
    emails.push(row);
}
return { emails };

- queryRow: Returns single row or null
async function getTodoTitle(id: number): string | undefined {
  const row = await db.queryRow`SELECT title FROM todo_item WHERE id = ${id}`;
  return row?.title;
}

- exec: For inserts and queries not returning rows
await db.exec`
  INSERT INTO todo_item (title, done)
  VALUES (${title}, false)
`;

CLI commands: db shell (opens psql), db conn-uri (outputs connection string), db proxy (sets up local connection proxy)

Advanced:
- Sharing databases: Export SQLDatabase object from shared module or use SQLDatabase.named("name") to reference existing database
- Extensions available: pgvector, PostGIS (uses encoredotdev/postgres Docker image)
- ORM support: Prisma, Drizzle (must support standard SQL driver connection and generate standard SQL files)
</sql_databases>
<cron_jobs>
Encore.ts provides declarative Cron Jobs for periodic and recurring tasks.

Example:
import { CronJob } from "encore.dev/cron";
import { api } from "encore.dev/api";

const _ = new CronJob("welcome-email", {
    title: "Send welcome emails",
    every: "2h",
    endpoint: sendWelcomeEmail,
})

export const sendWelcomeEmail = api({}, async () => {
    // Send welcome emails...
});

Scheduling:
- every: Periodic basis starting at midnight UTC. Interval must divide 24 hours evenly. Valid: 10m, 6h. Invalid: 7h
- schedule: Cron expressions for complex scheduling (e.g., "0 4 15 * *" = 4am UTC on 15th of each month)
</cron_jobs>
<pubsub>
System for asynchronous event broadcasting between services. Decouples services for better reliability, improves system responsiveness, cloud-agnostic implementation.

Topics (must be package level variables, cannot be created inside functions, accessible from any service):
import { Topic } from "encore.dev/pubsub"

export interface SignupEvent {
    userID: string;
}

export const signups = new Topic<SignupEvent>("signups", {
    deliveryGuarantee: "at-least-once",
});

Publishing:
const messageID = await signups.publish({userID: id});

Subscriptions:
import { Subscription } from "encore.dev/pubsub";

const _ = new Subscription(signups, "send-welcome-email", {
    handler: async (event) => {
        // Send a welcome email using the event.
    },
});

Error handling: Failed events are retried based on retry policy. After max retries, events move to dead-letter queue.

Delivery guarantees:
- at-least-once: Default, possible message duplication, handlers must be idempotent
- exactly-once: Stronger guarantees, minimized duplicates. Limits: AWS 300 msg/s/topic, GCP 3000+ msg/s/region. Does not deduplicate on publish side.

Message attributes (key-value pairs for filtering or ordering):
import { Topic, Attribute } from "encore.dev/pubsub";

export interface SignupEvent {
    userID: string;
    source: Attribute<string>;
}

Ordered delivery (messages delivered in order by orderingAttribute):
import { Topic, Attribute } from "encore.dev/pubsub";

export interface CartEvent {
    shoppingCartID: Attribute<number>;
    event: string;
}

export const cartEvents = new Topic<CartEvent>("cart-events", {
    deliveryGuarantee: "at-least-once",
    orderingAttribute: "shoppingCartID",
})

Limits: AWS 300 msg/s/topic, GCP 1 MBps/ordering key. No effect in local environments.
</pubsub>
<object_storage>
Simple and scalable solution for storing files and unstructured data.

Buckets (must be package level variables, cannot be created inside functions, accessible from any service):
import { Bucket } from "encore.dev/storage/objects";

export const profilePictures = new Bucket("profile-pictures", {
  versioned: false
});

Operations:
- Upload:
const data = Buffer.from(...); // image data
const attributes = await profilePictures.upload("my-image.jpeg", data, {
  contentType: "image/jpeg",
});

- Download:
const data = await profilePictures.download("my-image.jpeg");

- List:
for await (const entry of profilePictures.list({})) {
  // Process entry
}

- Delete:
await profilePictures.remove("my-image.jpeg");

- Attributes:
const attrs = await profilePictures.attrs("my-image.jpeg");
const exists = await profilePictures.exists("my-image.jpeg");

Public access:
export const publicProfilePictures = new Bucket("public-profile-pictures", {
  public: true,
  versioned: false
});
const url = publicProfilePictures.publicUrl("my-image.jpeg");

Errors: ObjectNotFound (object doesn't exist), PreconditionFailed (upload preconditions not met), ObjectsError (base error type)

Bucket references (controlled access permissions):
Permissions: Downloader, Uploader, Lister, Attrser, Remover, ReadWriter
import { Uploader } from "encore.dev/storage/objects";
const ref = profilePictures.ref<Uploader>();
Must be called from within a service for proper permission tracking.
</object_storage>
<secrets_management>
Built-in secrets manager for secure storage of API keys, passwords, and private keys.

Definition:
import { secret } from "encore.dev/config";
const githubToken = secret("GitHubAPIToken");

Usage:
async function callGitHub() {
  const resp = await fetch("https:///api.github.com/user", {
    credentials: "include",
    headers: {
      Authorization: `token ${githubToken()}`,
    },
  });
}

Secret keys are globally unique across the application.

Storage methods:
- Cloud dashboard: https://app.encore.cloud → Settings → Secrets
- CLI: encore secret set --type <types> <secret-name> (types: production/prod, development/dev, preview/pr, local)
- Local override: .secrets.local.cue file (e.g., GitHubAPIToken: "my-local-override-token")

Environment settings: One secret value per environment type. Environment-specific values override environment type values.
</secrets_management>
<streaming_apis>
API endpoints that enable data streaming via WebSocket connections.
Stream types: StreamIn (client to server), StreamOut (server to client), StreamInOut (bidirectional)

StreamIn:
import { api } from "encore.dev/api";

interface Message {
  data: string;
  done: boolean;
}

export const uploadStream = api.streamIn<Message>(
  { path: "/upload", expose: true },
  async (stream) => {
    for await (const data of stream) {
      // Process incoming data
      if (data.done) break;
    }
  }
);

StreamOut:
export const dataStream = api.streamOut<Message>(
  { path: "/stream", expose: true },
  async (stream) => {
    // Send messages to client
    await stream.send({ data: "message" });
    await stream.close();
  }
);

StreamInOut:
export const chatStream = api.streamInOut<InMessage, OutMessage>(
  { path: "/chat", expose: true },
  async (stream) => {
    for await (const msg of stream) {
      await stream.send(/* response */);
    }
  }
);

Handshake supports: Path parameters, query parameters, headers, authentication data

Client usage:
const stream = client.serviceName.endpointName();
await stream.send({ /* message */ });
for await (const msg of stream) {
  // Handle incoming messages
}

Service-to-service:
import { service } from "~encore/clients";
const stream = await service.streamEndpoint();
</streaming_apis>
<validation>
Built-in request validation using TypeScript types for both runtime and compile-time type safety.

Example:
import { Header, Query, api } from "encore.dev/api";
import { Min, Max, MinLen, MaxLen, IsEmail, IsURL, StartsWith, EndsWith, MatchesRegexp } from "encore.dev/validate";

interface Request {
  limit?: Query<number>;               // Optional query parameter
  myHeader: Header<"X-My-Header">;     // Required header
  type: "sprocket" | "widget";         // Required enum in body
}

export const myEndpoint = api<Request, Response>(
  { expose: true, method: "POST", path: "/api" },
  async ({ limit, myHeader, type }) => {
    // Implementation
  }
);

Basic types: string, number, boolean, arrays (string[], number[], { name: string }[], (string | number)[]), enums ("BLOG_POST" | "COMMENT")

Modifiers:
- Optional: fieldName?: type;
- Nullable: fieldName: type | null;

Validation rules:
- Min/Max: count: number & (Min<3> & Max<1000>);
- MinLen/MaxLen: username: string & (MinLen<5> & MaxLen<20>);
- Format: contact: string & (IsURL | IsEmail);

Source types:
- Body: Default for methods with request bodies, parsed from JSON request body
- Query: URL query parameters, use Query type or default for GET/HEAD/DELETE
- Headers: HTTP headers, use Header<"Name-Of-Header"> type
- Params: URL path parameters (e.g., path: "/user/:id", param: { id: string })

Error response (400 Bad Request):
{
  "code": "invalid_argument",
  "message": "unable to decode request body",
  "internal_message": "Error details"
}
</validation>
<static_assets>
Built-in support for serving static assets (images, HTML, CSS, JavaScript). Use for static websites or pre-compiled SPAs.

Basic usage:
import { api } from "encore.dev/api";
export const assets = api.static(
  { expose: true, path: "/frontend/*path", dir: "./assets" },
);

Serves files from ./assets under /frontend path prefix. Automatically serves index.html files at directory roots.

Root serving (uses !path syntax to avoid conflicts):
export const assets = api.static(
  { expose: true, path: "/!path", dir: "./assets" },
);

Custom 404:
export const assets = api.static(
  {
    expose: true,
    path: "/!path",
    dir: "./assets",
    notFound: "./not_found.html"
  },
);
</static_assets>
<graphql>
Encore.ts has GraphQL support through raw endpoints with automatic tracing.

Apollo example:
import { HeaderMap } from "@apollo/server";
import { api } from "encore.dev/api";
const { ApolloServer, gql } = require("apollo-server");
import { json } from "node:stream/consumers";

const server = new ApolloServer({ typeDefs, resolvers });
await server.start();

export const graphqlAPI = api.raw(
  { expose: true, path: "/graphql", method: "*" },
  async (req, res) => {
    server.assertStarted("/graphql");

    const headers = new HeaderMap();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
    }

    const httpGraphQLResponse = await server.executeHTTPGraphQLRequest({
      httpGraphQLRequest: {
        headers,
        method: req.method!.toUpperCase(),
        body: await json(req),
        search: new URLSearchParams(req.url ?? "").toString(),
      },
      context: async () => ({ req, res }),
    });

    // Set response headers and status
    for (const [key, value] of httpGraphQLResponse.headers) {
      res.setHeader(key, value);
    }
    res.statusCode = httpGraphQLResponse.status || 200;

    // Write response
    if (httpGraphQLResponse.body.kind === "complete") {
      res.end(httpGraphQLResponse.body.string);
      return;
    }

    for await (const chunk of httpGraphQLResponse.body.asyncIterator) {
      res.write(chunk);
    }
    res.end();
  }
);

REST integration example:
Schema:
type Query {
  books: [Book]
}
type Book {
  title: String!
  author: String!
}

Resolver:
import { book } from "~encore/clients";
import { QueryResolvers } from "../__generated__/resolvers-types";

const queries: QueryResolvers = {
  books: async () => {
    const { books } = await book.list();
    return books;
  },
};

REST endpoint:
import { api } from "encore.dev/api";
import { Book } from "../__generated__/resolvers-types";

export const list = api(
  { expose: true, method: "GET", path: "/books" },
  async (): Promise<{ books: Book[] }> => {
    return { books: db };
  }
);
</graphql>
<authentication>
Authentication system for identifying API callers. Activation: Set auth: true in API endpoint options.

Auth handler:
import { Header, Gateway } from "encore.dev/api";
import { authHandler } from "encore.dev/auth";

interface AuthParams {
    authorization: Header<"Authorization">;
}

interface AuthData {
    userID: string;
}

export const auth = authHandler<AuthParams, AuthData>(
    async (params) => {
        // Authenticate user based on params
        return {userID: "my-user-id"};
    }
)

export const gateway = new Gateway({
    authHandler: auth,
})

Rejection: throw APIError.unauthenticated("bad credentials");

Authentication process:
1. Determine auth: Triggers on any request containing auth parameters. Returns AuthData (success), throws Unauthenticated (treated as no auth), or throws other error (request aborted).
2. Endpoint call: If endpoint requires auth and request not authenticated - reject. If authenticated, auth data passed to endpoint regardless of requirements.

Auth data access: Import getAuthData from ~encore/auth for type-safe resolution. Automatic propagation in internal API calls. Calls to auth-required endpoints fail if original request lacks auth.
</authentication>
<metadata>
Access environment and application information through metadata API from encore.dev package.

appMeta() returns: appId (app name), apiBaseUrl (public API access URL), environment (current running environment), build (version control revision), deploy (deployment ID and timestamp)

currentRequest() returns:
- API call:
interface APICallMeta {
  type: "api-call";
  api: APIDesc;
  method: Method;
  path: string;
  pathAndQuery: string;
  pathParams: Record<string, any>;
  headers: Record<string, string | string[]>;
  parsedPayload?: Record<string, any>;
}

- PubSub:
interface PubSubMessageMeta {
  type: "pubsub-message";
  service: string;
  topic: string;
  subscription: string;
  messageId: string;
  deliveryAttempt: number;
  parsedPayload?: Record<string, any>;
}

Returns undefined if called during service initialization.

Use cases:
import { appMeta } from "encore.dev";

// Cloud-specific behavior
async function audit(userID: string, event: Record<string, any>) {
  const cloud = appMeta().environment.cloud;
  switch (cloud) {
    case "aws": return writeIntoRedshift(userID, event);
    case "gcp": return writeIntoBigQuery(userID, event);
    case "local": return writeIntoFile(userID, event);
    default: throw new Error(`unknown cloud: ${cloud}`);
  }
}

// Environment-specific behavior
switch (appMeta().environment.type) {
  case "test":
  case "development":
    await markEmailVerified(userID);
    break;
  default:
    await sendVerificationEmail(userID);
    break;
}
</metadata>
<middleware>
Reusable code running before/after API requests across multiple endpoints.

Basic usage:
import { middleware } from "encore.dev/api";

export default new Service("myService", {
    middlewares: [
        middleware({ target: { auth: true } }, async (req, next) => {
            // Pre-handler logic
            const resp = await next(req);
            // Post-handler logic
            return resp
        })
    ]
});

Request access types:
- Typed API: req.requestMeta
- Streaming: req.requestMeta, req.stream
- Raw: req.rawRequest, req.rawResponse

Response handling (HandlerResponse object):
resp.header.set(key, value)
resp.header.add(key, value)

Ordering (executes in order of definition):
export default new Service("myService", {
    middlewares: [
        first,
        second,
        third
    ],
});

Targeting: Use target option instead of runtime filtering for better performance. Defaults to all endpoints if target not specified.
</middleware>
<orm_integration>
Built-in support for ORMs and migration frameworks through named databases and SQL migration files.
Requirements: ORM must support standard SQL driver connections. Migration framework must generate standard SQL migration files.

Database connection:
import { SQLDatabase } from "encore.dev/storage/sqldb";

const SiteDB = new SQLDatabase("siteDB", {
  migrations: "./migrations",
});

const connStr = SiteDB.connectionString;
</orm_integration>
<drizzle_integration>
Database setup (database.ts):
import { api } from "encore.dev/api";
import { SQLDatabase } from "encore.dev/storage/sqldb";
import { drizzle } from "drizzle-orm/node-postgres";
import { users } from "./schema";

const db = new SQLDatabase("test", {
  migrations: {
    path: "migrations",
    source: "drizzle",
  },
});

const orm = drizzle(db.connectionString);
await orm.select().from(users);

Drizzle config (drizzle.config.ts):
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: 'migrations',
  schema: 'schema.ts',
  dialect: 'postgresql',
});

Schema (schema.ts):
import * as p from "drizzle-orm/pg-core";

export const users = p.pgTable("users", {
  id: p.serial().primaryKey(),
  name: p.text(),
  email: p.text().unique(),
});

Generate migrations: drizzle-kit generate (run in directory containing drizzle.config.ts)
Migrations automatically applied during Encore application runtime.
</drizzle_integration>
<cors>
CORS controls which website origins can access your API. Scope: Browser requests to resources on different origins (scheme, domain, port).

Configuration in encore.app under global_cors key:
- debug: boolean, enables CORS debug logging
- allow_headers: string[], additional accepted headers ("*" for all)
- expose_headers: string[], additional exposed headers ("*" for all)
- allow_origins_without_credentials: string[], allowed origins for non-credentialed requests (default: ["*"])
- allow_origins_with_credentials: string[], allowed origins for credentialed requests (supports wildcards: https://*.example.com, https://*-myapp.example.com)

Defaults: Allows unauthenticated requests from all origins, disallows authenticated requests from other origins, all origins allowed in local development.

Header handling: Encore automatically configures headers through static analysis. Additional headers can be configured via allow_headers and expose_headers for custom headers in raw endpoints.
</cors>
<logging>
Built-in structured logging combining free-form messages with type-safe key-value pairs.

import log from "encore.dev/log";

Log levels: error, warn, info, debug, trace

Basic usage:
log.info("log message", {is_subscriber: true})
log.error(err, "something went terribly wrong!")

With context (group logs with shared key-value pairs):
const logger = log.with({is_subscriber: true})
logger.info("user logged in", {login_method: "oauth"}) // includes is_subscriber=true
</logging>
<testing>
Encore.ts uses standard TypeScript testing tools. Recommended setup is Vitest.

Setup:
npm install -D vitest

Add to package.json:
{
  "scripts": {
    "test": "vitest"
  }
}

Running tests:
- encore test: Recommended - sets up test databases automatically, provides isolated infrastructure per test, handles service dependencies
- npm test: Direct execution without infrastructure setup

Test an API endpoint:
import { describe, it, expect } from "vitest";
import { hello } from "./api";

describe("hello endpoint", () => {
  it("returns a greeting", async () => {
    const response = await hello();
    expect(response.message).toBe("Hello, World!");
  });
});

Test with request parameters:
import { describe, it, expect } from "vitest";
import { getUser } from "./api";

describe("getUser endpoint", () => {
  it("returns the user by ID", async () => {
    const user = await getUser({ id: "123" });
    expect(user.id).toBe("123");
    expect(user.name).toBeDefined();
  });
});

Test database operations (Encore provides isolated test databases):
import { describe, it, expect, beforeEach } from "vitest";
import { createUser, getUser, db } from "./user";

describe("user operations", () => {
  beforeEach(async () => {
    await db.exec`DELETE FROM users`;
  });

  it("creates and retrieves a user", async () => {
    const created = await createUser({ email: "test@example.com", name: "Test" });
    const retrieved = await getUser({ id: created.id });
    expect(retrieved.email).toBe("test@example.com");
  });
});

Test error cases:
import { describe, it, expect } from "vitest";
import { getUser } from "./api";
import { APIError } from "encore.dev/api";

describe("error handling", () => {
  it("throws NotFound for missing user", async () => {
    await expect(getUser({ id: "nonexistent" }))
      .rejects
      .toThrow("user not found");
  });

  it("throws with correct error code", async () => {
    try {
      await getUser({ id: "nonexistent" });
    } catch (error) {
      expect(error).toBeInstanceOf(APIError);
      expect((error as APIError).code).toBe("not_found");
    }
  });
});

Test Pub/Sub:
import { describe, it, expect } from "vitest";
import { orderCreated } from "./events";

describe("pub/sub", () => {
  it("publishes order created event", async () => {
    const messageId = await orderCreated.publish({
      orderId: "order-123",
      userId: "user-456",
      total: 9999,
    });
    expect(messageId).toBeDefined();
  });
});

Test Cron Jobs (test the underlying function, not the cron schedule):
import { describe, it, expect } from "vitest";
import { cleanupExpiredSessions } from "./cleanup";

describe("cleanup job", () => {
  it("removes expired sessions", async () => {
    await createExpiredSession();
    await cleanupExpiredSessions();
    const remaining = await countSessions();
    expect(remaining).toBe(0);
  });
});

Vitest configuration (vitest.config.ts):
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});

Guidelines:
- Use `encore test` to run tests with infrastructure setup
- Each test file gets an isolated database transaction (rolled back after)
- Test API endpoints by calling them directly as functions
- Service-to-service calls work normally in tests
- Mock external dependencies (third-party APIs, email services)
- Don't mock Encore infrastructure (databases, Pub/Sub) - use the real thing
</testing>
<example_apps>
- Hello World: https://github.com/encoredev/examples/tree/main/ts/hello-world
- URL Shortener: https://github.com/encoredev/examples/tree/main/ts/url-shortener
- Uptime Monitor: https://github.com/encoredev/examples/tree/main/ts/uptime
</example_apps>
<package_management>
Default: Use a single root-level package.json file (monorepo approach) for Encore.ts projects including frontend dependencies.
Alternative: Separate package.json files in sub-packages, but Encore.ts application must use one package with a single package.json file, and other separate packages must be pre-transpiled to JavaScript.
</package_management>
</encore_ts_domain_knowledge>
<encore_cli_reference>
Execution:
- encore run [--debug] [--watch=true] [flags]: Runs your application
- encore test [flags]: Run tests with infrastructure setup (sets up test databases, provides isolated infrastructure per test)

App management:
- encore app clone [app-id] [directory]: Clone an Encore app
- encore app create [name]: Create a new Encore app
- encore app init [name]: Create new app from existing repository
- encore app link [app-id]: Link app with server

Authentication:
- encore auth login: Log in to Encore
- encore auth logout: Log out current user
- encore auth signup: Create new account
- encore auth whoami: Show current user

Daemon:
- encore daemon: Restart daemon for unexpected behavior
- encore daemon env: Output environment information

Database:
- encore db shell database-name [--env=name]: Connect via psql shell (--write, --admin, --superuser flags available)
- encore db conn-uri database-name [--env=name]: Output connection string
- encore db proxy [--env=name]: Set up local database connection proxy
- encore db reset [service-names...]: Reset specified service databases

Code generation:
- encore gen client [app-id] [--env=name] [--lang=lang]: Generate API client (languages: go, typescript, javascript, openapi)

Logging:
- encore logs [--env=prod] [--json]: Stream application logs

Kubernetes:
- encore k8s configure --env=ENV_NAME: Update kubectl config for environment

Secrets:
- encore secret set --type types secret-name: Set secret value (types: production, development, preview, local)
- encore secret list [keys...]: List secrets
- encore secret archive id: Archive secret value
- encore secret unarchive id: Unarchive secret value

Version:
- encore version: Report current version
- encore version update: Check and apply updates

VPN:
- encore vpn start: Set up secure connection to private environments
- encore vpn status: Check VPN connection status
- encore vpn stop: Stop VPN connection

Build:
- encore build docker: Build portable Docker image (--base string: Define base image, --push: Push to remote repository)
</encore_cli_reference>

## Test-Pflicht vor jedem Push

**Tests müssen vor jedem `git push` erfolgreich durchlaufen.** Kein Push ohne grüne Tests.

Ausnahme: Betrifft ein Push **ausschließlich Markdown-Dateien** (Doku, Pläne, `*.md`) und/oder die **Webseite** (`docs/index.html` und `docs/assets/`), ist kein Testlauf erforderlich — die Seite ist statisch und kein Test berührt sie. Sobald auch nur eine Code-, Konfigurations- oder Migrationsdatei geändert ist, gilt die Test-Pflicht uneingeschränkt.

Befehl:
```bash
npm run test
```

Erwartet: `Test Files X passed`, `Tests Y passed`, kein `failed`.

### Sandbox-Setup (bei jeder frischen Session prüfen)

Die Sandbox nutzt PostgreSQL 16 mit pgvector. Docker ist **nicht** verfügbar.

> **Nicht als gegeben annehmen:** In einer frischen Remote-Session (claude.ai/code)
> ist der Container jedes Mal neu aufgesetzt. `node_modules/`, das
> `postgres`-Passwort und die pgvector-Extension waren dabei schon mehrfach
> **nicht** vorhanden, obwohl sie es in einer früheren Session waren. Vor dem
> ersten Testlauf explizit prüfen statt davon auszugehen — die Befehle unten
> sind idempotent und schaden nicht, falls doch schon alles da ist.

```bash
# PostgreSQL starten (falls nicht bereits aktiv)
pg_ctlcluster 16 main start

# Prüfen ob bereit
pg_isready -h localhost -p 5432 -U postgres

# node_modules vorhanden? (Root UND frontend/ — der pre-commit-Hook
# braucht @vue/compiler-sfc aus frontend/node_modules)
ls node_modules/.bin/vitest frontend/node_modules 2>&1

# Falls nicht vorhanden:
npm install
(cd frontend && npm install)

# pgvector-Extension installiert? (nicht nur das Postgres-Paket selbst)
ls /usr/share/postgresql/16/extension/ | grep -i vector

# Falls nicht vorhanden:
apt-get install -y postgresql-16-pgvector

# postgres-Passwort setzen, falls der Testlauf mit
# "password authentication failed" (Code 28P01) abbricht:
su postgres -c "psql -c \"ALTER USER postgres WITH PASSWORD 'postgres';\""
```

Der Testlauf (`npm run test`) erstellt die `encore_test`-Datenbank automatisch, führt alle Migrationen aus und räumt danach auf.

### Drizzle-Migrationsdateien

Bei Umbenennung oder Neuerstellung von Migrationsdateien muss **immer** auch `db/migrations/postgres/meta/_journal.json` aktualisiert werden. Fehlende Einträge im Journal führen dazu, dass Drizzle die Migrationen überspringt und die CI-Tests schlagen fehl.

### Storybook-Screenshots (Layout-Verifikation)

UI-Komponenten lassen sich über Storybook verifizieren:

```bash
cd frontend
npm run storybook        # interaktiv unter http://localhost:6006
npm run screenshot       # Vollbild-Screenshots aller Stories → frontend/screenshots/
```

`npm run screenshot` (test-runner) benötigt einen Playwright-Chromium. **In Web-Sessions** schlägt der Browser-Download fehl, wenn die Netzwerk-Policy der Umgebung den Playwright-CDN nicht erlaubt:

```
Error: Download failed: server returned code 403 body 'Host not in allowlist'.
URL: https://cdn.playwright.dev/builds/...
```

Damit der Screenshot-Lauf in Web-Sessions funktioniert, muss **`cdn.playwright.dev`** in der Allowlist der Environment-Netzwerk-Policy stehen (alternativ eine Policy mit weiterem/„trusted"-Zugriff wählen). Konfiguriert wird das beim Anlegen der Umgebung in der Claude-Code-Web-UI; siehe https://code.claude.com/docs/en/claude-code-on-the-web. Ohne diesen Host bleibt nur die interaktive Variante bzw. die Ausführung lokal/in CI.

Orientierungsabhängige Layouts (z. B. der Fullscreen-Split) können pro Story über den `testViewport`-Parameter (`.storybook/test-runner.ts`) eine feste Viewport-Größe erzwingen, damit Portrait/Landscape im Screenshot korrekt erscheinen.

## Seitenskelett im Frontend (`PageLayout`)

Jede View unter `frontend/src/views/` baut ihre Seite mit
`components/layout/PageLayout.vue` (Issue #1272, Konzept in
`documentation/plans/web-ui-vereinheitlichung.md`). Die View liefert `title` (wird
einziger `<h1>` und `document.title` im Format `Seite · Modul · F4mil`),
optional `hint`, `scroll="page|fill"`, `width="normal|wide|full"`,
`sticky-header` und `ready`, und füllt die Slots `actions`, `toolbar`,
`notice`, `selection` und den Inhalt. `toolbar`, `notice` und `selection`
hebt `PageLayout` in den einen Sticky-Stack der App (`#module-subheaders` in
`App.vue`), mit `sticky-header` auch die Titelzeile samt `#actions`.

Regeln:

- Das Dokument ist der einzige Scroller der Seite (Issue #1674): iOS scrollt
  beim Tippen auf die Statusleiste nur dann nach oben. Keine View legt einen
  eigenen Scroller um ihren Hauptinhalt. Virtuelle Raster nehmen
  `usePageVirtualizer` (Fenster-Virtualizer, `scrollMargin` und
  Stack-Höhe eingerechnet). `scroll="fill"` ist nur für Inhalte ohne Länge
  (Karte): genau ein Viewport unter dem Stack, nichts scrollt darin.
- Ausnahme: die großen Foto-Raster (Galerie, Fotos einer Person, geteiltes
  Album) scrollen in ihrem eigenen Kasten — `scroll="fill"` an `PageLayout`,
  das Raster gibt `usePageVirtualizer` sein Element als dritten Parameter.
  Mit zehntausenden Fotos wurde das Dokument Millionen Pixel hoch, und ein
  Sprung ans andere Ende (oder ein Tipp auf die Statusleiste) trieb Safaris
  GPU-Prozess über sein Limit, die Seite stürzte ab (ab etwa 6000 Fotos).
  Der Tipp auf die Statusleiste wirkt dort nicht; „Zum ältesten“ ist der Weg
  nach oben. Ein neues Raster, das so groß werden kann, macht es genauso.
- Eine Spalte neben der Liste, die stehen bleibt (Fotodetails neben dem
  Raster, Vorschau neben der Dokumentliste, PDF neben den Attributen),
  trägt die globale Klasse `.page-aside` (`.page-aside--fill` für volle
  Höhe, Abstand über `--page-aside-inset`); eine Leiste am unteren Rand
  (Eingabe des Assistenten) `.page-dock`. Beide stehen in `style.css`.
- Detailseiten setzen `sticky-header`, damit Menü und Zeile mit dem
  Zurück-Knopf beim Scrollen stehen bleiben.
- Keine View definiert eigenes Header-/Toolbar-Layout, `position: sticky`
  oder `top:`-Offsets. Die Stack-Höhe liefert `--app-stack-height`
  (von `App.vue` gemessen, auch auf `<html>`). Was der Browser auf der
  Seite in den Blick scrollt, hält per `scroll-margin-top` auf
  `#app .content *` Abstand zum Stack — nie `scroll-padding-top` auf
  `<html>`: das galt auch für Menüs direkt unter dem Stack, deren Fokus die
  Seite dann um die Stack-Höhe verschob. `--menubar-height` gibt es nicht
  mehr.
- Virtuelle Raster scrollen mit `scrollToRow` aus `usePageVirtualizer`
  (ein einziges `scrollTo` auf Fenster oder Kasten), nie mit `scrollToIndex` der Bibliothek:
  das steuert bis zu fünf Sekunden nach und zog auf dem iPhone die Seite
  nach einem Tipp auf die Statusleiste zurück.
- Die Seite scrollt nie horizontal (`overflow-x: clip` auf `body`). Breite
  Inhalte (Tabellen, Streifen) gehören in `components/layout/ScrollX.vue`.
- Abstände aus `--space-1` … `--space-6`, Seitenränder aus `--page-gutter`.
  Keine View legt einen zweiten Seitenrand darüber: Listen und Raster
  beginnen am Gutter, damit Fotos, Alben, Personen und Dokumente auf
  derselben Kante stehen. Innenabstand der virtuellen Raster (`6px`) gehört
  in die Grid-Komponente, nicht in die View.
- Der Storybook-Test-Runner prüft jede Story bei 360px Breite auf
  Elemente, die ohne eigenen horizontalen Scroller über den Rand ragen
  (`src/utils/overflowCheck.ts`). Eine Story einer noch nicht migrierten
  View darf mit `parameters: { overflowCheck: false }` und Begründung
  aussetzen.

## Breakpoints im Frontend (`useBreakpoint`)

Die Breiten, an denen die App ihr Layout ändert, stehen in
`composables/useBreakpoint.ts` (Issue #1281): `xs` 480, `sm` 640, `md` 768,
`lg` 1024, `xl` 1280. Jede Zahl ist die erste Breite des *größeren* Layouts,
das Paar heißt also `(max-width: 767px)` / `(min-width: 768px)` — nie
`max-width: 768px`, das beide Seiten für sich beanspruchte.

- Im Skript nie `window.matchMedia` von Hand: `useMediaQuery(query)`,
  `useAtLeast(name)` oder `useBelow(name)`. Die bauen die Abfrage aus
  denselben Zahlen und räumen ihren Listener selbst ab.
- In CSS muss die Zahl wiederholt werden (eine Media Query liest keine
  Custom Property) — dann `from()`/`upTo()` als Vorlage nehmen, die Liste
  steht als Kommentar in `style.css`.
- Eine Schwelle, die nur eine Komponente betrifft (eine Tabelle, die 560px
  pro Spalte braucht), bleibt eine Zahl in dieser Komponente. Die fünf Namen
  gehören der Seite.

## Knöpfe im Frontend

Ein Knopf, der nur ein Icon zeigt, braucht ein `aria-label` (oder ein
`v-tooltip`, das PrimeVue ebenfalls an Hilfstechnik weitergibt) — sonst
liest ein Screenreader „Schaltfläche" vor und sonst nichts (Issue #1281).
Das Label benennt die Aktion, nicht das Piktogramm: „Rolle entziehen", nicht
„Kreuz". Bei einem Umschalter hängt es am Zustand:
`:aria-label="hidden ? 'Wieder einblenden' : 'Ausblenden'"`.

`scripts/check-button-labels.mjs` prüft das, im pre-commit-Hook über die
gestageten `.vue`-Dateien. Ausgenommen ist nur, was in einem
`aria-hidden`-Teilbaum liegt (die Messzeile in `ResponsiveToolbar`).

## Dialoge im Frontend

Ein Dialog ist PrimeVues `Dialog` (oder `ConfirmDialog`), nie ein eigenes
Modal, und er hat genau eine von drei Breiten (Issue #1281) — als Klasse,
nicht als `:style`:

- `dialog-sm` (420px) — Bestätigung, ein Feld
- `dialog-md` (640px) — Formular
- `dialog-lg` (960px) — Vorschau, Tabelle

Die Klassen deckeln die Breite selbst am Viewport minus Seitenrand, also
braucht kein Dialog ein eigenes `maxWidth` oder ein `breakpoints`-Prop.
Unter `sm` nimmt ein Dialog die ganze Breite und höchstens `90dvh` — auf
360px gibt es kein „neben der Seite". Eine Ausnahme ist der Fotoeditor: der
ist absichtlich Vollbild und gehört zu keiner der drei Größen.

Wer die Seite überdeckt, schuldet der Tastatur dreierlei (Issue #1281):
beim Öffnen wandert der Fokus hinein, Tab und Umschalt+Tab laufen darin im
Kreis, und beim Schließen kehrt der Fokus dorthin zurück, von wo aus
geöffnet wurde. PrimeVues `Dialog` erledigt das selbst. Ein handgebautes
Overlay nimmt `useFocusTrap(container, active, { onEscape })` aus
`composables/useFocusTrap.ts` und trägt `role="dialog"`, `aria-modal="true"`,
ein `aria-label` und `tabindex="-1"`. Wer Escape schon selbst behandelt (das
Vollbild, der Fotovergleich), lässt `onEscape` weg. Ein Bereich, der nur
unterhalb eines Breakpoints modal ist (die Bottom-Sheets), gibt ein `active`
mit, das genau dann wahr ist — darüber wäre die Falle ein Käfig.

Fußzeile: links Sekundär/Abbrechen, rechts Primär. Eine destruktive Aktion
steht ganz links, durch einen Spacer von dem Paar getrennt, und fragt über
`ConfirmDialog` nach, wobei benannt wird, was gelöscht wird.

## Detailseiten im Frontend

Jede Detailseite beginnt ihren `#actions`-Slot mit demselben Ausgang:
`<Button icon="pi pi-arrow-left" text rounded aria-label="Zurück" />`, der
`goBack` aus `useModuleBack(basePath, fallbackRouteName)` aufruft — History,
wenn die vorige Seite im selben Modul lag oder eine Seite war, die Objekte
aller Module öffnet (der Assistent, die Sammelmappen; Liste
`CROSS_MODULE_ORIGINS` im Composable), sonst die Liste des Moduls.
Danach kommen Vor/Zurück durch den Basket (wo es einen gibt) und erst dann
die Aktionen der Seite. Die Seite setzt `sticky-header` an `PageLayout`, so
bleibt diese Zeile im Sticky-Stack stehen, während der Inhalt scrollt
(Issue #1674).

## Zurück-Navigation im Frontend (`listAnchor`, `scrollMemory`)

Wo der Nutzer war, merkt sich die App an einer Stelle (Issue #1279):

- Eine Liste speichert beim Öffnen eines Eintrags
  `saveListAnchor(ANCHOR_KEY, { kind, id })` aus `utils/listAnchor.ts` und
  gibt `PageLayout` denselben `anchor-key`. Die Zeile trägt
  `:data-anchor="anchorKey(kind, id)"` und die Klasse `scroll-anchor`
  (liefert `scroll-margin-top` unter dem Sticky-Stack und den Fokusring).
- `PageLayout` stellt wieder her, sobald `ready` wahr ist — also erst, wenn
  die Liste die Höhe hat, die der Offset voraussetzt. Jede Listen-View setzt
  deshalb `:ready`.
- Ohne `resolveAnchor` sucht `PageLayout` die Zeile selbst. Eine View braucht
  `resolveAnchor` nur, wenn sie mehr tut (Hervorheben) oder wenn ein
  virtuelles Raster die Zelle erst erzeugen muss; dann scrollt die View selbst
  und meldet `true`.
- Den Scroll-Offset schreibt der Router beim Verlassen und `PageLayout` stellt
  ihn nur bei Zurück/Vorwärts her. Keine View ruft `useScrollRestore` —
  das Composable gibt es nicht mehr.

## Listen im Frontend (`ListToolbar`)

Jede Listen-View legt `components/layout/ListToolbar.vue` in den
`#toolbar`-Slot von `PageLayout` (Issue #1278). Die View baut das Modell mit
`useListToolbar()` aus `composables/useListToolbar.ts` und füllt nur, was sie
hat: `search`, `filter`, `sort`, `view`, `result`, `selection`.

Regeln:

- Suchbegriff, Filter, Sortierung und Ansicht leben in `route.query`
  (`q`, die Filter-Keys der Domäne, `sortBy`/`sortDir`, `view`). Ein Reload
  oder ein geteilter Link zeigt dieselbe Liste. `localStorage`/`sessionStorage`
  nur als „zuletzt verwendet", wenn die Liste ohne Query betreten wird.
- Die Suche kommt aus `useListSearch()`: `value` hängt am Eingabefeld, `term`
  ist der entprellte Wert in der URL. Geladen wird immer mit `term`.
- Jede View definiert ihre Chips selbst (`usePhotoFilterChips`,
  `useDocumentFilterChips` oder ein eigenes `computed<FilterChip[]>`). Die
  Zahl der Chips und der Zähler am Filter-Knopf müssen übereinstimmen.
- Kein eigenes Suchfeld, kein eigenes Sortiermenü, keine eigene Ergebniszahl
  mehr in einer View. Die Toolbar rendert das Sortiermenü aus `sort.fields`.
- Bleibt der Filter als Panel offen (Transaktionsliste), reicht die View
  `filter.expanded` mit — der Knopf ist dann ein Schalter und sieht
  eingeschaltet aus (gefüllt statt umrandet, `aria-expanded`). Wer ein
  Overlay-Menü öffnet, lässt es weg: das Menü sagt es selbst.
- Leere Liste, erster Ladevorgang und Ladefehler laufen über
  `EmptyState`, `PageSkeleton` und `ErrorBanner` aus `components/layout/`.
  Ladefehler gehören in den `#notice`-Slot, nie in einen Toast.
- Tastatur überall gleich: `/` fokussiert die Suche, `Esc` im Suchfeld leert
  sie, `Esc` außerhalb beendet den Auswahlmodus.

## Auswahl und Basket im Frontend (`useListSelection`, `SelectionBar`)

Mehrfachauswahl funktioniert in jeder Liste gleich (Issue #1280):

- Die View holt sich `useListSelection({ loadedIds, total?, loadEntryAt?,
  fetchAllIds? })` aus `composables/useListSelection.ts` und reicht
  `selection: { active: selectMode, toggle: toggleMode }` an `useListToolbar`.
  Damit zeigt die Toolbar den „Auswählen"-Knopf und `Esc` beendet den Modus.
- Die Zeile `components/layout/SelectionBar.vue` gehört in den
  `#selection`-Slot von `PageLayout`, `v-if="selectMode"`. Keine View baut
  eigene Auswahlzeilen mehr. Aktionen kommen als `ToolbarItem[]`; was die View
  sonst sagen will (Summe) gehört in `#info`, ihre Hauptaktion in `#primary`.
- Den Modus zu verlassen leert die Auswahl — nie den Basket. Die Auswahl ist,
  worauf der Nutzer gerade zeigt; der Basket ist, was er beiseitegelegt hat.
- Es gibt **einen** Basket pro Nutzer, für alle Typen, auf dem Server
  (#1548): `stores/basket.ts`. Fotos, Dokumente, Buchungen, Wertpapiere und
  Zähler landen im selben Haufen. Die Stores von Finanzen und Dokumenten
  halten nur die ganzen Objekte für ihre Drawer und spiegeln den Basket über
  `useBasketMirror` — nie einen eigenen Basket neben dem gemeinsamen bauen.
- Eine Sammelmappe öffnet sich, wo sie hingehört
  (`utils/collectionRoute.ts`): typisiert in der Liste ihres Moduls mit
  `?collection=<id>`, gemischt unter `/sammelmappen/:id`. Jede Modulliste
  versteht `collection` als Filter mit Chip „Sammelmappe: …“; das Backend
  baut die Bedingung mit `collectionScopeCondition` aus `collections/scope.ts`.
- Eine Sammelmappe sieht in jeder Liste gleich aus und kann dort dasselbe:
  `components/collections/CollectionTile.vue` (Typ-Symbol, Name, Inhalt,
  Tags, Stern und „⋮“) mit dem Menü und den Dialogen aus
  `CollectionActions.vue`; als Raster samt Menü `CollectionTiles.vue`. Die
  Daten kommen aus `GET /collections` (`CollectionSummary`). Keine Liste baut
  eine eigene Mappen-Kachel oder ein eigenes Mappen-Menü daneben.
- Eine gemischte Mappe hat **ein** Aktionsmenü: erst was für alles gilt,
  dann die Stapelaktionen je Typ mit Typ und Anzahl im Text
  (`groupedSelectionActions` in `utils/collectionActions.ts`). Eine neue
  Stapelaktion eines Moduls, die nur IDs braucht, gehört auch in den
  Katalog von `CollectionDetailView`.
- Eine Liste mit Filter bietet „Als Regel-Mappe“, wenn ihr Typ Regeln kennt
  (Fotos, Buchungen); die Regel ist der Filter der Liste
  (`components/collections/SaveRuleDialog.vue`, `collections/rules.ts`).
- Basket und Sammelmappe erreicht man über **eine** Aktion „Ablegen“
  (Icon `pi-file-import`, grün (`severity="success"`), solange das Ding
  im Basket liegt; das Icon steht in der App für nichts anderes): ein Dialog (`components/collections/AddToCollectionDialog.vue`)
  mit dem Basket zuoberst, den passenden Mappen und „Neue Sammelmappe“; für
  ein einzelnes Ding hakt er an, wo es schon liegt. Jede Detailseite trägt
  `components/collections/FileButton.vue` oben in `#actions` neben ihren
  anderen Aktionen, jede Auswahlleiste genau eine Aktion „Ablegen“, Zeilen
  und Kacheln öffnen denselben Dialog. Nie zwei Knöpfe „In den Basket“ und
  „In Sammelmappe“ nebeneinander, und keine Karte „Sammelmappen“ auf einer
  Detailseite. Ein Modul, das ganze Objekte hält (Buchungen, Dokumente),
  reicht dem Dialog `basket: { add, remove }` mit. Eine neue Liste oder
  Detailseite bekommt „Ablegen“ gleich mit.
- Exportieren geht für jede Mappe und den Basket über
  `components/collections/ExportDialog.vue` (Endpunkte in
  `collections/exports.ts`). Ein neuer Typ bekommt einen Exporter in
  `collections/exporters.ts` und seinen Teil der Optionen in
  `export-options.ts`; was nicht in die Datei kommt, steht mit Grund im
  Inhaltsverzeichnis, nie still weggelassen. Weitergegeben wird ein fertiger
  Export über `ExportSendPanel.vue` (Teilen-Menü, E-Mail vom Server,
  Download-Link). Absender ist die App-Adresse, Antworten gehen an den
  Nutzer; die eigene Adresse ist per Umschalter die Alternative, aber nur,
  wenn sie dieselbe Domain hat wie die App-Adresse (`mayUseOwnSender` in
  `user/mail.ts`, `mailSender` in `collections/sending.ts`, Umschalter
  `ExportSenderField.vue`, auch im Zeitplan). Der Absender steht im Formular
  und im Protokoll `collection_sends`. Der Dialog hat drei Reiter
  (Zusammenstellen, Verlauf, Regelmäßig); nach „Datei erstellen“ zeigt der
  erste statt des Formulars das Ergebnis und darunter „Weitergeben“: Speichern,
  Teilen, E-Mail und Link kopieren gleichrangig in einer Zeile. Zeitpläne (`collections/schedules.ts`) laufen als der,
  der sie angelegt hat, mit seinen Rechten zur Laufzeit; der Basket hat keine.
- `Ctrl/Cmd+A` wählt alles (das Composable bindet es selbst),
  Umschalt+Klick den Bereich, `Esc` beendet.
- Der Basket-Knopf mit Schublade ist `components/BasketIndicator.vue`; sein
  Badge zählt alles im Basket. Er ist im Hauptmenü zugleich der Weg zu den
  Sammelmappen („Alle Sammelmappen“ oben in der Schublade) — kein eigener
  Mappen-Knopf daneben. Gezeigt wird er nur, wer mindestens einen Typ nutzen
  darf, der in Mappen kommt (wie `mayUseType` in `collections/members.ts`).
- Das Zahnrad im Hauptmenü gibt es in jedem Modul: oben die Einstellungen
  des Moduls (nach Rechten gefiltert), darunter immer „Mein Profil“. Jeder Drawer zeigt den ganzen Basket nach Typ
  gruppiert (`components/collections/BasketMemberList.vue`) und endet mit
  `BasketFooter` („Leeren“, „Als Sammelmappe speichern“). Module ohne
  Stapelaktionen zeigen `SharedBasketIndicator`. Dokumente und Finanzen
  zeichnen ihre eigenen Zeilen über den Slot `rows-<typ>`, stellen ihre
  Gruppe nach oben (`first`) und setzen ihre Stapelaktionen über den Fuß,
  beschriftet für ihre Art. Optional `#before-rows` und `#subtitle`. Durch
  den Basket blättert `composables/useBasketNavigation.ts`.

## Aktionen an Spots in der iOS-App

Was man mit einem Spot tun kann, ist überall dasselbe, wo der Spot in
vergleichbarer Weise gezeigt wird: Zeile in der Liste (Menü, langes
Drücken, Wischgesten), Detailansicht, Pin-Sheet auf der Karte und die
Detailansicht hinter „Alle Details“. Niemand soll sich wundern, dass eine
Aktion nur über einen bestimmten Weg erreichbar ist. Was die Karte kann,
kann die Liste auch, und umgekehrt.

- Die Aktionen entstehen an **einer** Stelle je Art von Spot:
  `stopActions(_:later:)` in `TripPlanDayView` für eingeplante Stopps,
  `candidateActions(_:later:)` in `TripPoolView` für Kandidaten. Beide
  liefern `[TripPinSheetAction]`; gezeichnet wird mit
  `TripSpotActionMenuItems` (Menü) oder `TripSpotActionSections`
  (Pin-Sheet, Detailansicht). Keine Oberfläche baut eigene Knöpfe daneben.
- Unterschiede kommen nur aus dem **Zustand** des Spots, nie aus dem Weg
  dorthin: „Erledigt“ nur solange offen, „In einen anderen Block“ nicht für
  Erledigtes, „Zurück zu den Kandidaten“ nur für eingeplante, „Einplanen“ nur
  für Kandidaten.
- Ausgenommen ist, was die Oberfläche selbst schon zeigt: Detailansicht und
  Pin-Sheet haben eigene Knöpfe für Karte und Route und blenden die Gruppe
  `.navigate` aus; nur die Liste klappt „Warum hier?“ an Ort und Stelle auf, weil
  Detailansicht und Pin-Sheet die Gründe ohnehin zeigen.
- Beim Code-Review wird das geprüft: Eine neue Aktion an einer Stelle ist
  eine neue Aktion an allen.

## Date-only values in the frontend

For date-only values (no time component), always use the helpers from `frontend/src/utils/dateFormat.ts`:

- `toLocalIsoDate(d: Date)` → `"YYYY-MM-DD"` (extracts local date, no UTC shift)
- `parseLocalDate(s: string)` → `Date` (parses as local midnight)

**Never** use:
- `d.toISOString().slice(0, 10)` — shifts the date for timezones east of UTC
- `new Date("YYYY-MM-DD")` — parses as UTC midnight, may display the previous day locally

## Language for everything written into GitHub

Git commit messages, pull-request descriptions (title and body), **issue titles and bodies, and every issue or PR comment** must always be written in English, regardless of what language the conversation with the user is in. This includes review comments, replies on review threads and edits to an existing issue body.

The conversation with the user stays in whatever language the user is using — only what lands in the repository or on GitHub is English.

## Aktive Feature-Pläne

- **Steuerrelevanz als Rolle** (`tax_role` = `beleg` / `bezug` / `keine` statt eines Booleans; `tax_relevant` bleibt und ist aus der Rolle abgeleitet; das Modell nennt die Rolle, die Beleg-Matrix `TAX_EVIDENCE` in `documents/tax-sections.ts` entscheidet je Sektion aus der Dokumentart, ob ein `beleg` steht — nur Abstufung, nie Aufwertung; die Schulbescheinigung ist nie Beleg, die fordert die Familienkasse an, nicht das Finanzamt; die Textregeln in `tax-rules.ts` sprechen in Rollen, ein „Bezug“ behält seine Sektionen; die Erträgnisaufstellung ist nie Beleg; `learned-rules.ts` lernt die Rolle je Absender **und** Dokumentart aus `tax_reviewed`-Dokumenten und wendet sie zuletzt an; beide Rollen sichtbar in Detailseite, Liste, Vorschau, Filter `taxRole` und Stapeldialog, Beschriftung in `frontend/src/utils/taxRole.ts`): `documentation/plans/steuer-belegrolle.md` (Plan auf Englisch), Issue #1613. **Alle vier Etappen umgesetzt** (Etappe 4: `cloud_audit.py` fragt `tax_role` ab und meldet die 3×3-Rollen-Konfusion, `model_scoreboard.py` bewertet die Rolle neben dem Boolean). Ein neuer Fall „betrifft den Sachverhalt, ist aber kein Beleg“ ist eine Zeile in der Matrix, keine neue Regelfunktion.
- **Ausfüllhilfe nach Kennzahlen** (jeder Beleg wird bei der Einordnung als `beleg` auf die Werte ausgelesen, die das Formular verlangt — Belegart bestimmen, dann deren Felder lesen, jede Zahl im Text verankert und auf Plausibilität geprüft; Werte je Person bei Zusammenveranlagung über `subject_persons.relation_kind`; Zuordnung zu Zeile und Kennzahl des Jahres mit dem Steuerrecht dort, wo es nötig ist, z. B. § 35a nur Arbeitskosten; Ausfüllhilfe und PDF als Liste nach Kennzahlen für die Eingabe in ELSTER mit Herkunft jedes Werts; Formularkatalog je Jahr als Daten, Kennzahl `null`, solange nicht am amtlichen Vordruck geprüft): `documentation/plans/steuer-ausfuellhilfe.md` (Plan auf Englisch). Etappe 0 umgesetzt: die Ausfüllhilfe nennt keine Beträge mehr aus der Kassenbon-Regel (`extractReceiptAmount` gilt nur für Kassenbons, nie für Steuerbelege). Etappe 1 umgesetzt ohne Kennzahlen: Katalog `documents/tax-forms/` (eine Datei je Jahr, `line`/`kennzahl` erst mit `source` aus dem amtlichen Vordruck, ein Test verweigert eine Kennzahl ohne Quelle), Belegarten `documents/tax-evidence-kinds.ts`, Beträge und Verankerung `documents/tax-amounts.ts`, Zuordnung mit Steuerrecht `documents/tax-form-mapping.ts`. Etappe 2 umgesetzt: Queue-Dienst `tax_values` (`documents/tax-values.ts`) nach classify und nach manueller Steuer-Änderung, Werte in `document_tax_value` (Status `read`/`rejected`/`confirmed`/`corrected`, eine neue Lesung lässt bestätigte und korrigierte stehen), gelesene Belegart in `document_tax_reading`, Person aus den Bezugspersonen des Dokuments, nie vom Modell; Backfill `POST /documents/tax-values/backfill` in `tax-values-api.ts`. Kennzahlen 2025 am amtlichen Vordruck geprüft (FMS formulare-bfinv.de, Ausgabe 2025/4.1.1.0): `kennzahlSpouse` für Vordrucke mit beiden Ehegatten nebeneinander (Vorsorgeaufwand 300er/400er), `formNote` für Hinweise des Vordrucks; Anlage V hat 2025 keine Kennzahlen. Etappe 3 umgesetzt: `GET /documents/tax/form-values` in `documents/tax-form-values.ts` (über `mapToForm`, nur sichtbare Dokumente, Zusammenveranlagung, solange ein Ehegatte ohne eigene Erklärung im Haushalt ist), Bestätigen/Korrigieren je Wert über `POST /documents/tax/values/:id/confirm|correct`; die Ausfüllhilfe trägt das als `form`, der Dialog zeigt Anlage → Person → Zeile · Kz → Wert mit Belegen, `tax_worksheet` liest dieselbe Struktur. Etappe 4 umgesetzt: das PDF (`assistant/tax-worksheet-pdf.ts`, Aufbereitung in `kennzahlSheet`) beginnt mit den Werten je Anlage und Person, Zeile · Kz · Bezeichnung · Wert in Vordruck-Reihenfolge, Summen verweisen auf einen Anhang mit jedem Beleg und Betrag. Etappe 5 umgesetzt: Korrekturen desselben Absenders und derselben Belegart (nur eigene Dokumente) gehen als Beispiele ins Lese-Prompt (`correctionExamples` in `documents/tax-values.ts`); neben jedem Wert steht der Vorjahreswert (`previous_cents`), Felder mit Vorjahreswert ohne aktuellen Wert stehen unter `previous.missing`. **Alle Etappen umgesetzt.**
- **Zusammenhang zwischen Dokumenten** (Herkunftsordner mit Backfill über `sha256`, Panel „Verwandte Dokumente“ auf der Detailseite, Referenznummern als eigenes Feld, Akten als Sammelmappen mit Regel, Erkennung und Zusammenführung von Beinahe-Duplikaten aus Neuimporten): `documentation/plans/dokumente-zusammenhang.md` (Plan auf Englisch), Issues #1477–#1481. **Alle fünf Etappen umgesetzt** (#1483, #1484, #1485, #1487, Akten). Regeln: `documents/source-folder.ts`, `related.ts`, `reference-numbers.ts`, `dossiers.ts`, `duplicates.ts`.
- **Foto-Ästhetik** (Q-Align/OneAlign (AVA SRCC 0,82, MIT) bewertet jedes Foto in einem nächtlichen GPU-Batch: eigener `aesthetic-service`, der das Modell nur im Fenster lädt; der llm-service gibt die GPU über eine CPU-Konfiguration desselben Gemma-4-Modells frei und bleibt nutzbar; Fenster `aesthetic.window_start/_end` konfigurierbar, innerhalb automatisch, sobald niemand auf eine Antwort des Modells wartet (Hintergrundarbeit in der `llm`-Queue hält den Start höchstens `BACKGROUND_PATIENCE_MS` auf, ein `error` vom letzten Reload nur, solange kein Modell geladen ist; die letzte Prüfung steht als `last_tick` auf der Einstellungsseite); Score ersetzt `clip_aesthetics` unter demselben Schlüssel, `aesthetic_model` nennt die Version; vorläufiger Score beim Import aus einem MLP-Kopf auf dem ViT-H/14-Vektor; Auto-Pick-Gewichte nur nach Replay in `group-auto-pick.calibration.ts`; Gemma 4 erklärt in Worten, nie die Zahl): `documentation/plans/foto-aesthetik.md` (Plan auf Englisch), Issue #1640. Etappe 1 umgesetzt (`aesthetic-service/`, #1639), Etappe 2 umgesetzt (GPU-Verleih im llm-service: `POST /gpu/lend` lädt den CPU-Zwilling der laufenden Konfiguration ohne zu persistieren, `POST /gpu/return` stellt sie wieder her, `lease` in `/reload/status`; App-seitig `lendLlmGpu`/`returnLlmGpu`/`getLlmGpuLease` in `user/llm-models.ts`; die KI-Benchmark-Seite misst auf Knopfdruck „auf dem CPU-Zwilling“, `device: "cpu"` in `assistant/benchmark.ts`), Etappe 3 umgesetzt (nächtlicher Lauf `photo/aesthetic-nightly.ts` mit eingespeisten Diensten aus `aesthetic-deps.ts`, Takt alle 5 Minuten in `aesthetic-cron.ts`, Fenster und Schalter in `photo_aesthetic_settings` (ab Werk aus), Läufe in `photo_aesthetic_run` mit `gpu_returned`, `photos.aesthetic_model` = `qalign_v1` bzw. `qalign_v1:failed`, Formel und Fenster in `photo/aesthetic-score.ts`, Seite Fotos › Einstellungen › Ästhetik), Etappe 4 umgesetzt (vorläufiger Score: linearer Kopf auf dem CLIP-ViT-H/14-Vektor, gelernt aus den eigenen Q-Align-Werten statt aus AVA, `embedding_service/app/services/aesthetic_head.py`, Endpunkte `/aesthetic-head*`; nur in Gebrauch, wenn er Q-Align besser trifft als die Zero-Shot-Prompts; `aesthetic_model = vith_head_v1`; Training und Übertrag auf alle Fotos ohne Q-Align-Wert in `photo/aesthetic-head.ts` nach jedem Nachtlauf und per „Neu trainieren“); Etappe 5 umgesetzt je Nutzer (Nachspielen der geprüften Gruppen mit Q-Align-Werten in `replayOnGroups` (`photo/group-auto-pick.calibration.ts`), neu gelernte Gewichte an zurückgehaltenen Gruppen gemessen, `qalign_quality` als Technik-Signal über `ScoringWeights.technical`, Übernahme nur mit gemessenem Gewinn, Karte „Auto-Pick nachspielen“; die globalen Standardgewichte bleiben, bis ein Nachspielen sie belegt), Etappe 6 umgesetzt (Bildkritik in Worten: `photo/critique.ts`, `POST /photos/:id/critique`, llm-service `POST /vision/json-prompt`, Tabelle `photo_critique`, Abschnitt „Bildwirkung“ in der Foto-Seitenleiste und „Bilder erklären“ im Auto-Pick-Review), Etappe 7 umgesetzt (persönlicher Geschmack je Nutzer: paarweise logistische Regression auf [Formel, CLIP-Vektor] aus den geprüften Gruppen in `embedding_service/app/services/taste_model.py`, Endpunkte `/taste/replay|train|score` ohne gespeichertes Modell; App-Seite `photo/taste-model.ts`, Modell in `ai_pick_taste_model`, Bonus `taste_bonus` im Auto-Pick nur nach Nachspielen mit gemessenem Gewinn, Karte „Persönlicher Geschmack“). **Alle Etappen umgesetzt.**
- **Foto-Freigabe** (Genehmigungsprozess neu → abgelehnt/intern/öffentlich per Foto, Eingang über Import-Volume, Upload-Links oder Einreichen, globale Rolle „Foto-Genehmiger“, Freigabe-Alben der Organisation, öffentliche Einstiegsseite, Metadaten-Bereinigung bei anonymer Auslieferung; Etappe 0 = serverseitige Zugriffsprüfung pro Foto): `documentation/plans/foto-freigabe.md` (Plan auf Englisch). **Etappe 0 umgesetzt**: Zugriff pro Foto über `accessiblePhotoCondition`/`assertPhotoAccess`, und was eine Person mit einem Foto tut (Bearbeitung, Favorit, Gesichtsname), sehen nur die, die das Foto auf demselben Weg sehen (`coViewerIds` in `photo/photo-file-access.ts`); Etappen 1–8 offen.

- **Freistellungsaufträge und erwartete Kapitalerträge** (Aufträge je Bank mit Besitzer `self`/`spouse`/`joint` gegen den Sparerpauschbetrag des Steuerhaushalts aus `user_subject_persons` und `user_assessment_settings`; Pauschbetrag als Tabelle `finance_saver_allowance` mit Gültigkeit ab Jahr, nie als Zahl im Code; Zinsen aus Kontoauszügen im Dokumentenbestand über Muster plus Modell mit Plausibilitätsprüfung, mit FinTS-Buchungen abgeglichen statt doppelt gezählt; Dividenden und Vorabpauschale aus den Depot-Abrechnungen; Vergleich je Bank und Verteilungsvorschlag; Gegenprobe mit der Jahressteuerbescheinigung aus `document_tax_value`): `documentation/plans/freistellungsauftraege.md` (Plan auf Englisch), Issue #1549. Etappen 1–5 offen.
- **Dokumentenverwaltung** (neues Modul neben Fotos, lokale KI-Klassifikation via llm-service): der Plan lag nur in einer früheren Session außerhalb des Repos und ist nicht erhalten. Wird iterativ in Etappen umgesetzt (DB/Seed → llm-service → documents-Service → Watcher → Suche → Frontend → Infra).
- **Web-UI vereinheitlichen** (Seitenskelett `PageLayout`, Untermenü-Zeile im Sticky-Stack, Toolbar-Vertrag, Scroll-/Fokus-Restore, Selection-Bar und Basket) — **umgesetzt** in sechs Etappen (#1276–#1281). Die Regeln stehen in den Abschnitten oben (Seitenskelett, Breakpoints, Knöpfe, Dialoge, Detailseiten, Zurück-Navigation, Listen, Auswahl); Konzept und Etappenhistorie in `documentation/plans/web-ui-vereinheitlichung.md`.
- **Orientierungs-Varianten** (Hoch- und Querformat desselben Motivs als Formatgruppe; jede Ansicht zeigt die Seite, die zur Bildschirm-Orientierung passt) — **umgesetzt** in sechs Etappen (#1421, #1425, #1426 und Etappe 6). Regel und Konstante (`VARIANT_TIME_WINDOW_SECONDS`) in `photo/orientation-variants.ts`, Web-Hilfen in `frontend/src/utils/orientationVariants.ts`, iOS in `Core/Models/OrientationVariants.swift`; Konzept und Umsetzungsstand in `documentation/plans/orientierungs-varianten.md`.
- **Kurse der gehaltenen Wertpapiere** (Provider-Schnittstelle mit Onvista als Kursquelle, Yahoo/EODHD wählbar, eigener Kurs-Cache mit Historie, Scheduler zu Handelszeiten, Kurse-Seite mit Kacheln und Zeitspanne, EODHD-Nachrichten im Tagesbudget) — Etappen 1–6 umgesetzt (#1467, #1468, #1471, #1472, Etappe 4: Nachrichten auf Positionsseite, Zähler ungelesener Nachrichten auf der Kachel; Etappe 5: Yahoo-RSS als zweiter Nachrichtenweg, `finance/quote-provider-yahoo-news.ts`, Nachrichtenquelle je Position und Provider); Etappe 6: Tageskurs in Depotübersicht und Positionsverlauf statt des letzten Bank-Snapshots, `finance/quote-store.ts`). **Alle Etappen umgesetzt.** Plan und Stand in `documentation/plans/kurse.md`.
- **Wertpapier-Stamm, Depotauszüge, KI zuerst** (Wertpapiere je Depot nur nach Bestätigung — Bank-Bestand automatisch, Fundstellen aus Buchungen/Belegen als Vorschlag unter „Zu prüfen“; Depotauszüge und Reportings als Bestandsstände; die KI liest, die Regeln prüfen): `documentation/plans/wertpapier-stamm.md` (Plan auf Englisch). **Alle drei Etappen umgesetzt**: Stamm (#1518), Depotauszüge als Bestand (#1520, `finance/depot-statement-parser.ts`, `depot-statement-enrichment.ts`), KI zuerst (Merge mit Verankerung im Text, Papiersorten-Frage in `finance/depot-paper-type.ts`).
- **KI-Assistent über alle Daten** (ein Chat, der Fragen über Finanzen, Dokumente, Fotos, Zähler und Reisen beantwortet; das Modell kennt den ganzen Werkzeugkatalog aus der OpenAPI-Spezifikation und ruft nur bestehende Service-Funktionen über `~encore/clients` als der fragende Nutzer auf, nie SQL; Schreibaktionen als bestätigungspflichtige Vorschläge; Arbeitsergebnisse als Sammelmappen (auch Regel-Mappen von Buchungen mit Zwischensummen) und Dokumente, darunter geschwärzte PDF-Bündel, Berichte mit Zwischensummen und Anschreiben aus ausgewähltem Kontext; Tool-Calling über den lokalen llama-server; Streaming per `api.streamOut`): `documentation/plans/ki-assistent.md` (Plan auf Englisch), Sammel-Issue #1524, Etappen #1525–#1534. Etappe 1 umgesetzt: `POST /chat` im llm-service (`llm-service/chat.py`, Tool-Calling über llama-server, JSON-Emulation auf `inproc`, Streaming als SSE) und der Benchmark `llm-service/bench/chat_bench.py`; die Messung auf dem produktiven Gemma-4-Modell steht noch aus und kommt in die Tabelle im Plan. #1526 umgesetzt: `GET /finance/mandates/upcoming` (`finance/upcoming-debits.ts`) und die Seite Finanzen › Erwartete Zahlungen (Lastschriften und Überweisungen, Kanalfilter, nie Karte oder Bargeld; Werkzeug `upcoming_payments`). #1527 umgesetzt: Dienst `assistant/` (Unterhaltungen, `POST /assistant/conversations/:id/ask` führt die Agent-Schleife `agent.ts` aus, `GET /assistant/turns/:turnId/stream` schaut nur zu, weil ein WebSocket-Token nur Media-Rechte hat; Katalog `catalog.ts` aus handgeschriebenen Tools in `assistant/tools/` plus Einträgen aus `openapi/spec.json` über `tool-allowlist.ts`). #1528 umgesetzt: Seite `/assistent` (`views/AssistantView.vue`, Komponenten unter `components/assistant/`, Ereignisse eines Laufs in `utils/assistantTurn.ts`), Chat-Symbol in der Kopfzeile, Recht `module.assistant` für jede Modulrolle. #1529 umgesetzt: Schreibaktionen nur als Vorschläge (`assistant/proposals.ts`, Tabelle `assistant_proposal`, Werkzeuge in `assistant/tools/writes.ts`), ausgeführt erst über `POST /assistant/proposals/:id/execute` als der Nutzer; Karte `components/assistant/ProposalCard.vue`. #1530 umgesetzt: Rückfragen auf frühere Ergebnisse (`from_previous_result` je Typ, Notiz der Werkzeuge hinter jeder früheren Antwort im Verlauf, Spalten `digest`/`result_ref` an `assistant_message`), Titel aus der ersten Frage im Hintergrund (`assistant/titles.ts`). #1531 umgesetzt: Wortpositionen je Seite in `document_page_words` (geschrieben von text_extract in derselben Transaktion wie `extracted_text`, Suche mit `findTextBoxes` in `documents/page-words-store.ts`, Backfill über den Queue-Dienst `page_words`); der Textlayer wird mit `pdfjs-dist` gelesen, nicht mehr mit `pdf-parse`. #1532 umgesetzt: geschwärzte Bündel — `find_text_in_document`, `create_collection` (Werte statt Rechtecke, Boxen über `GET /documents/:id/text-boxes`) und `build_collection_pdf` in `assistant/tools/`. #1533 umgesetzt: Bericht in Gruppen mit Zwischensummen und Rendite — Werkzeug `transaction_report`, Rechnung in `finance/grouped-report.ts`, Endpunkte und Tabelle `finance_grouped_report` in `finance/grouped-report-api.ts`, PDF `createGroupedReportPdf` in `finance/pdf-report.ts`. #1534 umgesetzt: Arbeitskontext je Unterhaltung (`assistant_conversation.context`, Briefe der Objekte in `assistant/briefs.ts`, Einstieg über `/assistent?context=…` aus den Auswahlleisten und „Antwort entwerfen“), Werkzeuge `get_document_text` und `render_letter` (`assistant/tools/letters.ts`, DIN-5008-PDF in `assistant/letter-pdf.ts`, Lücken als `[[…]]`, Karte editierbar über `LetterEditor.vue`), abgelegt über `POST /documents/generated` mit Verknüpfung in `document_links` (Gruppe „Antwort und Bezug“ im Panel „Verwandte Dokumente“). Benchmark auf Knopfdruck: Dokumente › Einstellungen › KI-Benchmark (`assistant/benchmark.ts`, Fälle in `assistant/bench/cases.ts`, Läufe in `assistant_benchmark_run`) — läuft durch die echte Agent-Schleife mit festen Werkzeugergebnissen; ein neues Werkzeug bekommt dort einen Fall. Summen über Buchungen rechnet `transaction_totals` (Filter und Suche der Buchungsliste, Zwischensummen je Tag, Monat, Quartal oder Jahr, `POST /finance/transactions/totals` in `finance/transaction-totals-api.ts`, Rechnung in `finance/transaction-totals.ts`); `create_transaction_folder` schlägt daraus eine Regel-Sammelmappe vor, deren Regel die Gruppierung als `totals` mitträgt und deren Seite die Summen zeigt (`components/finance/CollectionTotalsPanel.vue`). Die frühere Analyse-Seite (`finance/analysis.ts`, gespeicherte Analysen) gibt es nicht mehr.
- **Sammelmappen für alle Typen** (Fotos, Alben, Dokumente, Transaktionen, Wertpapiere, Zähler und Zählerstände in benannten Mappen, typisiert oder gemischt; der Basket wird die eine unbenannte Mappe des Nutzers; Exporte je Typ mit Exportprofilen, Versand über Teilen-Menü und E-Mail, anonyme Freigabelinks, periodischer Export): `documentation/plans/sammelmappen.md` (Plan auf Englisch), Issue #1548. **Alle Etappen umgesetzt** (gemeinsamer Basket auf dem Server, Finanz-Snapshots als Transaktions-Mappen, „In Sammelmappe legen“ überall, Modullisten mit Filter `collection`, Seite `/sammelmappen`, gruppiertes Aktionsmenü gemischter Mappen, Regel-Mappen für Fotos/Buchungen/Wertpapiere/Zähler in `collections/rules.ts`, Album aus Sammelmappe, Exporte mit Profilen: Exporter je Typ in `collections/exporters.ts`, Optionen in `export-options.ts`, Läufe und Profile in `exports.ts`, Dialog `ExportDialog.vue`; Versand über Teilen-Menü, E-Mail mit Protokoll und Download-Link in `collections/sending.ts` und `ExportSendPanel.vue`; periodischer Export in `collections/schedules.ts` und `ExportSchedulePanel.vue`; anonyme Freigabelinks „immer aktuell“ mit Fotos ohne Metadaten, Alben und ganzen Dokumenten in `collections/public-links.ts`, Seite `/geteilt/:token`): Dienst `collections/` (Endpunkte unter `/collections`), Mitglieder je Typ in `collections/members.ts`, Dokumente bleiben in `document_collection_items` (`documents/collection-membership.ts`), Zugriff auf die Mappe in `documents/collection-access.ts`, Konten-Rechte in `finance/account-acl.ts`.
- **Betriebe: EÜR, Anlagenverzeichnis und Flächen** (verpachtete Landwirtschaft und PV-Anlage als Betriebe im steuerlichen Sinn unter Finanzen › Betriebe; Anlagegüter mit linearer AfA monatsgenau bis 1 € Erinnerungswert in `finance/depreciation.ts`, Flurstücke mit Pächter und Pacht; Etappe 2 EÜR aus Buchungen plus AfA, Etappe 3 PV mit Zählern und § 3 Nr. 72 EStG, Etappe 4 Dokument-Verknüpfungen): `documentation/plans/betriebe-euer.md` (Plan auf Englisch). **Alle vier Etappen umgesetzt**: Tabellen `finance_business*`, Endpunkte in `finance/businesses.ts`, Seiten `BusinessesView.vue`/`BusinessDetailView.vue`, Assistenten-Werkzeuge `list_businesses` und `business_assets` in `assistant/tools/business.ts`; EÜR je Betrieb und Jahr aus den Buchungen mit dem Buchungs-Tag des Betriebs (Zeilen der Anlage EÜR als Liste `euer_lines` am Betrieb, Zuordnung über die weiteren Tags, Rest unter „Sonstige“, AfA aus dem Verzeichnis) in `finance/euer.ts`, PDF in `finance/euer-pdf.ts`, Werkzeuge `euer_report`/`euer_pdf`, Betriebe in der Ausfüllhilfe; PV-Anlage mit Leistung in kWp, Inbetriebnahme und abgeleitetem Status nach § 3 Nr. 72 EStG (`finance/pv.ts`, Override am Betrieb), Einspeisung des Jahres aus dem Energiebericht der Zähler, steuerfreie EÜR nur zur Information; Dokumente an Betrieb, Anlagegut und Fläche in `finance_business_document` (Endpunkte in `finance/businesses.ts`, Abschnitt „Dokumente“ auf der Betriebsseite, Werkzeug `business_documents`).
- **Admin-Aktionen in die Module verschieben** — **umgesetzt**. Datenverwaltung, Bibliotheken, Taxonomie-Cockpit/-Tools und KI-Modell liegen jetzt unter Fotos/Dokumente/Finanzen › Einstellungen; Admin behält Benutzer, Rollen, Jobs und die neue Systemstatus-Seite. Die Panels der früheren `DataManagementView` liegen unter `frontend/src/components/admin/`. Plan und Umsetzungsstand: `documentation/plans/admin-datenverwaltung-aufteilung.md`.

## Keine personenbezogenen Daten (PII) im Repo

In Code, Tests, Fixtures, Kommentaren, Seed-Daten, Migrationsdateien und Commit-/PR-Texten dürfen **keine echten personenbezogenen Daten** vorkommen. Das gilt insbesondere für:

- Namen (Vor-/Nachnamen von Personen, auch Ärztinnen/Ärzte, Angehörige, Absender)
- Adressen, Postleitzahlen, Geokoordinaten
- Telefonnummern, E-Mail-Adressen
- IBAN/Kontonummern, Depotnummern, Vertrags-/Kunden-/Rechnungsnummern
- Geburtsdaten und andere identifizierende Angaben

Betroffen sind auch Inhalte aus Beispieldokumenten, die zur Analyse (z. B. für die Dokumentenverwaltung/Klassifikation) hochgeladen werden — daraus abgeleitete Test-Fixtures, Prompts oder Beispieltexte müssen mit frei erfundenen, offensichtlich synthetischen Werten arbeiten (z. B. `Beispielstraße 1`, `12345 Musterstadt`, `max@beispiel.test`, `DE00 0000 0000 0000 0000 00`), nicht mit realen Daten aus der Quelle.

Vor jedem Commit, der neue Test-Fixtures, Seed-Daten oder Beispieltexte einführt: kurz prüfen, ob eine der obigen Kategorien betroffen ist, und ggf. durch synthetische Werte ersetzen.

## Produktiv geladenes KI-Modell

Im llm-service läuft produktiv **`gemma-4-26B-A4B-it-qat-UD-Q4_K_XL`**
(Gemma 4, Mixture-of-Experts mit 26 Mrd. Parametern gesamt und rund 4 Mrd.
aktiven je Token, quantisierungsbewusst trainiert, dynamische 4-Bit-Quantisierung)
auf einer GPU mit **16 GB VRAM**, über den `server`-Backend (llama-server mit
`--jinja`), mit dem passenden `mmproj` für Vision. Das in Doku und Defaults
noch erwähnte Qwen2.5-7B ist nur der CPU-Fallback. Pläne, Prompts und
Benchmarks richten sich nach diesem Modell; der VRAM-Rahmen (Gewichte plus
KV-Cache plus E5-Embedder) begrenzt das nutzbare Kontextfenster, siehe
`llm-service/README.md`.

## GitLab-Zugriff (selbstgehostete Instanz)

Das Repo liegt zusätzlich auf einer selbstgehosteten GitLab-Instanz; ihr Hostname steht im Environment-Secret **`GITLAB_HOST`**, der Projektpfad in **`GITLAB_PROJECT`**. Für `git clone`/`push` dorthin per Personal-Access-Token: der Token liegt als Environment-Secret unter dem Namen **`GITLAB_TOKEN`**. Beispiel:

```bash
git clone https://oauth2:${GITLAB_TOKEN}@${GITLAB_HOST}/${GITLAB_PROJECT}.git
```

Der Host muss außerdem in der Netzwerk-Policy der Umgebung freigeschaltet sein, sonst schlägt der Verbindungsaufbau mit 403 fehl.


## `docs/` ist die Webseite, `documentation/` ist die Doku

`docs/` wird per GitHub Pages veröffentlicht und enthält ausschließlich `index.html` und `assets/`. Alle Pläne, Konzepte und Beschreibungen (Markdown) liegen unter `documentation/`. `npm run check:pages` (läuft im pre-push-Hook) schlägt fehl, wenn etwas anderes in `docs/` landet.
