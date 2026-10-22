import { PBKDF2_ITERATIONS } from "./config.js";

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export const fromHex = (hex) => Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16));

export async function sha256Hex(text) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

// Passwords are never stored: only a salted PBKDF2 hash of each one.
async function derive(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return new Uint8Array(bits);
}
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: toHex(salt), hash: toHex(await derive(password, salt)) };
}
export async function checkPassword(password, saltHex, hashHex) {
  const got = await derive(password, fromHex(saltHex));
  const want = fromHex(hashHex);
  return got.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(got, want);
}
// Used so a login for a name that doesn't exist takes as long as a real one.
export async function fakeCheck(password) {
  await derive(password, new Uint8Array(16));
  return false;
}

export const randomToken = () => toHex(crypto.getRandomValues(new Uint8Array(32)));

// Constant-time comparison for secrets.
export function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}
