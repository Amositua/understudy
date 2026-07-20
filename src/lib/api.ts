import type { Procedure } from "./procedure";
import type { Trace } from "./types";
export type Session = { token: string; user: { id: string; email: string } };
async function request<T>(baseUrl: string, path: string, init: RequestInit = {}, token?: string): Promise<T> { const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } }); const body = await response.json() as T & { error?: string }; if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`); return body; }
export const register = (url: string, email: string, password: string) => request<Session>(url, "/auth/register", { method: "POST", body: JSON.stringify({ email, password }) });
export const login = (url: string, email: string, password: string) => request<Session>(url, "/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
export const compile = (url: string, token: string, trace: Trace) => request<{ procedure: Procedure }>(url, "/compile", { method: "POST", body: JSON.stringify({ trace }) }, token);
export const saveProcedure = (url: string, token: string, procedure: Procedure) => request<{ procedure: Procedure }>(url, `/procedures/${procedure.procedure_id}`, { method: "PUT", body: JSON.stringify({ procedure }) }, token);
