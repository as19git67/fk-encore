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
`notice`, `selection` und den Inhalt. Selten gebrauchte Aktionen (neu
einlesen, ableiten) gehören in ein Mehr-Menü (⋮) im Slot `menu`, das am Ende
der Titelzeile steht und keine eigene Zeile kostet. `toolbar`, `notice` und `selection`
hebt `PageLayout` in den einen Sticky-Stack der App (`#module-subheaders` in
`App.vue`), mit `sticky-header` auch die Titelzeile samt `#actions`.

Regeln:

- Das Dokument ist der einzige Scroller der Seite (Issue #1674): iOS scrollt
  beim Tippen auf die Statusleiste nur dann nach oben. Keine View legt einen
  eigenen Scroller um ihren Hauptinhalt. Virtuelle Raster nehmen
  `usePageVirtualizer` (Fenster-Virtualizer, `scrollMargin` und
  Stack-Höhe eingerechnet). `scroll="fill"` ist nur für Inhalte ohne Länge
  (Karte): genau ein Viewport unter dem Stack, nichts scrollt darin.
- Ausnahme: die großen Foto-Raster (Galerie, Album, Fotos einer Person, geteiltes
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
- Eine Detailseite, deren Toolbar die Seite trägt (das Album), setzt
  zusätzlich `inline-toolbar`: ab `xl` steht die Toolbar dann auf der
  Titelzeile und `hint` als kleine Zeile unter dem Titel. Ebenfalls ab `xl`
  rückt das Untermenü eines Moduls in die App-Leiste, wenn es dort ganz
  hineinpasst (`submenuFitsNavbar` in `utils/navbarLayout.ts`), sonst bleibt
  es eine eigene Zeile.
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

Jede Seite mit einem Ausgang legt ihn in den `#back`-Slot von `PageLayout`:
`<Button icon="pi pi-arrow-left" text rounded aria-label="Zurück" />`. Der
Pfeil steht damit links vor dem Titel, der Titel nimmt den Rest der Zeile
(gekürzt mit „…“), und `#actions` rutscht in eine eigene zweite Zeile ab
derselben Kante. Eine Seite mit vielen Aktionen gibt sie als `ToolbarItem[]`
an `ResponsiveToolbar`, die in ein Mehr-Menü (⋮) faltet, was nicht passt —
nie einen Zurück-Knopf in `#actions` oder rechts vom Titel. Detailseiten
rufen dort `goBack` aus `useModuleBack(basePath, fallbackRouteName)` auf — History,
wenn die vorige Seite im selben Modul lag oder eine Seite war, die Objekte
aller Module öffnet (der Assistent, die Sammelmappen; Liste
`CROSS_MODULE_ORIGINS` im Composable), sonst die Liste des Moduls.
In `#actions` kommen zuerst Vor/Zurück durch den Basket (wo es einen gibt)
und erst dann die Aktionen der Seite. Die Seite setzt `sticky-header` an `PageLayout`, so
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
- Verlässt der Nutzer die Seite auf einem anderen Weg (der Knopf „Öffnen“
  im Vorschaubereich der Split-Ansicht, ein Link in der Zeile, das Menü)
  und die View hat in diesem Besuch kein Anchor gespeichert, speichert
  `PageLayout` selbst die Zeile, auf der er war (`leavingAnchor`): die mit
  dem Fokus, sonst die mit `aria-current="true"`, sonst die zuletzt
  angeklickte. Eine Liste mit „aktueller Zeile“ setzt deshalb
  `aria-current="true"` an die Zeile mit `data-anchor`.
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
  dorthin, und sie lassen das Menü gleich: was der Zustand nicht erlaubt,
  steht ausgegraut da (`disabled` an `TripPinSheetAction`), statt zu
  fehlen — „Erledigt“ erst ab dem Tag selbst, „Auf einen anderen Tag“ nicht
  für Erledigtes oder fest Terminiertes, im Untermenü Priorität trägt die
  aktuelle Wahl den Haken. Was zu einer Sache gehört, ist ein Eintrag mit
  einem Blatt: „Feste Zeit …“ öffnet das Blatt der festen Zeit, das sie
  mit Grund einträgt, ändert oder entfernt. „Einplanen“ nur für Kandidaten.
- Ein eingeplanter Stopp verlässt den Tag über „Löschen“ (ganz unten im
  Menü, und Wischen nach links auf der Karte); er landet wieder bei den
  Ideen, eine feste Zeit nimmt er mit weg.
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

- **Reiseverlauf** (die Reise als eine Kette aus Aufenthalten und Weiterreisen auf einem Bildschirm; ein Aufenthalt besitzt Ort, Unterkunft, Tage und Verkehrsmittel vor Ort, eine Weiterreise Abfahrt, Ankunft, Verkehrsmittel und Nächte unterwegs, die Reise genau ein Datum; alle anderen Daten werden abgeleitet): `documentation/plans/reiseverlauf.md` (Plan auf Englisch). Etappe 1 umgesetzt: `trip-planner/itinerary.ts` mit `itineraryOf` (gespeicherte Etappen als Kette lesen), `deriveFrames` (rein, deterministisch) und `GET`/`PUT /trip-planner/plans/:planId/itinerary`; eine Weiterreise mit beiden Uhrzeiten ist ein `transit`-Leg, eine mit einer oder keiner schreibt nur Ankunft und Abfahrts-Fixpunkt auf die Nachbarn. Etappe 2 umgesetzt: iOS `TripItineraryView` (Karten je Aufenthalt und Weiterreise, Bearbeiten an Ort und Stelle, Plus auf der Linie, Umsortieren über „Nach oben“/„Nach unten“ auf der Karte, ein Datum im Kopf) über `TripItineraryDraft` in `TripItinerary.swift`, die die Kette selbst zusammenhält und die Daten wie `deriveFrames` ableitet; Einstieg über den Stift der Etappenleiste, den Kopf des Etappen-Sheets und „Neue Reise“ (`wantsItinerary` am View-Model). `TripLegsView`, `TripAddLegView`, `TripLegEditView`, `TripTransitView`, `TripDraftLegView` sind weg. Etappe 3 umgesetzt: „Neue Reise“ fragt nur Name, Unterkunft, Länge und Datum; die Einstellungen haben kein Verkehrsmittel und keine Ankunft mehr; Abfahrt und Ankunft einer Weiterreise im Tagesband und die „Ankunft“ im Tageskopf öffnen den Reiseverlauf mit dieser Weiterreise aufgeklappt (`TripItineraryFocus`, `TripItineraryDraft.item(focused:)`, `TripLeg.isJourneyDeparture`). Etappe 4 umgesetzt: `TripNewPlanDraft` hält einen `TripDraftStay`, die App sagt „Aufenthalt“ statt „Etappe“/„Stadt“, `legs.ts` und `transits.ts` sind weg, ihr Verhalten ist über `PUT …/itinerary` in `itinerary-edit.test.ts` getestet, Doku §22.7/§25.1/§25.2/§25.5 und Handbuch angepasst. **Alle Etappen umgesetzt.**
- **Kandidaten: Ranking, Bilder, Text, eine Liste** (Bekanntheit aus offenen Daten statt Tag-Summe: Wikipedia-Seitenaufrufe, Sprachversionen, Wikivoyage-Nennung, Commons-Bilder, je Ort gecacht in `trip_spot_prominence`; Bild an der Kandidatenkarte aus Wikipedia/Wikidata/Commons, Galerie über die Commons-Kategorie; Kuratierung des Pools je Aufenthalt durch das lokale Modell als Hintergrundjob, nur Ordnen und Begründen, nie Erfinden; Beschreibung aus Wikivoyage, Wikipedia oder der eigenen Website des Orts mit Zitat-Prüfung; ein manuell hinzugefügter Ort startet mit dem Sammlungs-Wert 10; „Wünsche“ geht in „Kandidaten“ auf: eine Liste mit Abstimm-Ring je Zeile; kein Bewertungsdienst, keine automatische Websuche): `documentation/plans/kandidaten-ranking.md` (Plan auf Englisch). Etappe 0 umgesetzt: `MANUAL_SCORE`/`MANUAL_REASON` in `trip-planner/candidates.ts`, gilt für jeden Fund und jede Zusammenführung, Migration 0291 hebt bestehende. Etappe 1 umgesetzt: Bekanntheit wird beim Bau des Pools gefragt (Tage werden daraus geplant), Cache `trip_spot_fame` je OSM-Referenz 90 Tage, Budget 8 s, Rest über den Cron `trip-planner-spot-fame`; Rechnung `prominence.ts` (Quartile im Pool, `TIER_POINTS`), Quellen `fame-client.ts`, Wikivoyage-Parser `wikivoyage.ts`, Cache `spot-fame.ts`; Tests laufen mit stillem Client (`TRIP_SPOT_FAME=0`). Etappe 2 umgesetzt: ein Foto je Ort (Wikipedia-Hauptbild → P18 → Foto im Umkreis von 60 m) in `trip_spot_fame.image`, an Pool und Stopps über `loadPlan`, Galerie `GET /trip-planner/spots/gallery`, iOS `TripSpotThumbnail`/`TripSpotPictures`, offline über `TripOfflineThumbnails`. Etappe 3 umgesetzt: Reihenfolge des lokalen Modells je Aufenthalt in `trip_leg_curation` (Prompt, Tor und „neu fragen?“ in `trip-planner/curation.ts`, Job `curation-job.ts` mit `markCurationDue` bei jedem Pool-Schreiben und Cron `trip-planner-curation` alle 5 Minuten), Rang als Score-Band `curatedScore` (5–9, unter `MANUAL_SCORE`), Pool-Zeilen mit `search_score`/`curated_score`/`curated_reason`, damit die Stimmen beim Umsortieren bleiben; ans Modell gehen nur Gründe aus offenen Daten, nie Stimmen mit Namen; App zeigt „wird noch sortiert“; Benchmark-Spur `planner` in `llm-bench/run-curation.ts`. Etappe 4 umgesetzt: Beschreibung je Ort in `trip_spot_fame.description` (Wikivoyage direkt aus dem Lookup, sonst Wikipedia-Einleitung, sonst die eigene Website über `fetchSharedPage`, vom lokalen Modell zusammengefasst und nur mit Zitat von der Seite behalten), Hintergrund `describeSpots` in `trip-planner/spot-description.ts`, Cron `trip-planner-spot-descriptions`; iOS zeigt sie mit Quelle (`TripSpotDescriptionSection`). Daraus ein kurzer deutscher Satz je Ort in `trip_spot_fame.summary` (`trip-planner/spot-summary.ts`: kurzer deutscher Text unverändert, sonst das lokale Modell, Prüfung mit `namesUnknownFact`, Schlüssel des Ausgangstexts, Cron `trip-planner-spot-summaries`), als `summary` an Pool, Stopps und Highlights; iOS zeigt ihn in der Zeile der Spot-Auswahl und auf der Karte des Spots im Aufenthalt. Etappe 5 umgesetzt: „Wünsche“ ist in „Kandidaten“ aufgegangen — `TripBallotView` ist weg (Modelle in `TripVotes.swift`), `TripPoolView` trägt je Zeile den Abstimmungs-Ring (`voteRing`, Aktionen `voteActions` in der Gruppe `.vote` von `candidateActions`, also auch im Pin-Sheet und in der Detailansicht), Namen darunter, oben „Damit neu planen“, Fairness und „noch nichts gesagt“, unten „Schon eingeplant“; die Suche findet Namen; die Karte zeigt den Wunsch als Ring; das Etappen-Sheet hat nur „Kandidaten (n)“. **Alle Etappen umgesetzt.**
- **Reise planen und unterwegs** (der Reiseverlauf zeigt die Tage unter jedem Aufenthalt mit Füllmarke; ein Aufenthalt wird als Ganzes geplant, alle Tage auf einem Bildschirm, Ziehen zwischen Tagen; eine Spot-Auswahl als Blatt (Ideen, Highlights, Suche) und Spot-Details als Blatt; der Reisebeginn ist das „Von“ des ersten Aufenthalts, Ende nur gerechnet; Ortszeit mit Zeitzone je Aufenthalt; jeder Hafen einer Kreuzfahrt ist ein Aufenthalt, „an Bord“ abgeleitet; gepinnt heißt feste Zeit (Ticket, Licht, Reservierung, Ereignis, Abfahrt); Essen ist einplanbar; unterwegs dieselbe Ansicht am laufenden Tag, Besuche nach Verweildauer abgehakt, von Hand abhakbar, alles rückgängig, Fotos nur nach Zugriffsrechten, Blatt „Weg“ vor und während der Reise; bestehende Reisen behalten Aufenthalte, Tage und Ideen, Kandidaten, Strecken und Stimmen entfallen): `documentation/plans/reise-planen-und-unterwegs.md` (Plan auf Englisch), Konzept mit Mocks im Claude Doc „Reiseverlauf: Reise und Stopps anlegen“, Kopie mit SVG-Mocks in `documentation/plans/reise-planen-und-unterwegs-design.md`. Ein Blatt sieht in halber und voller Höhe gleich aus (`opaqueSheetBackground()` in `ios/Sources/FKPhotos/Core/UI/SheetBackground.swift` neben jedem `presentationDetents`). Etappe 1 umgesetzt: Zeitzone je Aufenthalt und Sprung je Weiterreise beim Lesen aus den Koordinaten (`trip-planner/time-zone.ts`, offline über `tz-lookup`, nicht gespeichert), ein Aufenthalt zwischen zwei Schiffsfahrten ist an Bord (`betweenShips` in `itinerary.ts`), ein eingefügter Hafen verschiebt das Reiseende nicht (`refuseMovedCruiseEnd`), ohne Unterkunft mindestens 15 km Suchradius (`stayReach` in `search-reach.ts`), geteilte Pins über 50 km fragen nach dem Aufenthalt (`stayChoices` in `share.ts`), Namensvorschlag `POST …/name-suggestion` (`name-suggestion.ts`), Migration 0304 macht jede Reise zur Ideen-Reise (gesuchte Kandidaten, Strecken, Stimmen und Kuratierung weg). Die Einstellungen nehmen `startDate` noch an (die App schickt es nicht mehr). Etappe 2 umgesetzt: `TripItineraryView` zeigt die Tage unter jedem Aufenthalt mit Füllmarke (`TripItineraryDays.rows`), „Liste | Karte“ (`TripItineraryMapView`), Blätter in `TripItinerarySheets.swift` (Neuer Aufenthalt/Aufenthalt, Weiterreise, Neuer Hafen über `insertPort`, Zuhause), jedes Blatt speichert sofort, Entfernen und Kürzen mit „Rückgängig“ über das Journal, Name nur über Koffer › Einstellungen (nicht per Tipp auf den Titel), ohne Namen der Vorschlag; eine Schiffsfahrt darf 30 Nächte haben (`MAX_SHIP_NIGHTS`). Etappe 3 umgesetzt: Grund einer festen Zeit (`pin_reason` an `trip_plan_fixpoints`, Migration 0305, `pin-reason.ts`: ticket/light/reservation/event/departure, nur an einem Termin mit Spot, `POST …/fixpoints/pin-reason` ohne Neuplanen), „Reihenfolge vorschlagen“ ordnet Essen wie jeden Spot (eine Reservierung ist ein Termin und damit hart); iOS `TripStayPlanView` (alle Tage eines Aufenthalts, Karten mit „⋯“ aus `stopActions`, Ziehen auf Karte oder Tag über `stops/move`, Karte mit Tages-Chips und „+ Tag n“), gepusht aus dem Reiseverlauf, mit dem sich eine Reise öffnet (unterwegs gleich am laufenden Tag; ein Tag hat keinen eigenen Bildschirm mehr, sein „⋯“ trägt „Reihenfolge vorschlagen“, „Pause einfügen“, „Feste Zeit eintragen“ und „Ausflug planen“, feste Zeiten ohne Spot und Pausen stehen mit „x“ über den Karten; eine Weiterreise hat keine eigene Tagesansicht, nur ihr Blatt im Reiseverlauf), auch über „Planen“ am Aufenthalt; `TripPinReason`/`TripPinChip`. Etappe 4 umgesetzt: Tag-Vorschlag `POST …/legs/:legIndex/suggest-day` (`suggest-day.ts`: erster Tag mit Platz, an dem der Ort offen ist; unklare Öffnungszeiten gelten als offen; sonst der offene Tag mit der meisten Zeit, `full`), Highlights mit `openingHours`, Highlights und Namenssuche nehmen `area` (`search-area.ts`); iOS `TripSpotPickerView` (Suche/Karten-Link, Chips, „+ Tag n“, langes Drücken für andere Tage und „Als Idee behalten“, Karte mit „In diesem Bereich suchen“, Reihenfolge in `TripSpotPicker.items`) als Weg hinein aus Aufenthaltsplanung, Tag und Aufenthalts-Blatt; Spot-Details der Aufenthaltsplanung als Blatt in zwei Höhen mit Wischen zum nächsten Spot (`TripSpotDetailPager`). Etappe 5 umgesetzt: eine Verweildauer über der Schwelle hakt allein ab (`assessVisit`), Foto oder Zahlung allein fragen; „Erledigt“ von Hand ist ein Besuch mit Quelle `manual`, offen oder übersprungen nimmt alle Haken des Stopps zurück (`noteStatusByHand`, `undoVisitsOfStop`; ein abgelehnter Besuch bleibt abgelehnt), `DELETE …/visits/:visitId`; „Neu ordnen“ ab jetzt über `fromMinutes` an `…/days/:dayIndex/order` mit `elsewhere` je `toDrop`; Wetter je Besuch in `trip_plan_visits.weather` (Migration 0306, `visit-weather.ts`, in Tests aus über `TRIP_VISIT_WEATHER=0`); Tagebuch je Tag `GET …/legs/:legIndex/days/:dayIndex/diary` (`day-diary.ts`: Wetter, Fotos nach POI oder 100 m, nur über `accessiblePhotoCondition`, ungeplante Halte); iOS `TripStayPlanView` zeigt den laufenden Tag mit Besuchtem oben, „jetzt“-Linie, Kreis zum Abhaken, „Route“ am nächsten Spot, „Doch nicht“/„Nicht besucht“, „Neu ordnen“, Frage am Abend, vergangene Tage einzeilig, Vorhersage eine Woche, Karte mit Standort, Haken, Fotozahl und Besuchslinie (Regeln in `TripOnTheRoad.swift`). Etappe 6 umgesetzt: Weg zwischen zwei Orten `POST /trip-planner/routing/way` (alle Verkehrsmittel auf einmal, mit `check` die Ankunft gegen Öffnungszeit und Ticket, `arrivalFit`), Wege eines Tages `GET …/legs/:legIndex/days/:dayIndex/ways`, Router-Antworten in `trip_route_cache` (Migration 0307), ÖPNV nur geschätzt (kein Fahrplan), ein in „Weg“ gewähltes Verkehrsmittel gilt je Abschnitt (`trip_plan_segments`, `segments.ts`, `POST …/segments`), solange beide Enden nebeneinander stehen, und `withDayTimes` rechnet mit seiner Dauer (`wayMode` am Stopp); alles in `trip-planner/ways.ts`; iOS `TripWaySheet` und `TripWay.swift`, Wegzeile zwischen den Karten, Straßenwege mit Dauer auf der Tageskarte, „Route“ am nächsten Spot und „Route hierher“ in den Details öffnen das Blatt. Etappe 7 zum Teil umgesetzt: die Kuratierung der Kandidaten ist weg (`curation-job.ts`, `markCurationDue`, `curation` am Aufenthalt), was die Highlights davon brauchen, steht in `trip-planner/highlights-model.ts`, der Cron `trip-planner-curation` tickt nur noch die Highlights; iOS `TripPlaceSearchView` und „Ort suchen“ sind weg, „Spot hinzufügen“ ist der eine Weg hinein; die Abstimmung bleibt (Schalter). Etappe 7 Schritt 1 (Wetter) umgesetzt: Hinweis über einem Tag mit Regen und Spots draußen, „Mit ‹Tag› tauschen“ (nur wenn am trockeneren Tag alles drinnen ist) und „Nur draußen verschieben“, Regeln in `trip-planner/stay-weather.ts`, Endpunkte `GET …/legs/:legIndex/weather-notes` und `POST …/weather-notes/apply` in `stay-weather-api.ts`, jede Übernahme ein Journal-Eintrag `move-stops`, rückgängig über `…/ops/undo`; iOS `TripWeatherNote.swift` in `TripStayPlanView`. Schritt 2 (Abendlicht) umgesetzt: `trip-planner/spot-light.ts` (`GET …/legs/:legIndex/spot-light`, `POST …/spot-light/accept` legt den Spot auf den Tag und schreibt die feste Zeit mit Grund „light“), iOS `TripStaySpotLight.swift` als Abschnitt in `TripSpotDetailView`. Schritt 3 (Ausflüge) umgesetzt: `trip-planner/day-trips.ts` (`GET …/legs/:legIndex/day-trips` mit Zielen 30 min bis 2 h und dem Tag zum Anbieten, `POST …/day-trips/accept` setzt den Tagesanker), iOS Chip „Ausflüge“ in `TripSpotPickerView` (`TripStayDayTrips.swift`), danach sucht die Auswahl um das Ziel und legt auf den Ausflugstag. Schritt 4 (Strecken) umgesetzt: Chip „Strecken“ in `TripSpotPickerView` (`TripStayRoutes.swift`, über `GET …/routes` mit `order=worth` und `POST …/routes`, dann „+ Tag n“), Karte am Tag mit Länge, Anstieg und „Weg zum Start“. Danach in dieser Reihenfolge (Anton, 10.11.): erst die alte Suche weg, zuletzt die neuen Quellen. Schritt 5 in der App umgesetzt: die Spot-Auswahl trägt die Aktionen einer Idee (feste Zeit, für später merken, Priorität, Abstimmungs-Ring über `TripStayBallot`, entfernen) und öffnet auf einem Chip; der Kopf des Aufenthalts führt nur noch dorthin; `TripPoolView`, `TripHiddenSpotsView`, `TripNearbyRoutesView`, `TripDayTripView` und `TripEveningLightView` sind weg. Offen: die alte Gebietssuche und der Tagesplaner hinter `startEmpty: false` samt den Tests, die noch so bauen (39 Dateien). Halte unterwegs umgesetzt: eine Weiterreise mit Auto, Rad oder zu Fuß innerhalb eines Tages (`isStoppableJourney` in `transit-leg.ts`) beginnt auf einer Ideen-Reise mit leerem Block „Unterwegs“ (nichts wird selbst gewählt), Highlights der Weiterreise sind der Korridor (`corridorPool`, Entfernung = Umweg), `suggest-day` legt auf ihren einen Tag; iOS Abschnitt „Halte unterwegs“ im Blatt der Weiterreise (speichert zuerst, öffnet dann die Spot-Auswahl auf der Weiterreise), Halte unter der Weiterreise im Reiseverlauf. Ausflüge mit Zeitfenster umgesetzt (Anton, 11.11.: beliebig viele je Tag, Mock 16): `trip_plan_days.excursions` (Migration 0311), auf einer Ideen-Reise schneidet `withExcursions` in `excursions.ts` den Tag um die Zeit unterwegs und setzt den Ausflug als Block `excursion:<id>` dazwischen (Rest `day@<id>`); jeder Gang durch den Tag beginnt einen Ausflug an seinem Ziel und den Block danach an der Unterkunft (`blockStart`); Endpunkte in `excursions-api.ts`, Spots eines entfernten Ausflugs gehen zu den Ideen; ein Ausflug oder ein ganztägiger Ausflug zieht mit seinen Spots auf einen anderen Tag (`POST …/days/:dayIndex/move-excursion`, `carryStops` findet den Block `excursion:<id>` an seinem neuen Tag; ein ganzer Tag tauscht die Spots mit dem Zieltag; ein Spot mit fester Zeit hält den Ausflug fest), in der App über „Auf anderen Tag“ im „⋯“ der Kachel, im Blatt und per Ziehen auf einen Tag; iOS Abschnitt je Ausflug in `TripStayPlanView` mit „+ Spot in …“, Blatt `TripDayAnchorSheet` mit „Ganzer Tag | Zeitfenster“. Spots für einen Ausflug (Mock 17) umgesetzt: Leiste „Für“ in `TripSpotPickerView` (Aufenthalt, Fenster eines Ausflugs mit „noch … frei“, ganztägiger Ausflug; „Ändern“ listet sie, Regeln in `TripPickerTarget.swift`), Ideen nahe dem Ziel zuerst, was nicht ins Fenster passt blass; der Weg zu einem Ausflug und die Suche nach Ausflugszielen gehen nie zu Fuß (`dayTripMode` in `travel.ts`).
- **Offene Spots** (ein Tag trägt vorab nur, was fest ist (feste Zeit, von Hand gelegt); alle anderen Ideen eines Aufenthalts sind „noch offen“ mit Muss/Will/Wenn Zeit; Kapazitätszeile „Muss … · frei …“; „Tag füllen“ schlägt einen Tag vor (offen, Wetter, Priorität, Umweg zu festen Punkten) und schreibt erst mit „Übernehmen“, als weiche Stopps `placed_by = 'fill'`, die nach Tagesende von selbst wieder offen werden; unterwegs „Als Nächstes“ (was jetzt offen hat und vor den nächsten festen Punkt passt, nach eigener Entfernung auf dem Gerät sortiert); ein Besuch an einem offenen Spot landet von selbst auf dem Tag, Geofences auch um die nächsten offenen Spots): Etappe 8 von `documentation/plans/reise-planen-und-unterwegs.md` (Mocks 13–15 dort und in der Design-Kopie, Abschnitt „Offene Spots“). Schritt 1 umgesetzt: `placed_by` an `trip_plan_stops` (Migration 0309, `placed-by.ts`; alles bisher Gelegte ist `hand`, ein Verschieben über `stops/move` macht einen Stopp fest), Cron `trip-planner-return-open` gibt weiche Stopps nach dem Ende ihres Tages zurück an die offenen Spots (`open-return.ts`, je Tag ein Journal-Eintrag `return-open` ohne Akteur; Rücknahme legt sie fest auf den Tag zurück), `capacity` je Aufenthalt beim Lesen (`open-capacity.ts`: Muss/Will/Wenn Zeit gegen die freie Zeit der kommenden Tage abzüglich `OPEN_TRAVEL_SHARE`, Essen zählt nicht). Schritt 2 umgesetzt (Server): „Tag füllen“ `POST …/legs/:legIndex/days/:dayIndex/fill` und „Alle Tage füllen“ `POST …/legs/:legIndex/fill` schlagen vor, ohne zu schreiben (Auswahl rein in `open-fill.ts`: offen an dem Tag, draußen nicht an einem Regentag, wenn ein trockenerer kommt, Muss vor Will vor Wenn Zeit, dann kleinster Umweg zur Linie des Tages, freie Zeit abzüglich `OPEN_TRAVEL_SHARE`, Essen nie; je Spot ein Grund), `POST …/fill/accept` schreibt weiche Stopps und ordnet den Tag (`orderBlocks` in `day-order-api.ts`), Journal-Eintrag `fill-day`, Rücknahme nimmt die noch weichen Stopps wieder von den Tagen (`open-fill-api.ts`); das Wetter je Tag liefert `stayWeather` in `stay-weather-api.ts`. Schritt 3 umgesetzt (iOS): über den Tagen von `TripStayPlanView` die Kapazitätszeile und „Noch offen“ (Ideen ohne Tag außer Essen, Muss zuerst, `TripOpenSpots.open`), eine offene Karte geht per Ziehen oder Menü fest auf einen Tag; „Tag füllen“ unter jedem kommenden Tag und „Alle Tage füllen“ öffnen `TripDayFillSheet` (Vorschlag mit Gründen, „–“ je Spot, „Übernehmen“ mit Rückgängig-Leiste); weiche Stopps tragen „von der App“; Hinweis am letzten Tag, solange Muss-Spots nicht passen; alles in `TripOpenSpots.swift`. Schritte 4–5 offen.
- **Ideen statt Kandidaten-Pool** (ein Aufenthalt beginnt mit leerer Liste; Orte kommen nur durch „Zur Reise“ aus einer Trefferliste (Highlights nach Bekanntheit, Namenssuche, Kategorien), aus geteilten Karten-Links oder aus dem Ideenvorrat; jede Idee hat eine Priorität Muss/Will/Wenn Zeit; Ticket, Öffnungszeiten und Licht gehen vor; die App schlägt nur die Reihenfolge der auf einen Tag gelegten Ideen vor und lässt nichts weg; der Tag ist ein Fenster ohne Vormittag/Mittag/Abend mit geschätzten Uhrzeiten und einem Zeitband; Essen ist ein eigener Pool und wird nie eingeplant; die Abstimmung steht hinter einem Schalter, ab Werk aus): `documentation/plans/ideen-statt-pool.md` (Plan auf Englisch). Etappe 1 umgesetzt: eine Reise mit `constraints.ideas` (`trip-planner/ideas-mode.ts`, gesetzt von `createTripPlan`, außer `startEmpty: false`; alte Reisen ohne Flag behalten ihren gesuchten Pool) sucht nichts und plant keinen Tag, jeder Tag ist ein offener Rahmen ohne Stopps; ein Neuplanen legt die Stopps auf denselben Tag zurück (`carry-stops.ts`), ohne Tag gehen sie zurück zu den Ideen; Tagesausflug-Vorschlag und Kuratierung sind dort aus; Tests bauen Reisen mit `TRIP_START_EMPTY=0` wie früher, `ideas-start.test.ts` prüft die neue Art; iOS sagt „Ideen (n)“. Etappe 2 umgesetzt: Highlights je Aufenthalt über `POST …/highlights` (`trip-planner/highlights.ts`: beide Umgebungssuchen, Bekanntheit, Bild, eine Zeile, `inPool`/`planned`, nichts wird geschrieben), Reihenfolge des lokalen Modells im Hintergrund in `trip_leg_highlights` (`highlights-job.ts`, gleicher Prompt und gleiches Tor wie die Kuratierung, im Takt `trip-planner-curation`), bis dahin nach Bekanntheit mit `sorting`; die Namenssuche nimmt `categories` ohne Namen; iOS `TripPlaceSearchView` mit Highlights/Suche/Kategorien und „Zur Reise“. Etappe 3 umgesetzt: Priorität Muss/Will/Wenn Zeit (`priority.ts`, +2/0/−2 auf `MANUAL_SCORE`) und `opening_hours` an Pool-Zeile **und** Stopp (Migration 0302, wandert beim Einplanen und Zurücklegen mit), `POST …/ideas/priority` in `idea-priority.ts`, Öffnungszeiten-Parser `opening-hours.ts` (nur gängige Formen, sonst „unklar“, nie geraten), Hinweise `closedOn`/`ticket`/`closedThatDay` beim Lesen in `idea-hints.ts`; iOS `TripIdeaChips`, Prioritäts-Aktionen in `candidateActions` und `stopActions`. Etappe 4 umgesetzt: der Tag einer Ideen-Reise ist ein Block `IDEAS_DAY` („Tag“, 600 min, `defaultDayOf` in `day-shape.ts`), „Reihenfolge vorschlagen“ `POST …/days/:dayIndex/order` (`day-order-api.ts`, Suche in `day-order.ts`, Uhr in `day-timing.ts`: Ticket und Öffnungszeiten hart, dann Überlauf, dann Weg; exakt bis 9 Stopps; `toDrop` nur „Wenn Zeit“/„Will“, nie „Muss“), Pausen als `trip_plan_days.breaks` (Migration 0303, nie als Stopp), Uhrzeiten, Fenster, verplant/frei/zu viel beim Lesen in `day-times.ts`; iOS `dayOrderCard` und `TripDayOrder.swift`. Etappe 5 umgesetzt: `TripDayBand` (iOS, `TripDayBand.swift`) zeichnet den Tag als Band nur aus den Server-Zeiten (Wege, Besuche, Pausen, Termine, Pins, „jetzt“), Satz „… verplant, … unterwegs“, Tipp markiert die Zeile; die Tages-Chips tragen eine Füllmarke. Etappe 6 umgesetzt: `POST /trip-planner/food` mit `planId` zeigt die Essens-Ideen der Reise zuerst (`idea: true`), „Reihenfolge vorschlagen“ lässt Essen an seinem Platz; iOS „Essen & Trinken“ in der Ideenliste und „Jetzt aussuchen“ an einer Pause. Etappe 7 umgesetzt: Abstimmung hinter `constraints.voting` (`votingOn` in `ideas-mode.ts`: auf einer Ideen-Reise ab Werk aus, auf alten Reisen an), Schalter „Planen mit“ › „Abstimmen“ in den Einstellungen, `PATCH …/settings` mit `voting`. **Alle Etappen umgesetzt.**
- **Steuerrelevanz als Rolle** (`tax_role` = `beleg` / `bezug` / `keine` statt eines Booleans; `tax_relevant` bleibt und ist aus der Rolle abgeleitet; das Modell nennt die Rolle, die Beleg-Matrix `TAX_EVIDENCE` in `documents/tax-sections.ts` entscheidet je Sektion aus der Dokumentart, ob ein `beleg` steht — nur Abstufung, nie Aufwertung; die Schulbescheinigung ist nie Beleg, die fordert die Familienkasse an, nicht das Finanzamt; die Textregeln in `tax-rules.ts` sprechen in Rollen, ein „Bezug“ behält seine Sektionen; die Erträgnisaufstellung ist nie Beleg; `learned-rules.ts` lernt die Rolle je Absender **und** Dokumentart aus `tax_reviewed`-Dokumenten und wendet sie zuletzt an; beide Rollen sichtbar in Detailseite, Liste, Vorschau, Filter `taxRole` und Stapeldialog, Beschriftung in `frontend/src/utils/taxRole.ts`): `documentation/plans/steuer-belegrolle.md` (Plan auf Englisch), Issue #1613. **Alle vier Etappen umgesetzt** (Etappe 4: `cloud_audit.py` fragt `tax_role` ab und meldet die 3×3-Rollen-Konfusion, `model_scoreboard.py` bewertet die Rolle neben dem Boolean). Ein neuer Fall „betrifft den Sachverhalt, ist aber kein Beleg“ ist eine Zeile in der Matrix, keine neue Regelfunktion.
- **Ausfüllhilfe nach Kennzahlen** (jeder Beleg wird bei der Einordnung als `beleg` auf die Werte ausgelesen, die das Formular verlangt — Belegart bestimmen, dann deren Felder lesen, jede Zahl im Text verankert und auf Plausibilität geprüft; Werte je Person bei Zusammenveranlagung über `subject_persons.relation_kind`; Zuordnung zu Zeile und Kennzahl des Jahres mit dem Steuerrecht dort, wo es nötig ist, z. B. § 35a nur Arbeitskosten; Ausfüllhilfe und PDF als Liste nach Kennzahlen für die Eingabe in ELSTER mit Herkunft jedes Werts; Formularkatalog je Jahr als Daten, Kennzahl `null`, solange nicht am amtlichen Vordruck geprüft): `documentation/plans/steuer-ausfuellhilfe.md` (Plan auf Englisch). Etappe 0 umgesetzt: die Ausfüllhilfe nennt keine Beträge mehr aus der Kassenbon-Regel (`extractReceiptAmount` gilt nur für Kassenbons, nie für Steuerbelege). Etappe 1 umgesetzt ohne Kennzahlen: Katalog `documents/tax-forms/` (eine Datei je Jahr, `line`/`kennzahl` erst mit `source` aus dem amtlichen Vordruck, ein Test verweigert eine Kennzahl ohne Quelle), Belegarten `documents/tax-evidence-kinds.ts`, Beträge und Verankerung `documents/tax-amounts.ts`, Zuordnung mit Steuerrecht `documents/tax-form-mapping.ts`. Etappe 2 umgesetzt: Queue-Dienst `tax_values` (`documents/tax-values.ts`) nach classify und nach manueller Steuer-Änderung, Werte in `document_tax_value` (Status `read`/`rejected`/`confirmed`/`corrected`, eine neue Lesung lässt bestätigte und korrigierte stehen), gelesene Belegart in `document_tax_reading`, Person aus den Bezugspersonen des Dokuments, nie vom Modell; Backfill `POST /documents/tax-values/backfill` in `tax-values-api.ts`. Kennzahlen 2025 am amtlichen Vordruck geprüft (FMS formulare-bfinv.de, Ausgabe 2025/4.1.1.0): `kennzahlSpouse` für Vordrucke mit beiden Ehegatten nebeneinander (Vorsorgeaufwand 300er/400er), `formNote` für Hinweise des Vordrucks; Anlage V hat 2025 keine Kennzahlen. Etappe 3 umgesetzt: `GET /documents/tax/form-values` in `documents/tax-form-values.ts` (über `mapToForm`, nur sichtbare Dokumente, Zusammenveranlagung, solange ein Ehegatte ohne eigene Erklärung im Haushalt ist), Bestätigen/Korrigieren je Wert über `POST /documents/tax/values/:id/confirm|correct`; die Ausfüllhilfe trägt das als `form`, der Dialog zeigt Anlage → Person → Zeile · Kz → Wert mit Belegen, `tax_worksheet` liest dieselbe Struktur. Etappe 4 umgesetzt: das PDF (`assistant/tax-worksheet-pdf.ts`, Aufbereitung in `kennzahlSheet`) beginnt mit den Werten je Anlage und Person, Zeile · Kz · Bezeichnung · Wert in Vordruck-Reihenfolge, Summen verweisen auf einen Anhang mit jedem Beleg und Betrag. Etappe 5 umgesetzt: Korrekturen desselben Absenders und derselben Belegart (nur eigene Dokumente) gehen als Beispiele ins Lese-Prompt (`correctionExamples` in `documents/tax-values.ts`); neben jedem Wert steht der Vorjahreswert (`previous_cents`), Felder mit Vorjahreswert ohne aktuellen Wert stehen unter `previous.missing`. **Alle Etappen umgesetzt.**
- **Zusammenhang zwischen Dokumenten** (Herkunftsordner mit Backfill über `sha256`, Panel „Verwandte Dokumente“ auf der Detailseite, Referenznummern als eigenes Feld, Akten als Sammelmappen mit Regel, Erkennung und Zusammenführung von Beinahe-Duplikaten aus Neuimporten): `documentation/plans/dokumente-zusammenhang.md` (Plan auf Englisch), Issues #1477–#1481. **Alle fünf Etappen umgesetzt** (#1483, #1484, #1485, #1487, Akten). Regeln: `documents/source-folder.ts`, `related.ts`, `reference-numbers.ts`, `dossiers.ts`, `duplicates.ts`.
- **Foto-Ästhetik** (Q-Align/OneAlign (AVA SRCC 0,82, MIT) bewertet jedes Foto in einem nächtlichen GPU-Batch: eigener `aesthetic-service`, der das Modell nur im Fenster lädt; der llm-service gibt die GPU über eine CPU-Konfiguration desselben Gemma-4-Modells frei und bleibt nutzbar; Fenster `aesthetic.window_start/_end` konfigurierbar, innerhalb automatisch, sobald niemand auf eine Antwort des Modells wartet (Hintergrundarbeit in der `llm`-Queue hält den Start höchstens `BACKGROUND_PATIENCE_MS` auf, ein `error` vom letzten Reload nur, solange kein Modell geladen ist; die letzte Prüfung steht als `last_tick` auf der Einstellungsseite); Score ersetzt `clip_aesthetics` unter demselben Schlüssel, `aesthetic_model` nennt die Version; vorläufiger Score beim Import aus einem MLP-Kopf auf dem ViT-H/14-Vektor; Auto-Pick-Gewichte nur nach Replay in `group-auto-pick.calibration.ts`; Gemma 4 erklärt in Worten, nie die Zahl): `documentation/plans/foto-aesthetik.md` (Plan auf Englisch), Issue #1640. Etappe 1 umgesetzt (`aesthetic-service/`, #1639), Etappe 2 umgesetzt (GPU-Verleih im llm-service: `POST /gpu/lend` lädt den CPU-Zwilling der laufenden Konfiguration ohne zu persistieren, `POST /gpu/return` stellt sie wieder her, `lease` in `/reload/status`; App-seitig `lendLlmGpu`/`returnLlmGpu`/`getLlmGpuLease` in `user/llm-models.ts`; die KI-Benchmark-Seite misst auf Knopfdruck „auf dem CPU-Zwilling“, `device: "cpu"` in `assistant/benchmark.ts`), Etappe 3 umgesetzt (nächtlicher Lauf `photo/aesthetic-nightly.ts` mit eingespeisten Diensten aus `aesthetic-deps.ts`, Takt alle 5 Minuten in `aesthetic-cron.ts`, Fenster und Schalter in `photo_aesthetic_settings` (ab Werk aus), Läufe in `photo_aesthetic_run` mit `gpu_returned`, `photos.aesthetic_model` = `qalign_v1` bzw. `qalign_v1:failed`, Formel und Fenster in `photo/aesthetic-score.ts`, Seite Fotos › Einstellungen › Ästhetik), Etappe 4 umgesetzt (vorläufiger Score: linearer Kopf auf dem CLIP-ViT-H/14-Vektor, gelernt aus den eigenen Q-Align-Werten statt aus AVA, `embedding_service/app/services/aesthetic_head.py`, Endpunkte `/aesthetic-head*`; nur in Gebrauch, wenn er Q-Align besser trifft als die Zero-Shot-Prompts; `aesthetic_model = vith_head_v1`; Training und Übertrag auf alle Fotos ohne Q-Align-Wert in `photo/aesthetic-head.ts` nach jedem Nachtlauf und per „Neu trainieren“); Etappe 5 umgesetzt je Nutzer (Nachspielen der geprüften Gruppen mit Q-Align-Werten in `replayOnGroups` (`photo/group-auto-pick.calibration.ts`), neu gelernte Gewichte an zurückgehaltenen Gruppen gemessen, `qalign_quality` als Technik-Signal über `ScoringWeights.technical`, Übernahme nur mit gemessenem Gewinn, Karte „Auto-Pick nachspielen“; die globalen Standardgewichte bleiben, bis ein Nachspielen sie belegt), Etappe 6 umgesetzt (Bildkritik in Worten: `photo/critique.ts`, `POST /photos/:id/critique`, llm-service `POST /vision/json-prompt`, Tabelle `photo_critique`, Abschnitt „Bildwirkung“ in der Foto-Seitenleiste und „Bilder erklären“ im Auto-Pick-Review), Etappe 7 umgesetzt (persönlicher Geschmack je Nutzer: paarweise logistische Regression auf [Formel, CLIP-Vektor] aus den geprüften Gruppen in `embedding_service/app/services/taste_model.py`, Endpunkte `/taste/replay|train|score` ohne gespeichertes Modell; App-Seite `photo/taste-model.ts`, Modell in `ai_pick_taste_model`, Bonus `taste_bonus` im Auto-Pick nur nach Nachspielen mit gemessenem Gewinn, Karte „Persönlicher Geschmack“). **Alle Etappen umgesetzt.**
- **Assistent in der iOS-App** (derselbe Assistent als eigenes Swift-Paket `F4milAssistant` über einem gemeinsamen `F4milCore`, damit spätere Finanz- und Dokumenten-Apps ihn teilen; der Server sagt je Ergebniszeile, wie sie gelesen wird (`display` mit Titel, Untertitel, Betrag, Datum, Web-Pfad, Thumbnail; Blocktitel `title`) in `assistant/present.ts`, damit kein zweiter Renderer je Blockart entsteht; Zeilen öffnen nativ, als PDF-Vorschau oder im Web-View mit Übergabe-Token): `documentation/plans/assistent-ios.md` (Plan auf Englisch). Etappe 1 umgesetzt: `presentBlock` in der Agent-Schleife und beim Lesen einer Unterhaltung. Eine neue Blockart bekommt zuerst ihre Regel in `present.ts`. Etappe 2 umgesetzt: Paket `F4milCore` (`ios/Sources/F4milCore`: APIClient, AuthManager, Keychain, SharedStorage, AppDeepLink, Session-Typen, alles `public`), `FKPhotosLib` hängt davon ab und re-exportiert es (`Core/CoreExports.swift`); `uploadPhoto` ist generisch über den Rückgabetyp und nimmt `allowsCellularAccess`, die Abmelde-Hooks des Fotomoduls gibt `AuthManager.forPhotosApp()` mit. Was alle Apps brauchen, gehört nach `F4milCore` und kennt kein Modul-Modell; was nur Fotos braucht, bleibt in `FKPhotosLib`. Etappe 3 umgesetzt: Paket `F4milAssistant` (`ios/Sources/F4milAssistant`, nur auf `F4milCore`): Wire-Typen, `AssistantAPI`, `TurnFollower` (WebSocket mit Bearer-Header über `APIClient.webSocketRequest`, Resume mit Replay-Cursor, 60 s Stille = tot), `LiveTurn` als Port von `assistantTurn.ts`, Bildschirme `AssistantRootView`/`ConversationView`, generische Zeile aus `display`, Öffnen über `AssistantHost.openRoute` (App zuerst), sonst PDF-Vorschau (`/dokumente/<id>`) oder Web-View unter `/app`; Einstieg in der Fotos-App über die Feed-Toolbar (`Features/Assistant/AssistantEntry.swift`, nur mit `module.assistant`), native Zeilen über `AppDeepLink.parse` und den Router. Das Paket kennt keine App: was eine App selbst zeigt, gibt sie als `AssistantHost` mit; eine neue Blockart braucht im Paket nichts, nur ihre Regel in `present.ts`. Etappe 5 umgesetzt: Übergabe-Token `POST /auth/handover` (nur Full-Scope, eine Minute, einmal) und `POST /auth/handover/redeem` in `user/handover.ts`, Tabelle `auth_handover_tokens`; Web-Seite `/handover` liest Token und Ziel aus dem URL-Fragment (`utils/handover.ts`), meldet an und ersetzt sich durch das Ziel; iOS `WebHandover` in `F4milCore` (für jede App), `RowOpener` öffnet den Web-View damit. Etappe 6 umgesetzt: `ContextRef`, `AssistantChatView` (Unterhaltung per ID oder neu über einen Arbeitskontext, Chips im Chat), in der Fotos-App `AssistantAskButton` in den Auswahl-Toolbars und im Album-Menü (höchstens `MAX_CONTEXT` Fotos), `assistantDestinations()` je Tab-Stack; Push `assistant_answer` (`push.notifyAssistantAnswer`), wenn das `done` eines im Hintergrund gestarteten Turns keinen Zuschauer erreicht (`TurnEmitter` in `assistant/live.ts` zählt die Zuschauer, ein Watcher, dessen Send scheitert, fällt weg) — die App schließt ihren Socket beim Wechsel in den Hintergrund (`suspendWatching`/`resumeWatching`), sonst zählte sie als Zuschauer; Tipp öffnet `AppDeepLink.assistant(conversationId:)` (`/app/assistent?c=<id>`). Etappe 4 umgesetzt: Vorschlagskarten (`Proposal` aus einer Zeile des `proposal`-Blocks, `ProposalCardView` wie `ProposalCard.vue`: Ausführen/Verwerfen über `ConversationStore.execute|discard`, Brief/Textdokument/Collage als Vorschau ohne Bearbeitung — bei Lücken wartet „Ausführen“ und „Im Web“ öffnet die Unterhaltung angemeldet —, Ergebnis über `RowOpener` bzw. PDF-Vorschau mit Teilen, Fortsetzung `continuation` als dieselbe Frage wie im Web, in der Warteschlange bis die laufende Antwort endet; `AssistantHost.didExecuteProposal(tool)` sagt der App, was lief, die Fotos-App lädt darauf ihre Albenliste neu). Nur Etappe 7 (App Intents/Siri, Teilen-Menü als Kontext) offen.
- **Foto-Freigabe** (Genehmigungsprozess neu → abgelehnt/intern/öffentlich per Foto, Eingang über Import-Volume, Upload-Links oder Einreichen, globale Rolle „Foto-Genehmiger“, Freigabe-Alben der Organisation, öffentliche Einstiegsseite, Metadaten-Bereinigung bei anonymer Auslieferung; Etappe 0 = serverseitige Zugriffsprüfung pro Foto): `documentation/plans/foto-freigabe.md` (Plan auf Englisch). **Etappe 0 umgesetzt**: Zugriff pro Foto über `accessiblePhotoCondition`/`assertPhotoAccess`, und was eine Person mit einem Foto tut (Bearbeitung, Favorit, Gesichtsname), sehen nur die, die das Foto auf demselben Weg sehen (`coViewerIds` in `photo/photo-file-access.ts`); Etappen 1–8 offen.

- **Fotobuch** (Fotos aus Auswahl oder Album, eingegrenzt nach Qualität, Ästhetik, „ohne erkennbare Gesichter“ und Höchstzahl; Kapitel aus der Aufnahmezeit, Seiten regelbasiert aus einer Layout-Tabelle, PDF für die Druckerei (Umschlag mit Rücken, Innenseiten als Doppelseiten mit Beschnitt und Schnittmarken) oder zum Selbstdrucken; später Kapitelüberschriften, Bildunterschriften und Layoutwahl durch das LLM, Gewichtung nach Motiv, Basket/Assistent als Quelle, Diashow): `documentation/plans/fotobuch.md` (Plan auf Englisch), Issue #1729. Etappe 1 umgesetzt: Tabellen `photo_book*`, Regeln in `photo/photo-book-layout.ts` (Formate, Layouts, Kapitel, Seitenbau, „erkennbares Gesicht“), Dienst `photo/photo-book.service.ts`, PDF `photo/photo-book-pdf.ts`, Export-Job `photo/photo-book-export.ts`, Endpunkte unter `/photo-books` in `photo/photo-book-api.ts`; Seiten Fotos › Fotobücher (`PhotoBooksView.vue`, `PhotoBookDetailView.vue`), „Fotobuch gestalten“ in der Auswahlleiste von Galerie und Album und im Album-Menü. Etappen 2 und 3 umgesetzt: Bildunterschriften (Ort, POI mit Wikipedia, Personen, Bild) und Kapitelüberschriften vom lokalen Modell in `photo/photo-book-ai.ts`, Prompts in `photo-book-prompts.ts`, Tabelle `photo_book_caption` (`source` `llm`/`user`, eine Unterschrift des Nutzers wird nie überschrieben), ein eigener Kapiteltitel bleibt und der Vorschlag steht daneben; das Modell wählt das Layout nur unter den besten Kandidaten der Regel (`rankLayouts`, nie deutlich mehr Beschnitt), gemessen daran, wie oft der Nutzer Seiten ändert (`/photo-books-layout-stats`). Etappe 4 umgesetzt: Gewichtung nach Personen/Landschaft/Natur/Bauwerke aus Zero-Shot-CLIP (`/zero-shot/score` im Embedding-Service), Gesichtern und POI-Treffern in `photo/photo-book-subjects.ts`; Serien ähnlicher Fotos geben nur ihr bestes, Fotos derselben Szene ebenso (`dropSimilarPhotos`, DINOv2 ≥ `BOOK_SIMILARITY` innerhalb von 3 h); die Eingrenzung lässt sich auf der Buchseite über „Auswahl“ nachträglich ändern (Neuverteilung mit `narrowing`). Bildunterschriften nur mit konkretem Fakt (Ort, Sehenswürdigkeit, Personen, Beschreibung, Text auf einem Schild aus `photo_ocr`, Spot einer Reise), sonst keine (`captionNamesAFact`); dieselbe Unterschrift steht auf einer Seite nur einmal (`repeatedCaptions`). Text im Fotobuch-PDF geht über `useFont` aus `lib/pdf-fonts.ts` (Noto Sans/DejaVu eingebettet, CJK-Schrift für CJK-Text) — pdfkits Helvetica kann nur WinAnsi und macht aus anderem Zeichensalat. Etappe 5 umgesetzt: Sammelmappe als Quelle (Basket wird beim Anlegen kopiert), Werkzeug `create_photo_book` im Assistenten. Etappe 6 umgesetzt: „Diashow“ spielt das Buch im `RecapPlayer` (Prop `plan`, `utils/photoBookSlideshow.ts`); Videoexport offen.
- **Demodaten für ein neues System** (Admin-Aktion auf Systemstatus, nur solange das System unberührt ist (`isUntouched()`: keine Nutzdaten, außer Admin und KI-Nutzer niemand); jede erzeugte Zeile in `demo_item`, damit „Demodaten entfernen“ alles zurücknimmt; Gerüst aus Code mit festem Seed, Texte von Gemma über die `llm`-Queue oder aus Vorlagen (`text: "template"` für Tests und den Assistenten-Benchmark); 500 PDFs über `importDocumentFromPath` ohne vorausgefüllte Metadaten, damit die Klassifikation ihre echte Qualität zeigt und gegen `demo_truth` gemessen wird; 500 Buchungen über die manuelle Buchung, nie über den Finanzkraft-Import; Depot mit echten breiten Indexfonds, Kaufkurse aus der Kurshistorie des Providers; zweiter Demo-Nutzer (Ehepartnerin) mit gemeinsamem Konto; keine Personen; 500 CC0-Fotos über Openverse ohne erkennbare Personen, EXIF neu geschrieben, nie im Repo): `documentation/plans/demodaten.md` (Plan auf Englisch). Etappe 1 umgesetzt: Dienst `demo/` (Endpunkte `/admin/demo/status|start|cancel|remove` in `demo/demo.ts`, nur Admin mit `data.manage`), Zählung in `demo/state.ts`, Register `demo/registry.ts` (`demo_item`/`demo_file`, jede neue Tabelle eines Generators gehört in `DEMO_TABLES` und in `removeRun`), Haushalt mit Ehepartnerin, gemeinsamem Konto und 500 Buchungen aus `demo/household.ts`/`writer.ts`, Lauf als Hintergrundjob mit Fortschritt in `demo_run`, Karte `DemoDataCard.vue` auf Systemstatus. Etappe 2 umgesetzt: 500 Dokumente (Plan `demo/documents.ts`, PDF `demo/pdf-render.ts` mit drei Brief-Layouts, Auszug, Kassenbon und jedem zehnten als Bild-Scan ohne Textlayer, Wortlaut vom Modell in `demo/doc-text-llm.ts` mit Prüfung auf fremde Namen und Beträge, sonst Vorlage), Import über `importDocumentFromPath` ohne Vorbelegung in `demo/doc-writer.ts`, Abgleich mit `demo_truth` in `demo/truth.ts` (`GET /admin/demo/truth`, auf der Karte), Entfernen über `documents/purge.ts`. Etappe 3 umgesetzt: Depot mit vier breiten Indexfonds (`demo/securities.ts`) zu echten Schlusskursen des Kursanbieters (`refreshQuotes` liegt dafür in `finance/quote-refresh.ts`), Plan `demo/depot.ts` (Einmalkäufe, Sparplan, Ausschüttungen, ein Verkauf, Depotauszug je Quartal; jede Abrechnung als Buchung und PDF), Depotkonto mit bestätigten Papieren in `demo/depot-writer.ts`; Depotbuchungen und Bestände liest die Pipeline aus den Papieren, nie direkt geschrieben; ohne Kursanbieter fällt das Depot mit Begründung weg. Etappe 4 umgesetzt (Fotos): Plan `demo/photos.ts` (Anlässe, Reisen mit öffentlichen Plätzen als Ort, Kameras, fünf Alben), Quellen `demo/photo-sources.ts` (Openverse CC0/PDM, Kandidaten mit Personen-Tags fallen vorab weg, jedes Foto durch die Gesichtserkennung, erkennbares Gesicht nach der Fotobuch-Regel = verworfen; kleine Demo, Tests und fehlendes Openverse/Gesichtserkennung zeichnen die Bilder), `demo/photo-writer.ts` (EXIF neu mit exiftool, Import über eine temporäre Bibliothek im Modus „move“, Alben, Lizenzliste in `demo_photo`, die der nächste Lauf wiederverwendet). Startschalter `DEMO_DATA` in `demo/boot.ts` (`1`/`full` volle Demo mit Modell, `small` der kleine Haushalt aus Vorlagen; gehört dem Besucherkonto aus `DEMO_OWNER_EMAIL` (`demo/owner.ts`: alle Modulrollen, nie Admin, beim Lauf angelegt, bleibt beim Entfernen, zählt nicht als Inhalt), ohne die Variable dem Admin aus `ADMIN_EMAIL`; nur auf einem unberührten System); die Playwright-Workflows setzen `DEMO_DATA=small`, `globalSetup` wartet auf den Lauf, `db/seed-demo.ts` und `E2E_SEED_DEMO` gibt es nicht mehr. Etappe 5 umgesetzt: Zähler (Strom Bezug/Einspeisung, PV-Erzeugung, Gas, Wasser) mit Monatsständen aus Saisonkurven, Tarife und eine 9,8-kWp-PV-Anlage als Betrieb mit Anlagegut in `demo/energy.ts`/`energy-writer.ts` (Zähler über die Funktionen des Zähler-Dienstes); die Einspeisevergütung je Monat ist eingespeiste kWh × Tarif, Buchungen tragen `Photovoltaik` plus den Tag der EÜR-Zeile (`tags` an `PlannedBooking`, neue Tags registriert als `finance_tag`). Demo-Instanz umgesetzt: dritter Stack über `docker-compose.demo.yml` (kein eigener llm-service, nutzt den von Prod über dessen Netz, `DEMO_DATA=1`), Vorlage `docker-compose.env.demo.example`, Schritt „Deploy to TrueNAS (demo)“ in den Image-Workflows (nur mit Secret `WATCHTOWER_URL_DEMO`, nie rot), nächtlicher Reset `scripts/host/demo-reset.sh` (stündlich aufrufen, wirkt nur um 18 Uhr Los Angeles, verweigert jede env-Datei ohne `DEMO_DATA`, ohne Suffix oder ohne „demo“ im Datenpfad); Anleitung in `DEPLOYMENT.md` › „Demo stack“. Etappe 6 (Demo-Seite) umgesetzt: `layBenchHousehold`/`removeBenchHousehold` in `demo/bench.ts` legen den Haushalt für einen beliebigen Besitzer (das Benchmark-Konto) mit festem Seed, festem „heute“ und Vorlagen, ohne Depot und Fotos, in ein System mit Daten; `demo_run.purpose = 'benchmark'` hält ihn aus `currentRun()` und Systemstatus heraus, eigene Kontonummern über `accountSeries` von `planHousehold`, eigener Partner, ein Haushalt je Besitzer. Den Benchmark-Seeder (`assistant/bench/synthetic.ts`) darauf umzustellen ist eine eigene Änderung auf der Assistenten-Seite.
- **Freistellungsaufträge und erwartete Kapitalerträge** (Aufträge je Bank mit Besitzer `self`/`spouse`/`joint` gegen den Sparerpauschbetrag des Steuerhaushalts aus `user_subject_persons` und `user_assessment_settings`; Pauschbetrag als Tabelle `finance_saver_allowance` mit Gültigkeit ab Jahr, nie als Zahl im Code; Zinsen aus Kontoauszügen im Dokumentenbestand über Muster plus Modell mit Plausibilitätsprüfung, mit FinTS-Buchungen abgeglichen statt doppelt gezählt; Dividenden und Vorabpauschale aus den Depot-Abrechnungen; Vergleich je Bank und Verteilungsvorschlag; Gegenprobe mit der Jahressteuerbescheinigung aus `document_tax_value`): `documentation/plans/freistellungsauftraege.md` (Plan auf Englisch), Issue #1549. Etappen 1–5 offen.
- **Reise: Hotelpreis-Wächter** (neues Modul „Reise“ mit Rolle „Reise User“ und `module.travel`/`travel.view`/`travel.manage`; ein Wächter = ein Hotel mit festen Daten und Gästen, Grenze pro Nacht inkl. Steuern, standardmäßig nur kostenlos stornierbare Tarife; Pflicht-Enddatum höchstens zwei Jahre voraus und vor der Anreise; Quelle SerpApi Google Hotels über Secret `SerpApiKey` (nur als URL-Parameter), Monatskontingent `TRAVEL_SERPAPI_MONTHLY_SEARCHES`; Job `travel-hotel-watches` täglich um 6 Uhr deutscher Zeit schreibt `travel_hotel_check` und jeden Tarif in `travel_hotel_offer`): `documentation/plans/reise-hotelpreise.md` (Plan auf Englisch). Etappe 1 umgesetzt: Dienst `travel/`, Seite Reise › Hotelpreise. Etappe 2 umgesetzt: Meldung per Push (`push.notifyHotelPrice`, Art `hotel_price`) und Mail (`sendHotelPriceAlertEmail`) je Wächter abschaltbar, Regel `alertDecision` in `travel/hotel-alerts.ts` (unter der Grenze einmal, dann nur neuer Tiefstwert, nach Anstieg über die Grenze wieder; nur der tägliche Job meldet), Anbieter ohne Zimmerliste mit Storno `null` („unbekannt“, zählt nie als stornierbar) und Link je Angebot. Doppelzimmer: `split_rooms` am Wächter (nur Erwachsene, gerade Zahl ab 4) macht je Prüfung eine zweite Suche für 2 Erwachsene, Preis × Zimmer (`asRooms`, `rooms` am Angebot), die günstigere Art zählt. Etappen 3–5 (aus dem Reiseverlauf, Gebietssuche, Preisgrafik/Assistent) offen.
- **Reise: Flugpreis-Wächter** (im Modul „Reise“ neben den Hotels; ein Wächter = Strecke (IATA-Codes, mehrere je Seite), hin und zurück oder einfach, Reisende, Klasse, Umstiege, Airlines ein-/ausschließen, Abflugstunden, Grenze für die ganze Reise; feste Daten oder flexibel: Zeitraum frühester Hinflug bis spätester Rückflug plus Nächte von–bis, je Tag eine Kombination der Reihe nach (`stayCombinations`/`rotationPick` in `travel/flexible-dates.ts`, mit den Hotels geteilt, Spalte `flex_rotation`, höchstens 120 Kombinationen), Grenze und Meldung vergleichen den besten Preis über die zuletzt gefundenen Preise aller noch kommenden Kombinationen (`bestOf`); Quelle SerpApi Google Flights mit demselben Schlüssel und demselben Monatskontingent (gezählt über Hotels und Flüge in `travel/search-budget.ts`); Googles Einschätzung und Preisverlauf je Kombination in `travel_flight_price_point`; keine Links aus der Antwort speichern (Buchungslinks sind Google-Weiterleitungen), stattdessen eine selbst gebaute Google-Flights-Suche (`googleFlightsLink`); Anbieter (`booking_options`) nur bei einer Meldung, ein bis zwei Suchen mehr; Job `travel-flight-watches` täglich 6:15 Uhr; Push `notifyFlightPrice` (Art `flight_price`), Mail `sendFlightPriceAlertEmail`): `documentation/plans/reise-flugpreise.md` (Plan auf Englisch). Umgesetzt: Dienst in `travel/flight-*.ts`, Seite Reise › Flugpreise. Offen: aus dem Reiseverlauf, Preisgrafik über Prüfungen, Werkzeug für den Assistenten.
- **Dokumentenverwaltung** (neues Modul neben Fotos, lokale KI-Klassifikation via llm-service): der Plan lag nur in einer früheren Session außerhalb des Repos und ist nicht erhalten. Wird iterativ in Etappen umgesetzt (DB/Seed → llm-service → documents-Service → Watcher → Suche → Frontend → Infra).
- **Web-UI vereinheitlichen** (Seitenskelett `PageLayout`, Untermenü-Zeile im Sticky-Stack, Toolbar-Vertrag, Scroll-/Fokus-Restore, Selection-Bar und Basket) — **umgesetzt** in sechs Etappen (#1276–#1281). Die Regeln stehen in den Abschnitten oben (Seitenskelett, Breakpoints, Knöpfe, Dialoge, Detailseiten, Zurück-Navigation, Listen, Auswahl); Konzept und Etappenhistorie in `documentation/plans/web-ui-vereinheitlichung.md`.
- **Orientierungs-Varianten** (Hoch- und Querformat desselben Motivs als Formatgruppe; jede Ansicht zeigt die Seite, die zur Bildschirm-Orientierung passt) — **umgesetzt** in sechs Etappen (#1421, #1425, #1426 und Etappe 6). Regel und Konstante (`VARIANT_TIME_WINDOW_SECONDS`) in `photo/orientation-variants.ts`, Web-Hilfen in `frontend/src/utils/orientationVariants.ts`, iOS in `Core/Models/OrientationVariants.swift`; Konzept und Umsetzungsstand in `documentation/plans/orientierungs-varianten.md`.
- **Kurse der gehaltenen Wertpapiere** (Provider-Schnittstelle mit Onvista als Kursquelle, Yahoo/EODHD wählbar, eigener Kurs-Cache mit Historie, Scheduler zu Handelszeiten, Kurse-Seite mit Kacheln und Zeitspanne, EODHD-Nachrichten im Tagesbudget) — Etappen 1–6 umgesetzt (#1467, #1468, #1471, #1472, Etappe 4: Nachrichten auf Positionsseite, Zähler ungelesener Nachrichten auf der Kachel; Etappe 5: Yahoo-RSS als zweiter Nachrichtenweg, `finance/quote-provider-yahoo-news.ts`, Nachrichtenquelle je Position und Provider); Etappe 6: Tageskurs in Depotübersicht und Positionsverlauf statt des letzten Bank-Snapshots, `finance/quote-store.ts`). **Alle Etappen umgesetzt.** Plan und Stand in `documentation/plans/kurse.md`.
- **Portfolio-Analysen** (Performance als TWR und XIRR für Portfolio und Position, Wertverlauf mit investiertem Kapital über 1M/YTD/1J/3J/Max, Allokation, Erträge über die Zeit, Sparpläne): Issue #1700, Folge von #1336. Etappe 1 umgesetzt: Rechnung ohne Datenbank in `finance/portfolio-performance-calc.ts` (Stückzahlen aus den Transaktionen, von jedem Depotstand richtiggestellt; was ein Stand ohne Transaktion zeigt, gilt als Ein-/Ausbuchung zum Tageskurs, nie als Gewinn; ein Tag ohne Kurs jünger als `PRICE_STALE_DAYS` bleibt ohne Wert und wird als Lücke gemeldet), Endpunkt `GET /finance/portfolio/performance` in `finance/portfolio-performance.ts` (je Währung eine Gruppe, `position` für ein Wertpapier), Abschnitt `components/finance/PortfolioPerformance.vue` auf Portfolio- und Positionsseite, Zeitraum in `route.query.period`. Etappe 2 umgesetzt: Allokation (Wertpapier, Art aus `finance_quote_symbol.security_type`, Währung; Hinweis über der Schwelle aus `finance_user_pref` Schlüssel `portfolio`, Standard 10 %), Erträge je Monat und Jahr mit letzten zwölf Monaten, Ausschüttungsrendite und Rendite auf Einstand, Sparplan-Erkennung (mindestens drei Käufe desselben Papiers im selben Depot in festem Rhythmus, Rate ±15 %); Rechnung in `finance/portfolio-analysis-calc.ts`, Endpunkte `GET /finance/portfolio/analysis` und `GET|PUT /finance/portfolio/settings` in `finance/portfolio-analysis.ts`, Abschnitt `components/finance/PortfolioAnalysis.vue` auf der Portfolio-Seite, Sparpläne der Position in `savings_plans` der Positionsseite. **Alle Etappen umgesetzt.**
- **Wertpapier-Stamm, Depotauszüge, KI zuerst** (Wertpapiere je Depot nur nach Bestätigung — Bank-Bestand automatisch, Fundstellen aus Buchungen/Belegen als Vorschlag unter „Zu prüfen“; Depotauszüge und Reportings als Bestandsstände; die KI liest, die Regeln prüfen): `documentation/plans/wertpapier-stamm.md` (Plan auf Englisch). **Alle drei Etappen umgesetzt**: Stamm (#1518), Depotauszüge als Bestand (#1520, `finance/depot-statement-parser.ts`, `depot-statement-enrichment.ts`), KI zuerst (Merge mit Verankerung im Text, Papiersorten-Frage in `finance/depot-paper-type.ts`).
- **KI-Assistent über alle Daten** (ein Chat, der Fragen über Finanzen, Dokumente, Fotos, Zähler und Reisen beantwortet; das Modell kennt den ganzen Werkzeugkatalog aus der OpenAPI-Spezifikation und ruft nur bestehende Service-Funktionen über `~encore/clients` als der fragende Nutzer auf, nie SQL; Schreibaktionen als bestätigungspflichtige Vorschläge; Arbeitsergebnisse als Sammelmappen (auch Regel-Mappen von Buchungen mit Zwischensummen) und Dokumente, darunter geschwärzte PDF-Bündel, Berichte mit Zwischensummen und Anschreiben aus ausgewähltem Kontext; Tool-Calling über den lokalen llama-server; Streaming per `api.streamOut`): `documentation/plans/ki-assistent.md` (Plan auf Englisch), Sammel-Issue #1524, Etappen #1525–#1534. Etappe 1 umgesetzt: `POST /chat` im llm-service (`llm-service/chat.py`, Tool-Calling über llama-server, JSON-Emulation auf `inproc`, Streaming als SSE) und der Benchmark `llm-service/bench/chat_bench.py`; gemessen auf dem produktiven Gemma-4-Modell am 2026-10-16 (Tabelle im Plan), die späteren Läufe stehen in `documentation/plans/assistent-wegfindung.md`. #1526 umgesetzt: `GET /finance/mandates/upcoming` (`finance/upcoming-debits.ts`) und die Seite Finanzen › Erwartete Zahlungen (Lastschriften und Überweisungen, Kanalfilter, nie Karte oder Bargeld; Werkzeug `upcoming_payments`). #1527 umgesetzt: Dienst `assistant/` (Unterhaltungen, `POST /assistant/conversations/:id/ask` führt die Agent-Schleife `agent.ts` aus, `GET /assistant/turns/:turnId/stream` schaut nur zu, weil ein WebSocket-Token nur Media-Rechte hat; die Web-App startet eine Frage über `POST /assistant/conversations/:id/turns`, das sofort zurückkehrt, und liest die Antwort samt `message_id` nur aus dem Stream (eine offen gehaltene Anfrage bricht Cloudflare nach 100 s mit 524 ab), der Stream sendet alle 25 s ein `ping` und wird nach einem Abriss mit `resume=true` neu geöffnet (`askStreaming` in `frontend/src/api/assistant.ts`); Katalog `catalog.ts` aus handgeschriebenen Tools in `assistant/tools/` plus Einträgen aus `openapi/spec.json` über `tool-allowlist.ts`). #1528 umgesetzt: Seite `/assistent` (`views/AssistantView.vue`, Komponenten unter `components/assistant/`, Ereignisse eines Laufs in `utils/assistantTurn.ts`), Chat-Symbol in der Kopfzeile, Recht `module.assistant` über die eigene Rolle „Assistent User“ (#1648; einmaliger Backfill für alle mit einer Modulrolle, danach unabhängig vergeben; der Systemprompt nennt die Bereiche mit und ohne Berechtigung, `assistant/access.ts`). #1529 umgesetzt: Schreibaktionen nur als Vorschläge (`assistant/proposals.ts`, Tabelle `assistant_proposal`, Werkzeuge in `assistant/tools/writes.ts`), ausgeführt erst über `POST /assistant/proposals/:id/execute` als der Nutzer; Karte `components/assistant/ProposalCard.vue`. Ein Schritt, der das Ergebnis einer Karte braucht, wartet auf „Ausführen“ statt zu scheitern: er steht als `continuation` an der Karte (Argument `after_execute`, das jedes Schreibwerkzeug ohne Eintrag im Schema nimmt, sonst die offenen Planschritte), und nach „Ausführen“ fragt die Seite den Assistenten selbst weiter (`utils/proposalEffects.ts`, das auch die App-Caches wie die Albenliste verwirft); spätere Runden lesen jede Karte im Stand von jetzt (`currentProposalText` in `assistant/proposals.ts`), nie als „NOT executed“. #1530 umgesetzt: Rückfragen auf frühere Ergebnisse (`from_previous_result` je Typ, Notiz der Werkzeuge hinter jeder früheren Antwort im Verlauf, Spalten `digest`/`result_ref` an `assistant_message`), Titel aus der ersten Frage im Hintergrund (`assistant/titles.ts`). #1531 umgesetzt: Wortpositionen je Seite in `document_page_words` (geschrieben von text_extract in derselben Transaktion wie `extracted_text`, Suche mit `findTextBoxes` in `documents/page-words-store.ts`, Backfill über den Queue-Dienst `page_words`); der Textlayer wird mit `pdfjs-dist` gelesen, nicht mehr mit `pdf-parse`. #1532 umgesetzt: geschwärzte Bündel — `find_text_in_document`, `create_collection` (Werte statt Rechtecke, Boxen über `GET /documents/:id/text-boxes`) und `build_collection_pdf` in `assistant/tools/`. #1533 umgesetzt: Bericht in Gruppen mit Zwischensummen und Rendite — Werkzeug `transaction_report`, Rechnung in `finance/grouped-report.ts`, Endpunkte und Tabelle `finance_grouped_report` in `finance/grouped-report-api.ts`, PDF `createGroupedReportPdf` in `finance/pdf-report.ts`. #1534 umgesetzt: Arbeitskontext je Unterhaltung (`assistant_conversation.context`, Briefe der Objekte in `assistant/briefs.ts`, Einstieg über `/assistent?context=…` aus den Auswahlleisten und „Antwort entwerfen“), Werkzeuge `get_document_text` und `render_letter` (`assistant/tools/letters.ts`, DIN-5008-PDF in `assistant/letter-pdf.ts`, Lücken als `[[…]]`, Karte editierbar über `LetterEditor.vue`, Fotos als Seiten hinter dem Brief über `assistant/letter-photos.ts`), abgelegt über `POST /documents/generated` mit Verknüpfung in `document_links` (Gruppe „Antwort und Bezug“ im Panel „Verwandte Dokumente“). Ob das geladene Modell Fragen annimmt, entscheidet sein letzter Benchmark-Lauf auf demselben Gerät (`assistant/model-gate.ts`, mindestens 85 % über `ASSISTANT_MIN_PASS_RATE`, auf der CPU mit Hinweis „langsamer“, ungemessen mit Hinweis, darunter lehnt `ask` ab; `GET /assistant/model-gate` für die Seite). Benchmark auf Knopfdruck: Dokumente › Einstellungen › KI-Benchmark (`assistant/benchmark.ts`, Fälle in `assistant/bench/cases.ts`, Läufe in `assistant_benchmark_run`) — läuft durch die echte Agent-Schleife mit festen Werkzeugergebnissen; ein neues Werkzeug bekommt dort einen Fall. Summen über Buchungen rechnet `transaction_totals` (Filter und Suche der Buchungsliste, Zwischensummen je Tag, Monat, Quartal oder Jahr, `POST /finance/transactions/totals` in `finance/transaction-totals-api.ts`, Rechnung in `finance/transaction-totals.ts`); `create_transaction_folder` schlägt daraus eine Regel-Sammelmappe vor, deren Regel die Gruppierung als `totals` mitträgt und deren Seite die Summen zeigt (`components/finance/CollectionTotalsPanel.vue`). Die frühere Analyse-Seite (`finance/analysis.ts`, gespeicherte Analysen) gibt es nicht mehr. Was `from_previous_result` aus einer Liste nimmt, sagt die Liste selbst: hat der Aufruf ausgewählt (Rangfolge, `limit`, Gruppen, `distinct`), die Auswahl, sonst alle Treffer; eine am Lesedeckel abgeschnittene Treffermenge trägt `truncated` am `ResultRef`, und ein Schreibwerkzeug lehnt sie ab statt still die ersten 2000 zu nehmen. „Je Person und Monat“ ist ein Aufruf (`group_by` plus `then_by`, `group_by person` liest je Person); Datumsgruppen sind in jedem Listenwerkzeug dieselben (`year`, `quarter`, `month`, `week`, `day` über `dateKey` in `tools/ranking.ts`); die Zusammenfassung eines Listenwerkzeugs nennt seine Gruppen über `groupSummary` aus derselben Tabelle wie `group_by`, nie als eigene Aufzählung; nennt die Frage eine Gruppe („je Tag“, „pro Monat“, „für jede Person“) und ein Listenwerkzeug mit dieser Gruppe läuft ohne sie, weist die Schleife den Aufruf einmal ab (`groupGuard` in `agent.ts`); stößt eine gruppierte Liste an den Lesedeckel, liest sie den Zeitraum in Teilen nach (Jahre, dann Monate, dann Tage, `readComplete` in `tools/photos.ts`; der Deckel liegt eins unter dem Maximum des Endpunkts, sonst gilt eine volle Lesung als vollständig), damit keine Gruppe fehlt, „nicht zu ähnlich“ ist `distinct` (derselbe Schnitt wie im Fotobuch, `thinSimilar`). Unter einer Vorschlagskarte klappen die Zwischenlisten der Antwort zu (Web und iOS). Hat ein Werkzeug in derselben Antwort ausgewählt (`ResultRef.picked`, `ctx.pickedThisTurn`), lehnt ein Schreibwerkzeug einen Filter ab und verlangt `from_previous_result` — der Filter nähme alle Treffer statt der Auswahl. Eine Antwort ohne Werkzeug gibt ihr Thema weiter: der Router erbt die Bereiche der letzten Runde mit Werkzeugen (`areasOfLastTurn`).
- **Assistent: Wegfindung** (warum der Assistent den falschen Weg nimmt und wie die großen Anbieter das lösen — Router in Fachbereiche mit eigenem Werkzeugsatz und Regelblock statt 47 Werkzeuge in jeder Runde, Werkzeugergebnisse mit Hinweisen bei 0 Zeilen und Fehlern, Plan bei Mehrbereichsfragen, Verlauf als Zusammenfassung, Prüfer statt Regex; jede Etappe wird am Benchmark gemessen): `documentation/plans/assistent-wegfindung.md` (Plan auf Englisch). Etappe 1 umgesetzt: Bereiche als Daten in `assistant/areas/` (neun Bereiche mit Werkzeugen, geliehenen Werkzeugen, Regelblock, Beispielen und Stichwörtern; jedes Werkzeug hat genau eine Heimat), Router in `assistant/router.ts` (Stichwörter → Vortext/Arbeitskontext → kurzer Modellaufruf mit `choose_areas`; sonst alle Bereiche wie bisher), der Systemprompt beginnt mit dem festen Teil und trägt nur die Regeln, Werkzeuge und Beispiele der gewählten Bereiche, `switch_area` und `describe_tools` holen weitere nach, ein beim Namen gerufenes Werkzeug eines anderen Bereichs läuft und holt seinen Bereich dazu. Eine neue Regel oder ein neues Beispiel für einen Bereich gehört in dessen Datei, nie in `GENERAL_RULES`; ein neues Werkzeug braucht genau einen Heimatbereich. Etappe 2 umgesetzt: die Schleife prüft jeden Aufruf vor dem Lauf gegen das Schema des Werkzeugs (`assistant/arguments.ts`: unbekannte Argumente mit Vorschlag, Pflichtfelder, Typen, Enums, Datum als Tag) und gibt statt eines Laufs einen Fehler zurück, der das Argument und die erlaubten Werte nennt; `list_transactions`, `search_documents` und `list_photos` sagen bei 0 Zeilen, welcher Filter die Zeilen ausschließt und wie viele es ohne ihn wären (`assistant/tools/hints.ts`, `ToolOutcome.hint`), jedes andere Werkzeug mit Filtern bekommt den allgemeinen Hinweis der Schleife. Ein neues Listenwerkzeug mit Filtern liefert bei 0 Zeilen einen `hint` über `loosenHint`; ein Argument, das ein Werkzeug liest, steht in seinem Schema, sonst weist die Prüfung den Aufruf ab. Etappe 6 (Messen) Teil 1 umgesetzt: Weg-Metriken im Benchmark (`first_tool`, `rounds`, `nudges`, `prompt_tokens_first` je Fall, `firstTools` am Fall, `first_tool_hit_rate` in der Zusammenfassung), Daumen hoch/runter unter jeder gespeicherten Antwort (`assistant/feedback.ts`, Tabelle `assistant_feedback` mit Frage, Werkzeugspur ohne Zeileninhalt und Antwort; Liste mit Fallgerüst auf der KI-Benchmark-Seite, nur `data.manage`). Etappe 3 umgesetzt: der Router setzt `needsPlan` (zwei Bereiche, Kettenwörter wie „und dann“, „und mach daraus“ über `hasChainWords`, oder `needs_plan` des Modells); die Schleife macht dann vor dem ersten Werkzeug einen Aufruf, der auf das Werkzeug `write_plan` gebunden ist (1–4 Schritte, `tool` als Enum der angebotenen Werkzeuge), trägt den Plan als Werkzeugrunde im Verlauf, hakt nach jeder Runde die gelaufenen Schritte ab und hängt den Stand ans letzte Ergebnis der Runde; eine Antwort mit offenen Schritten geht einmal zurück. `write_plan` bleibt in jeder Runde in der Werkzeugliste (Prompt-Cache). `/chat` reicht `response_format` (nur ohne Werkzeuge) und `thinking` an llama-server durch; `ASSISTANT_PLAN_THINKING=1` lässt das Modell vor dem Plan denken. Benchmark: `plan_asked`, `plan`, `plan_done` je Fall, `multi_area_pass_rate` und `median_rounds_multi_area` in der Zusammenfassung, drei Mehrbereichs-/Ketten-Fälle. Etappe 4 umgesetzt: nach jeder Antwort schreibt das Modell im Hintergrund (Aufruf gebunden an `summarize_turn`, `assistant/summary.ts`) eine Zusammenfassung der Runde in `assistant_message.summary`; `history()` spielt die neuesten `WHOLE_TURNS` (3) Runden ganz zurück und jede ältere Runde mit Zusammenfassung als Frage plus Zusammenfassung mit Werkzeug-Notiz statt der Werkzeugrunden (Zeilen bleiben über `from_previous_result` erreichbar); `summarizedTurns` in `ContextUsage`, `follow_up_pass_rate` im Benchmark. Spaltenauswahl je Frage absichtlich nicht gebaut (Begründung im Plan); `LLM_KV_TYPE=q8_0` und ein größeres `LLM_CTX` misst Anton am GPU-Benchmark. Etappe 5 umgesetzt: nach jeder Antwort über Nutzerdaten, die die Regex-Vorfilter passiert hat, ein kurzer Aufruf gebunden an `check_answer` (`assistant/verify.ts`: Frage, Werkzeugergebnisse der Runde, Antwort, Bereiche) — eine Angabe, die kein Ergebnis hält, geht einmal mit dem Satz des Prüfers zurück, ein falscher Bereich holt den richtigen einmal dazu, nach zwei gescheiterten Prüfungen geht die Antwort mit dem Hinweis „konnte ich nicht in den gelesenen Daten belegen“ hinaus; `ASSISTANT_VERIFY=0` schaltet den Prüfer ab, `runTurn` hat ihn über `verify` standardmäßig aus; Benchmark `checks`/`check_failed`/`check_ms`/`unverified` je Fall, `median_check_ms` in der Zusammenfassung. Ein gebundener Werkzeugaufruf (`tool_choice` mit Funktionsname) geht im llm-service an llama-server als genau dieses eine Werkzeug mit `required`, weil llama-server das Objekt sonst als „auto“ liest (Messlauf 26.10.: 2 von 19 Plänen); ein echter Werkzeugaufruf statt des Plans läuft als Runde 1. Zweiter Messlauf 26.10. abends: 90 % auf den 68 Fällen des Vormittags (85 % davor), Prüfer 1,3 s je Antwort. Dritter Lauf 27.10. mit dem Fix: Plan 13 von 13; sechs Fälle verlor llama-servers Gemma-4-Parser in Runde 1 („does not match the expected peg-gemma4 format“, llama.cpp #25072, sporadisch) — die Schleife fordert eine solche Antwort einmal neu an (`MalformedReplyError`, `malformed_replies` im Benchmark). Vierter Lauf 27.10. nachmittags: dieselben sechs Fälle fielen trotz Wiederholung, und es sind genau die sechs Plan-Aufrufe, die nicht zurückkamen — die Grammatik des gebundenen Aufrufs (`tool_choice: required`) lässt auf Gemma 4 das Ende des Aufrufs frei (llama.cpp #29089, Fix #29115 in Builds ab 19.09.2026, dazu #30256), deterministisch je Prompt; ein gebundener Aufruf, den der Parser verwirft, geht deshalb einmal ohne Grammatik als das eine Werkzeug (`unbound` in `agent.ts`), ein gewöhnlicher Aufruf wird schlicht wiederholt. Fünfter Lauf 27.10. abends mit llama.cpp v0.7.0 (`LLAMA_CPP_REF` in `llm-service/Dockerfile.gpu`): 68 von 75 (91 %), Plan 19/19, `malformed_replies` 0 — die Grammatik hält auf diesem Build. Die sieben Fehlfälle danach je an ihrer Ursache behoben (Abschnitt „The last seven cases“ im Plan): der Hinweis bei leerem Ergebnis nennt den Filter, der fallen soll (`loosenHint`, Probe mit `recommend: false` wird nie empfohlen); nach der Nachfrage auf eine leere Runde gilt die nächste Wortantwort als erster Entwurf (Daten-Nudge); `position_news`/`position_detail` lösen einen Namen zum Key auf, `portfolio_overview(q)` nimmt einen Depotnamen; Beispiele in Depot, Fotos („die wenigsten“ = `direction: "asc"`), Dokumente (Kauf = Dokumente plus Buchungen mit `switch_area`) und Schreiben (jede vom Nutzer genannte Angabe steht im Brieftext); `anyOf` an `ExpectedCall` für Fälle mit zwei richtigen Wegen. Sechster Lauf 28.10.: 71 von 75 (95 %) — die drei Werkzeug-/Schleifen-Fixes hielten, die drei reinen Beispiel-Fixes bewegten das Modell nicht; deshalb jetzt deterministisch: `list_transactions` hatte `direction` doppelt (Geldrichtung und Sortierung, Bug seit #1728, jede `direction: "out"` wurde abgewiesen) — die Sortierung heißt dort `order`; `rank_by` ohne Richtung wird vom Werkzeug abgewiesen (`parseRanking`); die Schleife hält den nächsten Aufruf nach einem leeren Ergebnis an dessen Rat (`loosenGuard` in `agent.ts`, `loosen` am `ToolOutcome` aus `loosenAdvice`); der Prüfer liest den Aufruf eines Schreibwerkzeugs als den Vorschlag selbst. Siebter Lauf 28.10. mittags: 68 von 75 (91 %) — vier Fälle fielen auf die verschärfte Erwartung „rank_by mit Richtung“, weil `parseRanking` im Werkzeug sitzt und der Benchmark kein Werkzeug laufen lässt (`cannedTools`); die Pflicht steht deshalb jetzt als `dependentRequired` im Schema (`rankRequires` in `tools/ranking.ts`) und `checkArguments` prüft sie in der Schleife vor jedem Lauf, das Modell sieht das Schlüsselwort nicht (`modelSchema` in `catalog.ts`); ein nacktes „Ja.“ auf eine Frage der vorigen Antwort, das ohne Aufruf beantwortet wird, geht einmal mit der zitierten Frage zurück (`isBareYes`, `openQuestion`, `yesNudge` in `agent.ts`); `render_letter` nennt in der Notiz des Vorschlags die Daten, Beträge und Referenznummern aus den in dieser Runde gelesenen Texten, die im Brief fehlen (`factsLeftOut`, über `ToolContext.turnResults`); ein Fixture-`hint` im Benchmark darf eine Funktion der Argumente sein. Eine Regel, die nur das Werkzeug prüft, prüft der Benchmark nicht: was die Schleife vor dem Lauf prüfen kann, gehört ins Schema. Achter Lauf 28.10. nachmittags: 75 von 75 (100 %) — die Schema-Ablehnung korrigiert das Modell in einer Extrarunde (`tool_errors` 1, die Beschreibung „required with rank_by“ allein bewegt es nicht), das nackte „Ja.“ führt nach einem Nudge zum Taggen, der Brief nennt Frist und Referenz nach der Notiz aus `factsLeftOut`, Plan 19/19, `malformed_replies` 0, Prüfer zweimal falsch angeschlagen (`check_failed` 2, beide bestanden), Median 3 Runden, 4.402 Prompt-Tokens. Etappe 6 Teil 2 umgesetzt: Datenquelle „Synthetisch“ auf der KI-Benchmark-Seite (`data: "synthetic"` an `POST /assistant/benchmark/runs`, `keep_data`, `DELETE /assistant/benchmark/synthetic-data`) — Seeder und Fälle `syn-*` in `assistant/bench/synthetic.ts`, Benchmark-Konto `assistant-benchmark@system.local` besitzt alle gesäten Zeilen (Register `assistant_benchmark_seed`), der Start übergibt an den internen Endpunkt `launchSyntheticRun` mit dem Konto als `authData`, jeder Lauf beginnt mit dem Selbsttest `verifySight` (listAccounts muss genau die gesäten Konten zeigen, sonst scheitert der Lauf vor dem ersten Fall); Werkzeuge laufen echt (`realTools` im Runner), Fotos ausgelassen. Erster synthetischer Lauf 30.10.: 10 von 10, die Übergabe an das Konto hält (Selbsttest bestanden). Lauf auf dem CPU-Zwilling 29.10. mit festen Ergebnissen: 71 von 75 — zwei Fälle am Zeitlimit der CPU-Konfiguration (`terminated`, dann 503 „inference busy“; ungecachter Prompt 70–210 s), zwei Grenzentscheidungen anders gekippt; der Zwilling braucht ein höheres `request_timeout_s`. Vergleichslauf 30.10. nachts mit Qwen3.6-35B-A3B UD-Q5_K_M (18,5k Kontext): 69 von 75 — zwei Fälle passten nicht ins Kontextfenster, dazu falsches Jahr, Rückfrage neu gesucht statt `from_previous_result`, Lücke im Brief an falscher Stelle; Prüfer 15-mal statt 2-mal angeschlagen; Gemma 4 bleibt das Modell. Die Embedding-Stufe des Routers bleibt offen. Ein Fehlfall aus dem Alltag wird zum Benchmark-Fall erst, nachdem jeder echte Wert durch einen erfundenen ersetzt ist.
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
