import "dotenv/config";
import bcrypt from "bcryptjs";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db.js";
import { compileTrace } from "./compiler.js";

const app = express(); const port = Number(process.env.PORT ?? 8787); const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) throw new Error("JWT_SECRET is required.");
const origins = (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean);
app.use(cors({ origin: (origin, done) => !origin || origins.includes(origin) ? done(null, true) : done(new Error("Origin not allowed")), credentials: false })); app.use(express.json({ limit: "4mb" }));
type Identity = { userId: string; email: string }; type AuthRequest = Request & { identity?: Identity };
function token(identity: Identity): string { return jwt.sign(identity, jwtSecret!, { expiresIn: "7d" }); }
function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void { const value = req.header("authorization")?.replace(/^Bearer\s+/i, ""); if (!value) { res.status(401).json({ error: "Authentication required" }); return; } try { req.identity = jwt.verify(value, jwtSecret!) as Identity; next(); } catch { res.status(401).json({ error: "Invalid or expired session" }); } }
const credentials = z.object({ email: z.string().email().max(320), password: z.string().min(12).max(256) });
app.get("/health", (_, res) => res.json({ ok: true }));
app.post("/auth/register", async (req, res, next) => { try { const { email, password } = credentials.parse(req.body); const id = randomUUID(); const hash = await bcrypt.hash(password, 12); await db.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [id, email.toLowerCase(), hash]); res.status(201).json({ token: token({ userId: id, email }), user: { id, email } }); } catch (error) { next(error); } });
app.post("/auth/login", async (req, res, next) => { try { const { email, password } = credentials.parse(req.body); const result = await db.query<{ id: string; email: string; password_hash: string }>("SELECT id, email, password_hash FROM users WHERE email = $1", [email.toLowerCase()]); const user = result.rows[0]; if (!user || !(await bcrypt.compare(password, user.password_hash))) { res.status(401).json({ error: "Invalid email or password" }); return; } res.json({ token: token({ userId: user.id, email: user.email }), user: { id: user.id, email: user.email } }); } catch (error) { next(error); } });
app.post("/compile", requireAuth, async (req: AuthRequest, res, next) => { try { const trace = req.body?.trace; if (!trace?.trace_id || !Array.isArray(trace.steps)) { res.status(400).json({ error: "A valid trace is required." }); return; } const procedure = await compileTrace(trace); await db.query("INSERT INTO procedures (procedure_id, user_id, trace_id, procedure) VALUES ($1, $2, $3, $4) ON CONFLICT (procedure_id) DO UPDATE SET procedure = EXCLUDED.procedure, updated_at = now()", [procedure.procedure_id, req.identity!.userId, trace.trace_id, procedure]); res.json({ procedure }); } catch (error) { next(error); } });
app.get("/procedures", requireAuth, async (req: AuthRequest, res, next) => { try { const result = await db.query<{ procedure: unknown }>("SELECT procedure FROM procedures WHERE user_id = $1 ORDER BY updated_at DESC", [req.identity!.userId]); res.json({ procedures: result.rows.map((row) => row.procedure) }); } catch (error) { next(error); } });
app.put("/procedures/:id", requireAuth, async (req: AuthRequest, res, next) => { try { await db.query("UPDATE procedures SET procedure = $1, updated_at = now() WHERE procedure_id = $2 AND user_id = $3", [req.body.procedure, req.params.id, req.identity!.userId]); res.json({ procedure: req.body.procedure }); } catch (error) { next(error); } });
app.use((error: unknown, _: Request, res: Response, __: NextFunction) => { console.error(error); const message = error instanceof z.ZodError ? "Invalid request." : error instanceof Error ? error.message : "Unexpected server error."; const status = /unique/i.test(message) ? 409 : 500; res.status(status).json({ error: message }); });
app.listen(port, () => console.log(`Understudy API listening on ${port}`));
