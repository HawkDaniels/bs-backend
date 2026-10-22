import { LIMITS, MAX_BODY_BYTES, SESSION_MS } from "./config.js";
import { sha256Hex, safeEqual } from "./crypto.js";
import {
  cleanUsername, usernameProblem, passwordProblem, createUser, findByName, verifyPassword, createSession,
  sessionUser, endSession, endAllSessions, setPassword, deleteUser, listUsers, countUsers, getUserById,
} from "./users.js";
import { award, achievementsOf, achievementStats, publicDefs, questStates, saveQuest, reportEvent } from "./progress.js";

const SECURITY = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" };

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY, ...headers },
  });
}
const fail = (error, status, extra = {}) => json({ ok: false, error, ...extra }, status);

// The messages people see. Kept generic on purpose: a failed login never says which half was wrong.
const STATUS = {
  bad_username: 400, bad_password: 400, bad_request: 400, bad_state: 400, unknown_quest: 404, unknown_event: 404,
  username_taken: 409, name_unavailable: 409, closed: 403, bad_login: 401, locked: 429, slow_down: 429,
  not_logged_in: 401, forbidden: 403, bad_captcha: 400, unsupported: 415, too_big: 413,
};

// ---- cookies ----
// On https the cookie is named __Host-sid, which browsers only accept if it is Secure, has Path=/ and no Domain.
const cookieName = (url) => (url.protocol === "https:" ? "__Host-sid" : "sid");
function readCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
function setCookie(url, token, maxAgeSeconds) {
  return `${cookieName(url)}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}`;
}
const sessionCookie = (url, token) => ({ "Set-Cookie": setCookie(url, token, Math.floor(SESSION_MS / 1000)) });
const clearCookie = (url) => ({ "Set-Cookie": setCookie(url, "", 0) });

// ---- request checks ----

// A cookie-carrying POST must come from this site (or a listed one), so another site can't act for a visitor.
function originOk(request, url, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  let o;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (o.host === url.host) return true;
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((x) => x.trim().replace(/\/+$/, "").toLowerCase())
    .filter(Boolean)
    .includes(o.origin.toLowerCase());
}

async function readJson(request) {
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) return { error: "unsupported" };
  if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY_BYTES) return { error: "too_big" };
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { error: "too_big" };
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? { body: v } : { error: "bad_request" };
  } catch {
    return { error: "bad_request" };
  }
}

// Fixed-window counter. Returns true while the caller is within the limit.
async function within(db, key, { n, windowMs }) {
  const now = Date.now();
  const row = await db
    .prepare(
      "INSERT INTO throttle (k, n, start) VALUES (?1, 1, ?2) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN ?2 - start >= ?3 THEN 1 ELSE n + 1 END, start = CASE WHEN ?2 - start >= ?3 THEN ?2 ELSE start END RETURNING n"
    )
    .bind(key, now, windowMs)
    .first();
  if (Math.random() < 0.02) await db.prepare("DELETE FROM throttle WHERE start < ?").bind(now - 2 * 24 * 60 * 60 * 1000).run();
  return !row || row.n <= n;
}
const ipKey = async (env, request) => sha256Hex(`${env.IP_SALT || ""}|${request.headers.get("CF-Connecting-IP") || "unknown"}`);

// Optional "I'm not a robot" check on sign-up. Turned on by setting the TURNSTILE_SECRET secret.
async function turnstileOk(env, token, request) {
  if (!env.TURNSTILE_SECRET) return true;
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  try {
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET);
    form.append("response", token);
    const ip = request.headers.get("CF-Connecting-IP");
    if (ip) form.append("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    return !!(await r.json()).success;
  } catch {
    return false;
  }
}

