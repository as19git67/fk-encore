import { defineConfig } from "drizzle-kit";

const isPg = process.env.DB_TYPE?.toLowerCase() === 'postgres';

export default defineConfig({
  dialect: isPg ? "postgresql" : "sqlite",
  schema: "./db/schema.ts",
  out: isPg ? "./db/migrations/postgres" : "./db/migrations/sqlite",
  dbCredentials: isPg ? {
    host: process.env.POSTGRES_HOST || "localhost",
    port: Number(process.env.POSTGRES_PORT) || 5432,
    user: process.env.POSTGRES_USER || "postgres",
    password: process.env.POSTGRES_PASSWORD || "postgres",
    database: process.env.POSTGRES_DATABASE || "fk_encore",
    ssl: false,
  } : {
    url: "./data/app.db",
  },
});
