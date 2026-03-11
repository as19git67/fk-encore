import Database, { type Database as DatabaseType } from "better-sqlite3";
import path from "path";
import fs from "fs";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS user_roles (
    user_id INTEGER NOT NULL,
    role_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, role_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
  );
`;

function initDb(database: DatabaseType): void {
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA);
}

function createDb(): DatabaseType {
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST;

  if (isTest) {
    const database = new Database(":memory:");
    initDb(database);
    return database;
  }

  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, "app.db");
  const database = new Database(dbPath);
  database.pragma("journal_mode = WAL");
  initDb(database);
  return database;
}

const db: DatabaseType = createDb();

export default db;

