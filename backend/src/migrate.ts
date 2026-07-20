import { db } from "./db.js";
await db.query(`CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()); CREATE TABLE IF NOT EXISTS procedures (procedure_id text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, trace_id text, procedure jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()); CREATE INDEX IF NOT EXISTS procedures_user_id_idx ON procedures(user_id);`);
await db.end();
