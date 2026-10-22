// Settings for the site accounts. Everything you might want to tune is here.
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 16; // the chat shows names up to 16 characters
export const USERNAME_RE = /^[\p{L}\p{N}_-]+$/u; // letters, numbers, - and _ (no spaces)
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const PBKDF2_ITERATIONS = 100000; // the most Cloudflare Workers allows

export const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // a login lasts this long
export const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000; // ...and is extended when used after this long
export const MAX_SESSIONS_PER_USER = 10; // older logins beyond this are removed

export const MAX_FAILS = 5; // wrong passwords before the account locks
export const LOCK_MS = 15 * 60 * 1000;
export const MAX_USERS = 5000;

// Fixed-window limits per visitor address (the address is stored only as a salted hash).
export const LIMITS = {
  login: { n: 20, windowMs: 10 * 60 * 1000 },
  register: { n: 5, windowMs: 60 * 60 * 1000 },
  password: { n: 10, windowMs: 10 * 60 * 1000 },
  admin: { n: 60, windowMs: 10 * 60 * 1000 }, // per address, for the owner's admin calls
  event: { n: 120, windowMs: 60 * 60 * 1000 }, // per user
  progress: { n: 600, windowMs: 60 * 60 * 1000 }, // per user
};

export const MAX_BODY_BYTES = 4096;
export const MAX_QUEST_STATE_CHARS = 2000;
