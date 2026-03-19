# REST API Starter

This is a RESTful API Starter with a single Hello World API endpoint.

## Prerequisites 

**Install Encore:**
- **macOS:** `brew install encoredev/tap/encore`
- **Linux:** `curl -L https://encore.dev/install.sh | bash`
- **Windows:** `iwr https://encore.dev/install.ps1 | iex`

## Create app

Create a local app from this template:

```bash
encore app create my-app-name --example=ts/hello-world
```

## Run app locally

Run this command from your application's root folder:

```bash
encore run
```
### Using the API

To see that your app is running, you can ping the API.

```bash
curl http://localhost:4000/hello/World
```

### Local Development Dashboard

While `encore run` is running, open [http://localhost:9400/](http://localhost:9400/) to access Encore's [local developer dashboard](https://encore.dev/docs/observability/dev-dash).

Here you can see traces for all requests that you made, see your architecture diagram (just a single service for this simple example), and view API documentation in the Service Catalog.

## Development

### Add a new service

To create a new microservice, add a file named encore.service.ts in a new directory.
The file should export a service definition by calling `new Service`, imported from `encore.dev/service`.

```ts
import { Service } from "encore.dev/service";

export default new Service("my-service");
```

Encore will now consider this directory and all its subdirectories as part of the service.

Learn more in the docs: https://encore.dev/docs/ts/primitives/services

### Add a new endpoint

Create a new `.ts` file in your new service directory and write a regular async function within it. Then to turn it into an API endpoint, use the `api` function from the `encore.dev/api` module. This function designates it as an API endpoint.

Learn more in the docs: https://encore.dev/docs/ts/primitives/defining-apis

### Service-to-service API calls

Calling API endpoints between services looks like regular function calls with Encore.ts.
The only thing you need to do is import the service you want to call from `~encore/clients` and then call its API endpoints like functions.

In the example below, we import the service `hello` and call the `ping` endpoint using a function call to `hello.ping`:

```ts
import { hello } from "~encore/clients"; // import 'hello' service

export const myOtherAPI = api({}, async (): Promise<void> => {
  const resp = await hello.ping({ name: "World" });
  console.log(resp.message); // "Hello World!"
});
```

Learn more in the docs: https://encore.dev/docs/ts/primitives/api-calls

### Add a database

To create a database, import `encore.dev/storage/sqldb` and call `new SQLDatabase`, assigning the result to a top-level variable. For example:

```ts
import { SQLDatabase } from "encore.dev/storage/sqldb";

// Create the todo database and assign it to the "db" variable
const db = new SQLDatabase("todo", {
  migrations: "./migrations",
});
```

Then create a directory `migrations` inside the service directory and add a migration file `0001_create_table.up.sql` to define the database schema. For example:

```sql
CREATE TABLE todo_item (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false
  -- etc...
);
```

Once you've added a migration, restart your app with `encore run` to start up the database and apply the migration. Keep in mind that you need to have [Docker](https://docker.com) installed and running to start the database.

Learn more in the docs: https://encore.dev/docs/ts/primitives/databases

### Learn more

There are many more features to explore in Encore.ts, for example:

- [Request Validation](https://encore.dev/docs/ts/primitives/validation)
- [Streaming APIs](https://encore.dev/docs/ts/primitives/streaming-apis)
- [Cron jobs](https://encore.dev/docs/ts/primitives/cron-jobs)
- [Pub/Sub](https://encore.dev/docs/ts/primitives/pubsub)
- [Object Storage](https://encore.dev/docs/ts/primitives/object-storage)
- [Secrets](https://encore.dev/docs/ts/primitives/secrets)
- [Authentication handlers](https://encore.dev/docs/ts/develop/auth)
- [Middleware](https://encore.dev/docs/ts/develop/middleware)

## Deployment

### Docker Runtime

The container runs a single `encore run` process. Encore serves both:

- the frontend SPA under `/app/`
- all API endpoints on the same origin (no reverse proxy rewrite required)

If the browser opens the container root `/`, it is redirected to `/app/`.

The container also exposes a lightweight health endpoint:

- `GET /healthz` returns `{ "status": "ok" }`
- `GET /health` returns the same payload (alias for compatibility)

Run a local container smoke-test (health + redirect + SPA index):

```bash
bash scripts/container-smoke-test.sh fk-encore:smoke
```

### Self-hosting

```
docker run -d --name my-encore-app -p 8080:8080 -e ADMIN_EMAIL=abc@example.com -e ADMIN_NAME=abc -e ADMIN_PASSWORD=secret7! -e RP_NAME="My Encore App" -e RP_ORIGIN=http://localhost:8080 -e ENABLE_LOCAL_FACES=true -e INSIGHTFACE_SERVICE_URL=http://localhost:8000 -e FACE_DISTANCE_THRESHOLD=0.45 -v /Users/example/fk-encore_data/photos:/mnt/data/photos -v /Users/example/fk-encore_data/db:/mnt/data/db fk-encore
```

## Link to GitHub

github

## Testing

To run tests, configure the `test` command in your `package.json` to the test runner of your choice, and then use the command `encore test` from the CLI. The `encore test` command sets up all the necessary infrastructure in test mode before handing over to the test runner. [Learn more](https://encore.dev/docs/ts/develop/testing)

```bash
encore test
```
