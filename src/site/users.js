import {
  USERNAME_MIN, USERNAME_MAX, USERNAME_RE, PASSWORD_MIN, PASSWORD_MAX, SESSION_MS, SESSION_REFRESH_AFTER_MS,
  MAX_SESSIONS_PER_USER, MAX_FAILS, LOCK_MS, MAX_USERS,
} from "./config.js";
import { hashPassword, checkPassword, fakeCheck, randomToken, sha256Hex } from "./crypto.js";

const one = (db, sql, ...p) => db.prepare(sql).bind(...p).first();
const all = async (db, sql, ...p) => (await db.prepare(sql).bind(...p).all()).results || [];
const run = (db, sql, ...p) => db.prepare(sql).bind(...p).run();

export const cleanUsername = (s) => String(s ?? "").normalize("NFC").trim();

export function usernameProblem(u) {
  const n = Array.from(u).length;
  if (n < USERNAME_MIN || n > USERNAME_MAX || !USERNAME_RE.test(u)) return "bad_username";
  return null;
}
export function passwordProblem(p) {
  if (typeof p !== "string") return "bad_password";
  const n = Array.from(p).length;
  return n < PASSWORD_MIN || n > PASSWORD_MAX ? "bad_password" : null;
}

export async function createUser(db, username, password) {
  const bad = usernameProblem(username) || passwordProblem(password);
  if (bad) return { error: bad };
  const count = (await one(db, "SELECT COUNT(*) AS c FROM users")).c;
  if (count >= MAX_USERS) return { error: "closed" };
  const { salt, hash } = await hashPassword(password);
  try {
    const row = await one(
      db,
      "INSERT INTO users (username, lname, pass_salt, pass_hash, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id, username",
      username, username.toLowerCase(), salt, hash, Date.now()
    );
    return { user: row };
  } catch {
    return { error: "username_taken" }; // the UNIQUE column decides, so two people can never both win
  }
}

export const findByName = (db, name) => one(db, "SELECT * FROM users WHERE lname = ?", String(name).toLowerCase());

// Checks a password with the same lockout rules everywhere. Returns { user } or { error }.
export async function verifyPassword(db, row, password) {
  if (!row) {
    await fakeCheck(String(password ?? ""));
    return { error: "bad_login" };
  }
  const now = Date.now();
  if (row.locked_until > now) {
    await fakeCheck(String(password ?? ""));
    return { error: "locked", retryMs: row.locked_until - now };
  }
  if (typeof password !== "string" || !(await checkPassword(password, row.pass_salt, row.pass_hash))) {
    const r = await one(db, "UPDATE users SET fails = fails + 1 WHERE id = ? RETURNING fails", row.id);
    if (r && r.fails >= MAX_FAILS) await run(db, "UPDATE users SET fails = 0, locked_until = ? WHERE id = ?", now + LOCK_MS, row.id);
    return { error: "bad_login" };
  }
  return { user: row };
}

// ---- sessions ----

export async function createSession(db, userId) {
  const token = randomToken();
  const th = await sha256Hex(token);
  const now = Date.now();
  await run(db, "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", th, userId, now, now + SESSION_MS);
  await run(db, "UPDATE users SET fails = 0, locked_until = 0, last_login = ? WHERE id = ?", now, userId);
  // Keep only the newest few logins per user, and sweep expired ones now and then.
  await run(
    db,
    "DELETE FROM sessions WHERE user_id = ? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)",
    userId, userId, MAX_SESSIONS_PER_USER
  );
  if (Math.random() < 0.05) await run(db, "DELETE FROM sessions WHERE expires_at < ?", now);
  return { token, hash: th };
}

// Look up a cookie value. Returns { id, username, hash } or null.
export async function sessionUser(db, token) {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
  const th = await sha256Hex(token);
  const now = Date.now();
  const row = await one(
    db,
    "SELECT u.id AS id, u.username AS username, s.expires_at AS expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
    th
  );
  if (!row) return null;
  if (row.expires_at < now) {
    await run(db, "DELETE FROM sessions WHERE token_hash = ?", th);
    return null;
  }
  if (row.expires_at - now < SESSION_MS - SESSION_REFRESH_AFTER_MS) {
    await run(db, "UPDATE sessions SET expires_at = ? WHERE token_hash = ?", now + SESSION_MS, th);
  }
  return { id: row.id, username: row.username, hash: th };
}

export const endSession = (db, hash) => run(db, "DELETE FROM sessions WHERE token_hash = ?", hash);
export const endAllSessions = (db, userId, exceptHash) =>
  run(db, "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", userId, exceptHash || "");

// ---- account changes ----

export async function setPassword(db, userId, password) {
  const { salt, hash } = await hashPassword(password);
  await run(db, "UPDATE users SET pass_salt = ?, pass_hash = ?, fails = 0, locked_until = 0 WHERE id = ?", salt, hash, userId);
}

export async function deleteUser(db, userId) {
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM achievements WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM quest_progress WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
}

export const listUsers = (db, limit = 100) =>
  all(db, "SELECT id, username, created_at, last_login FROM users ORDER BY id LIMIT ?", limit);
export const countUsers = async (db) => (await one(db, "SELECT COUNT(*) AS c FROM users")).c;
export const getUserById = (db, id) => one(db, "SELECT id, username FROM users WHERE id = ?", id);
