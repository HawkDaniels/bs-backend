// The chat's ONLY connection to the website's accounts.
//
// It asks one read-only question: "which username is logged in with this cookie?" It reads the
// sessions and users tables and writes nothing. The chat never creates, changes or deletes an
// account, never grants anything to one, and the website never calls the chat.

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
async function sha256Hex(text) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

// Which username is logged in for this request's cookie? Returns { name, hash } or null.
// "hash" is only used later to ask whether that same login is still valid.
export async function loggedInAs(db, cookieHeader, secure) {
  const cookieName = secure ? "__Host-sid" : "sid";
  let token = null;
  for (const part of String(cookieHeader || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === cookieName) token = part.slice(i + 1).trim();
  }
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  const row = await db
    .prepare("SELECT u.username AS username, s.expires_at AS expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?")
    .bind(hash)
    .first();
  if (!row || row.expires_at < Date.now()) return null;
  return { name: row.username, hash };
}

// Is that login still valid? (They may have logged out, changed password, or been removed.)
export async function stillLoggedIn(db, hash) {
  const row = await db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").bind(hash).first();
  return !!row && row.expires_at >= Date.now();
}