// The only fields ever sent about a user.
const publicUser = (u) => ({ username: u.username });

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.startsWith("/api/")) return null;
  if (!env.DB) return fail("not_configured", 503);
  const db = env.DB;
  const method = request.method;

  try {
    const token = readCookie(request, cookieName(url));
    const me = token ? await sessionUser(db, token) : null;

    // ---- account management for the site owner: needs the admin token, not a login cookie ----
    if (path.startsWith("/api/admin/")) {
      if (!env.ADMIN_TOKEN) return fail("not_found", 404);
      if (!(await within(db, "adm:" + (await ipKey(env, request)), LIMITS.admin))) return fail("slow_down", 429);
      if (!safeEqual(request.headers.get("Authorization") ?? "", `Bearer ${env.ADMIN_TOKEN}`)) return fail("forbidden", 403);
      if (path === "/api/admin/users" && method === "GET") {
        const rows = await listUsers(db, 500);
        return json({ ok: true, total: await countUsers(db), users: rows.map((u) => ({ id: u.id, username: u.username, createdAt: u.created_at, lastLogin: u.last_login })) });
      }
      if (path === "/api/admin/reset-password" && method === "POST") {
        const r = await readJson(request);
        if (r.error) return fail(r.error, STATUS[r.error]);
        if (passwordProblem(r.body.password)) return fail("bad_password", 400);
        const row = typeof r.body.username === "string" ? await findByName(db, cleanUsername(r.body.username)) : null;
        if (!row) return fail("not_found", 404);
        await setPassword(db, row.id, r.body.password); // also clears any lockout
        await endAllSessions(db, row.id, "");
        return json({ ok: true });
      }
      if (path === "/api/admin/delete-user" && method === "POST") {
        const r = await readJson(request);
        if (r.error) return fail(r.error, STATUS[r.error]);
        const id = Number(r.body.id);
        if (!Number.isSafeInteger(id) || id < 1 || !(await getUserById(db, id))) return fail("not_found", 404);
        await deleteUser(db, id);
        return json({ ok: true });
      }
      return fail(method === "GET" || method === "POST" ? "not_found" : "method_not_allowed", method === "GET" || method === "POST" ? 404 : 405);
    }

    // Everything that changes something must come from our own pages.
    if (method !== "GET" && method !== "HEAD" && !originOk(request, url, env)) return fail("forbidden", 403);

    // ---- public ----
    if (path === "/api/defs" && method === "GET") {
      return json({ ok: true, ...publicDefs() }, 200, { "Cache-Control": "public, max-age=300" });
    }
    if (path === "/api/achievements/stats" && method === "GET") {
      return json({ ok: true, ...(await achievementStats(db)) }, 200, { "Cache-Control": "public, max-age=60" });
    }

    if (path === "/api/me" && method === "GET") {
      if (!me) return json({ ok: true, user: null, achievements: [] });
      return json({ ok: true, user: publicUser(me), achievements: await achievementsOf(db, me.id) });
    }

    if (path === "/api/register" && method === "POST") {
      if (!(await within(db, "reg:" + (await ipKey(env, request)), LIMITS.register))) return fail("slow_down", 429);
      const r = await readJson(request);
      if (r.error) return fail(r.error, STATUS[r.error]);
      const username = cleanUsername(r.body.username);
      const password = r.body.password;
      const bad = usernameProblem(username) || passwordProblem(password);
      if (bad) return fail(bad, 400);
      if (!(await turnstileOk(env, r.body.turnstile, request))) return fail("bad_captcha", 400);
      const made = await createUser(db, username, password);
      if (made.error) return fail(made.error, STATUS[made.error]);
      const earned = await award(db, made.user.id, { type: "register" });
      if (me) await endSession(db, me.hash);
      const s = await createSession(db, made.user.id);
      return json({ ok: true, user: publicUser(made.user), earned }, 201, sessionCookie(url, s.token));
    }

    if (path === "/api/login" && method === "POST") {
      if (!(await within(db, "login:" + (await ipKey(env, request)), LIMITS.login))) return fail("slow_down", 429);
      const r = await readJson(request);
      if (r.error) return fail(r.error, STATUS[r.error]);
      const username = cleanUsername(r.body.username);
      const row = typeof r.body.username === "string" && username.length <= 64 ? await findByName(db, username) : null;
      const v = await verifyPassword(db, row, r.body.password);
      if (v.error) return fail(v.error, STATUS[v.error]);
      if (me) await endSession(db, me.hash); // a new login replaces the old one
      const s = await createSession(db, row.id);
      return json({ ok: true, user: publicUser(row), achievements: await achievementsOf(db, row.id) }, 200, sessionCookie(url, s.token));
    }

    if (path === "/api/logout" && method === "POST") {
      if (me) {
        await endSession(db, me.hash);
      }
      return json({ ok: true }, 200, clearCookie(url));
    }

    // ---- everything below needs a login ----
    const needLogin = path === "/api/password" || path === "/api/delete-account" || path === "/api/progress" ||
      path.startsWith("/api/progress/") || path === "/api/event";
    if (needLogin && !me) return fail("not_logged_in", 401);

    if (path === "/api/password" && method === "POST") {
      if (!(await within(db, "pw:" + me.id, LIMITS.password))) return fail("slow_down", 429);
      const r = await readJson(request);
      if (r.error) return fail(r.error, STATUS[r.error]);
      if (passwordProblem(r.body.next)) return fail("bad_password", 400);
      const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(me.id).first();
      const v = await verifyPassword(db, row, r.body.current);
      if (v.error) return fail(v.error === "locked" ? "locked" : "bad_login", STATUS[v.error]);
      await setPassword(db, me.id, r.body.next);
      await endAllSessions(db, me.id, me.hash); // every other device is signed out
      return json({ ok: true });
    }

    if (path === "/api/delete-account" && method === "POST") {
      if (!(await within(db, "pw:" + me.id, LIMITS.password))) return fail("slow_down", 429);
      const r = await readJson(request);
      if (r.error) return fail(r.error, STATUS[r.error]);
      const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(me.id).first();
      const v = await verifyPassword(db, row, r.body.password);
      if (v.error) return fail(v.error === "locked" ? "locked" : "bad_login", STATUS[v.error]);
      await deleteUser(db, me.id);
      return json({ ok: true }, 200, clearCookie(url));
    }

    if (path === "/api/progress" && method === "GET") {
      return json({ ok: true, quests: await questStates(db, me.id), achievements: await achievementsOf(db, me.id) });
    }
    if (path.startsWith("/api/progress/") && method === "PUT") {
      if (!(await within(db, "pr:" + me.id, LIMITS.progress))) return fail("slow_down", 429);
      const r = await readJson(request);
      if (r.error) return fail(r.error, STATUS[r.error]);
      const saved = await saveQuest(db, me.id, decodeURIComponent(path.slice("/api/progress/".length)), r.body.state);
      if (saved.error) return fail(saved.error, STATUS[saved.error]);
      return json({ ok: true, state: saved.state, earned: saved.earned });
    }

    if (path === "/api/event" && method === "POST") {
      if (!(await within(db, "ev:" + me.id, LIMITS.event))) return fail("slow_down", 429);
      const r = await readJson(request);
      if (r.error) return fail(r.error, STATUS[r.error]);
      const res = await reportEvent(db, me.id, r.body.event);
      if (res.error) return fail(res.error, STATUS[res.error]);
      return json({ ok: true, earned: res.earned });
    }

    const known = ["/api/me", "/api/register", "/api/login", "/api/logout", "/api/password", "/api/delete-account", "/api/progress", "/api/event", "/api/defs", "/api/achievements/stats"];
    if (known.includes(path) || path.startsWith("/api/progress/")) return fail("method_not_allowed", 405);
    return fail("not_found", 404);
  } catch (e) {
    console.error("api error:", e && e.message);
    return fail("server_error", 500);
  }
}
