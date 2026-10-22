import { DurableObject } from "cloudflare:workers";
import { loggedInAs, stillLoggedIn } from "./login-check.js";

const MAX_NAME = 16;
const MAX_TEXT = 500;
const HISTORY_ON_JOIN = 50;
const INCREMENTAL_MAX = 100; // a returning page with a saved copy gets up to this many new messages; more than that and it reloads fully
const MIN_INTERVAL_MS = 700; // shortest allowed gap between one person's messages
const MAX_SLOW_MS = 60 * 60 * 1000; // longest value /slow accepts (1 hour)
const MAX_LOGIN_FAILS = 5; // failed logins on one connection before it is dropped
const EARLIER_PAGE = 50; // messages returned per "load earlier" request
const MAX_PRESENCE = 200; // names listed in the "online" popup (the count is always exact)
const LOG_CHUNK_CHARS = 200000;
const CONFIRM_ABOVE = 20; // a command touching more messages than this needs "--yes"
const MAX_FILTER_WORDS = 200;
const ACCOUNT_CMDS_OFF = "Account commands are turned off in the chat. Use the log in / sign up link on the website.";
const LOGIN_RECHECK_MS = 60 * 1000; // how often a logged-in connection is checked to still be logged in

// Name colours. Bright red is deliberately absent: it is reserved for admins.
// The page builds its picker from this list, so this is the only place to edit it.
const PALETTE = [
  { name: "Black", hex: "#000000" },
  { name: "Gray", hex: "#555555" },
  { name: "Slate", hex: "#708090" },
  { name: "Brown", hex: "#8b4513" },
  { name: "Maroon", hex: "#800000" },
  { name: "Burnt orange", hex: "#cc5500" },
  { name: "Gold", hex: "#b8860b" },
  { name: "Olive", hex: "#808000" },
  { name: "Green", hex: "#008000" },
  { name: "Sea green", hex: "#2e8b57" },
  { name: "Teal", hex: "#008080" },
  { name: "Sky blue", hex: "#0077aa" },
  { name: "Royal blue", hex: "#4169e1" },
  { name: "Blue", hex: "#0000ff" },
  { name: "Navy", hex: "#000080" },
  { name: "Indigo", hex: "#4b0082" },
  { name: "Violet", hex: "#8a2be2" },
  { name: "Purple", hex: "#800080" },
  { name: "Magenta", hex: "#c71585" },
  { name: "Pink", hex: "#d63384" },
];
const PALETTE_HEX = new Set(PALETTE.map((c) => c.hex));
const ADMIN_COLOR = "#ff0000";
const DEFAULT_COLOR = "#000000";

// What /help shows (to admins only, in their own window, never in the chat).
// A line that is { head: "..." } is drawn as a heading.
const HELP_LINES = [
  { head: "Admin login (website accounts have no chat powers)" },
  "/login <token>  Admin login with the admin token",
  "/logout  End the admin token login",
  { head: "Messages" },
  "/delete <id>  or  /delete <first>-<last>  Hide messages",
  "/deleteuser <name>  Hide everything posted under a name",
  "/restore <id>  or  /restore <first>-<last>  Bring hidden messages back",
  "Add --yes on the end when a command affects more than 20 messages.",
  "/logs  Download the whole chat log as a CSV file (hidden messages included, marked)",
  "/logs <id>  or  /logs <first>-<last>  Download one message or a range",
  { head: "Names" },
  '/rename <old> <new>  Rename a name everywhere and stop <old> being used again (use "quotes" for names with spaces)',
  "/blocked  List names that can't be used",
  "/unblock <name>  Allow a blocked name again",
  { head: "Room" },
  "/lock  and  /unlock  Stop and resume sending",
  "/slow <milliseconds>  Minimum time between one person's messages (admins are exempt)",
  "/slow off  Remove the limit",
  "/filter add <word>  Block messages containing a word or phrase",
  "/filter remove <word>  Stop blocking it",
  "/filter list  Show blocked words",
  { head: "Other" },
  "/help  Show this list",
];

// Decide the colour stored with a message. Admins are always bright red.
// Everyone else gets their requested colour if it is in the palette, otherwise black.
function pickColor(requested, isAdmin) {
  if (isAdmin) return ADMIN_COLOR;
  const c = typeof requested === "string" ? requested.toLowerCase() : "";
  return PALETTE_HEX.has(c) ? c : DEFAULT_COLOR;
}

// "/delete 5-9 --yes" -> { rest: ["5-9"], confirmed: true }
function splitConfirm(args) {
  return args[args.length - 1] === "--yes"
    ? { rest: args.slice(0, -1), confirmed: true }
    : { rest: args, confirmed: false };
}

// "bob  some pass word" -> ["bob", "some pass word"]  (the rest of the line keeps its spaces)
function splitFirst(s) {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(String(s).trim());
  return m ? [m[1], m[2].trim()] : ["", ""];
}

// Words separated by spaces; "double quotes" (or curly quotes from a phone keyboard) group names with spaces.
function tokenize(s) {
  const out = [];
  const re = /"([^"]*)"|\u201c([^\u201d]*)\u201d|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push((m[1] ?? m[2] ?? m[3]).trim());
  return out;
}

// Zero-width, bidi-override and control characters can be used to fake names or hide text.
const INVISIBLE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufeff\uffa0\ufff9-\ufffb]/g;

// Collapse whitespace, strip invisible characters, and cut to max characters
// (counted as whole characters, so an emoji is never split in half).
function clean(value, max) {
  const s = String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(INVISIBLE, "")
    .replace(/ {2,}/g, " ")
    .trim();
  return Array.from(s).slice(0, max).join("").trim();
}

// Each browser sends a random id so the server can tell two tabs of the same person
// (allowed to share a name) from two different people (not allowed).
function validCid(v) {
  return typeof v === "string" && /^[0-9a-f]{16,64}$/.test(v) ? v : undefined;
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

// Bearer-token check for the /admin/* HTTP routes (same constant-time comparison as /login).
function isAdminRequest(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  return safeEqual(request.headers.get("Authorization") ?? "", `Bearer ${env.ADMIN_TOKEN}`);
}

// A connection is an admin only if it logged in with the admin token. Website accounts carry no chat powers.
const isAdminState = (st) => !!(st && st.tadmin);

// Constant-time comparison for the admin token.
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

// ---- word filter ----
// Words are compared in lower case with full-width/half-width forms unified. A word only matches
// as a whole word (so "ass" doesn't catch "class"), except next to Chinese/Japanese characters,
// which have no spaces between words.
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const normFilter = (s) => String(s).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
function buildFilter(words) {
  if (!words.length) return null;
  const parts = words.map((w) => {
    const chars = Array.from(w);
    const lead = NO_SPACES.test(chars[0]) ? "" : "(?<![\\p{L}\\p{N}])";
    const trail = NO_SPACES.test(chars[chars.length - 1]) ? "" : "(?![\\p{L}\\p{N}])";
    return lead + escapeRe(w) + trail;
  });
  return new RegExp(parts.join("|"), "u");
}

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    const sql = this.sql;

    sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        text TEXT NOT NULL,
        ts   INTEGER NOT NULL
      )
    `);
    // Add columns to a table created by an older version. Throws if they already exist.
    for (const ddl of [
      "ALTER TABLE messages ADD COLUMN color TEXT",
      "ALTER TABLE messages ADD COLUMN admin INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
    ]) {
      try {
        sql.exec(ddl);
      } catch {}
    }
    sql.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS blocked_names (lname TEXT PRIMARY KEY, created INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS filter_words (word TEXT PRIMARY KEY)");
    sql.exec("CREATE TABLE IF NOT EXISTS rate (k TEXT PRIMARY KEY, ts INTEGER NOT NULL)");

    this.locked = this.getSetting("locked") === "1";
    this.slowMs = Number(this.getSetting("slow_ms")) || 0;
    // Counts every change to messages that already exist (hide, restore, rename). Pages that saved a copy of
    // the chat only trust it while this number is unchanged.
    this.ver = Number(this.getSetting("ver")) || 0;
    this.loadFilter();
    this.chains = new WeakMap(); // keeps each connection's messages in the order they arrived
    this.presenceQueued = false;

    // The page sends "ping" now and then to detect dead connections (common on phones).
    // The runtime answers "pong" itself, without waking the object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---------- small storage helpers ----------

  bumpVer() {
    this.ver++;
    this.setSetting("ver", this.ver);
    return this.ver;
  }

  getSetting(key) {
    return this.sql.exec("SELECT value FROM settings WHERE key = ?", key).toArray()[0]?.value;
  }
  setSetting(key, value) {
    if (value === null) this.sql.exec("DELETE FROM settings WHERE key = ?", key);
    else
      this.sql.exec(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        key,
        String(value)
      );
  }
  loadFilter() {
    this.filterWords = this.sql
      .exec("SELECT word FROM filter_words ORDER BY word")
      .toArray()
      .map((r) => r.word);
    this.filterRe = buildFilter(this.filterWords);
  }
  rateGet(k) {
    return this.sql.exec("SELECT ts FROM rate WHERE k = ?", k).toArray()[0]?.ts || 0;
  }
  rateSet(k, ts) {
    this.sql.exec("INSERT INTO rate (k, ts) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET ts = excluded.ts", k, ts);
    if (Math.random() < 0.02) this.sql.exec("DELETE FROM rate WHERE ts < ?", ts - MAX_SLOW_MS - 60000);
  }

  // Per-connection state lives in the socket's attachment so it survives the object sleeping.
  getState(ws) {
    try {
      return ws.deserializeAttachment() || {};
    } catch {
      return {};
    }
  }
  setState(ws, patch) {
    const next = { ...this.getState(ws), ...patch };
    ws.serializeAttachment(next);
    return next;
  }
  send(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {}
  }
  sendAuth(ws) {
    const st = this.getState(ws);
    this.send(ws, { type: "auth", account: st.acct ? st.acct.name : null, admin: isAdminState(st) });
  }

  // ---------- connecting ----------

  // A visitor connects: send recent history only. No join announcement.
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    // A visitor who is logged in on the website arrives with their username attached (see chatFetch below).
    // The chat uses it as the screen name. It carries no other meaning here.
    const ident = this.identityOf(request);
    if (ident) {
      server.serializeAttachment({ acct: { name: ident.username }, sh: ident.sh, name: ident.username, chk: Date.now() });
      this.displaceGuests(ident.username.toLowerCase());
    }

    // A returning page sends the newest message id it has saved ("after") and the version of its copy.
    // If nothing old has changed, it only needs what is newer.
    let after = -1;
    try {
      const q = new URL(request.url).searchParams;
      if (q.has("after") && /^\d{1,15}$/.test(q.get("after")) && /^\d{1,15}$/.test(q.get("ver") || "") && Number(q.get("ver")) === this.ver) {
        after = Number(q.get("after"));
      }
    } catch {}
    if (after >= 0) {
      const top = this.sql.exec("SELECT MAX(id) m FROM messages").toArray()[0]?.m ?? 0;
      const fresh =
        after <= top
          ? this.sql
              .exec("SELECT id, name, text, ts, color, admin FROM messages WHERE id > ? AND deleted = 0 ORDER BY id LIMIT ?", after, INCREMENTAL_MAX + 1)
              .toArray()
          : null;
      if (fresh && fresh.length <= INCREMENTAL_MAX) {
        server.send(
          JSON.stringify({
            type: "history",
            incremental: true,
            messages: fresh,
            ver: this.ver,
            locked: this.locked,
            slow: this.slowMs,
            palette: PALETTE,
            adminColor: ADMIN_COLOR,
            ...this.presenceInfo(),
          })
        );
        this.sendAuth(server);
        return new Response(null, { status: 101, webSocket: client });
      }
    }

    const found = this.sql
      .exec(
        "SELECT id, name, text, ts, color, admin FROM messages WHERE deleted = 0 ORDER BY id DESC LIMIT ?",
        HISTORY_ON_JOIN + 1
      )
      .toArray();
    const hasMore = found.length > HISTORY_ON_JOIN;
    const rows = found.slice(0, HISTORY_ON_JOIN).reverse();
    server.send(
      JSON.stringify({
        type: "history",
        messages: rows,
        hasMore,
        ver: this.ver,
        locked: this.locked,
        slow: this.slowMs,
        palette: PALETTE,
        adminColor: ADMIN_COLOR,
        ...this.presenceInfo(),
      })
    );
    this.sendAuth(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  // One connection's messages are handled strictly in order, even when a step (such as checking a
  // password) has to wait, so "log in" can never be overtaken by the message sent right after it.
  webSocketMessage(ws, raw) {
    const prev = this.chains.get(ws) || Promise.resolve();
    const next = prev
      .then(() => this.process(ws, raw))
      .catch((err) => console.error("message handler failed:", err && err.message));
    this.chains.set(ws, next);
    return next;
  }

  async process(ws, raw) {
    if (typeof raw !== "string" || raw.length > 2000) return;

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;

    await this.recheckLogin(ws);

    switch (data.type) {
      case "command":
        return this.handleCommand(ws, String(data.text ?? ""));
      case "before":
        return this.sendEarlier(ws, data);
      case "name":
        return this.handleName(ws, data);
      default:
        return this.handleChat(ws, data);
    }
  }

  // "Load earlier messages": the page asks for the page of messages before the oldest one it has.
  sendEarlier(ws, data) {
    const st = this.getState(ws);
    const before = Number(data.id);
    const t = Date.now();
    if (!Number.isSafeInteger(before) || before < 1) return;
    if (t - (st.lastLoad || 0) < 150) {
      // Too soon after the last request: answer with nothing so the page's button resets
      // instead of sitting on "Loading…". The reader just clicks again.
      this.send(ws, { type: "earlier", messages: [], hasMore: true });
      return;
    }
    this.setState(ws, { lastLoad: t });
    const found = this.sql
      .exec(
        "SELECT id, name, text, ts, color, admin FROM messages WHERE id < ? AND deleted = 0 ORDER BY id DESC LIMIT ?",
        before,
        EARLIER_PAGE + 1
      )
      .toArray();
    this.send(ws, {
      type: "earlier",
      messages: found.slice(0, EARLIER_PAGE).reverse(),
      hasMore: found.length > EARLIER_PAGE,
    });
  }

  // The page reports its screen name on connect and whenever it changes.
  handleName(ws, data) {
    let st = this.getState(ws);
    const cid = validCid(data.cid) || st.cid;
    if (cid && cid !== st.cid) st = this.setState(ws, { cid });

    // Logged in: the account's username is the only name this connection can have.
    if (st.acct) {
      if (st.name !== st.acct.name) {
        this.setState(ws, { name: st.acct.name });
        this.queuePresence();
      }
      return;
    }

    const nm = clean(String(data.name ?? "").replace(/@/g, ""), MAX_NAME);
    if (nm) {
      const reason = this.nameProblem(nm, ws, cid, null);
      if (reason) {
        this.send(ws, { type: "nametaken", name: nm, reason, suggestion: this.freeName(nm, ws, cid, null, reason) });
        return;
      }
    }
    if (nm === (st.name || "")) return;
    this.setState(ws, { name: nm || null });
    // A newcomer sees themselves in the list straight away; everyone else gets the batched update.
    if (nm && !st.name) this.send(ws, { type: "presence", ...this.presenceInfo() });
    this.queuePresence();
  }

  // ---------- chat messages ----------

  handleChat(ws, data) {
    let st = this.getState(ws);
    const cid = validCid(data.cid) || st.cid;
    if (cid && cid !== st.cid) st = this.setState(ws, { cid });
    const admin = isAdminState(st);
    const now = Date.now();

    // Admins skip the lock, the send-rate limit and the word filter.
    if (!admin) {
      if (this.locked) {
        this.send(ws, { type: "rejected", reason: "locked" });
        return;
      }
      const interval = Math.max(MIN_INTERVAL_MS, this.slowMs);
      const last = Math.max(st.last || 0, cid ? this.rateGet("m:" + cid) : 0);
      const wait = interval - (now - last);
      if (wait > 0) {
        this.send(ws, { type: "rejected", reason: "rate", wait });
        return;
      }
    }

    // A logged-in account always posts under its own username. "@" is stripped from other
    // names because it marks admin messages.
    const name = st.acct ? st.acct.name : clean(String(data.name ?? "").replace(/@/g, ""), MAX_NAME);
    const text = clean(data.text, MAX_TEXT);
    if (!text) return;
    if (!name) {
      this.send(ws, { type: "rejected", reason: "name" });
      return;
    }

    // Never store anything that looks like a command (protects a mistyped /login).
    if (text.startsWith("/")) {
      this.send(ws, { type: "rejected", reason: "command" });
      return;
    }

    if (!admin && this.filterRe && this.filterRe.test(normFilter(text))) {
      this.send(ws, { type: "rejected", reason: "filter" });
      return;
    }

    if (!st.acct) {
      const reason = this.nameProblem(name, ws, cid, null);
      if (reason) {
        this.send(ws, { type: "nametaken", name, reason, suggestion: this.freeName(name, ws, cid, null, reason) });
        return;
      }
    }

    let renamed = false;
    if ((st.name || "") !== name) {
      renamed = true;
      st = this.setState(ws, { name });
    }
    if (!admin) {
      this.setState(ws, { last: now });
      if (cid) this.rateSet("m:" + cid, now);
    }

    const message = this.sql
      .exec(
        "INSERT INTO messages (name, text, ts, color, admin) VALUES (?, ?, ?, ?, ?) RETURNING id, name, text, ts, color, admin",
        name,
        text,
        now,
        pickColor(data.color, admin),
        admin ? 1 : 0
      )
      .one();

    this.broadcast({ type: "message", message });
    this.send(ws, { type: "ok" });
    if (renamed) this.broadcastPresence();
  }

  // ---------- names ----------

  // Why can't this connection use this name right now? "blocked" (an admin banned it),
  // "reserved" (a registered account owns it) or "inuse" (another person is using it). null = fine.
  // Another tab of the same browser, or another login to the same account, may share a name.
  nameProblem(name, ws, cid, acctId) {
    const key = name.toLowerCase();
    if (this.sql.exec("SELECT 1 AS x FROM blocked_names WHERE lname = ?", key).toArray().length) return "blocked";
    for (const sock of this.ctx.getWebSockets()) {
      if (sock === ws) continue;
      const st = this.getState(sock);
      if (!st.name || st.name.toLowerCase() !== key) continue;
      if (cid && st.cid === cid) continue;
      if (acctId && st.acct && st.acct.id === acctId) continue;
      return "inuse";
    }
    return null;
  }

  // A nearby name that is free: "bob" -> "bob2", "bob3", ... (a random burger### for a blocked name,
  // since a variation of an offensive name would be offensive too).
  freeName(name, ws, cid, acctId, reason) {
    if (reason !== "blocked") {
      const chars = Array.from(name);
      for (let i = 2; i < 100; i++) {
        const suffix = String(i);
        const candidate = chars.slice(0, MAX_NAME - suffix.length).join("") + suffix;
        if (!this.nameProblem(candidate, ws, cid, acctId)) return candidate;
      }
    }
    for (let i = 0; i < 50; i++) {
      const candidate = "burger" + Math.floor(100 + Math.random() * 900);
      if (!this.nameProblem(candidate, ws, cid, acctId)) return candidate;
    }
    return "burger" + Math.floor(1000 + Math.random() * 9000);
  }

  // Every exact spelling of a name in the stored messages ("Bob", "BOB", ...), compared the
  // same way everywhere else is (so non-English letters match regardless of capitals).
  spellingsOf(lname) {
    return this.sql
      .exec("SELECT DISTINCT name FROM messages")
      .toArray()
      .map((r) => r.name)
      .filter((n) => n.toLowerCase() === lname)
      .slice(0, 50);
  }

  // ---------- commands ----------

  async handleCommand(ws, input) {
    const [rawCmd, body] = splitFirst(input);
    const cmd = rawCmd.toLowerCase();
    const args = body ? body.split(/\s+/) : [];
    const reply = (ok, text) => this.send(ws, { type: "cmd", ok, text });
    const panel = (title, lines) => this.send(ws, { type: "panel", title, lines });
    const admin = isAdminState(this.getState(ws));
    const adminOnly = () => {
      if (admin) return true;
      reply(false, "Unknown command."); // don't reveal that admin commands exist
      return false;
    };
    const c = { ws, body, args, reply, panel };

    switch (cmd) {
      // Switched off: accounts are handled on the website, not in the chat. (/login <token> is the admin token.)
      case "/register":
      case "/password":
        return reply(false, ACCOUNT_CMDS_OFF);
      case "/login":
        return this.cmdLogin(c);
      case "/logout":
        return this.cmdLogout(c);

      case "/help":
        if (!adminOnly()) return;
        return panel("Admin commands", HELP_LINES);

      case "/delete":
        if (!adminOnly()) return;
        return this.cmdDelete(c);
      case "/deleteuser":
        if (!adminOnly()) return;
        return this.cmdDeleteUser(c);
      case "/restore":
        if (!adminOnly()) return;
        return this.cmdRestore(c);
      case "/logs":
        if (!adminOnly()) return;
        return this.cmdLogs(c);

      case "/rename":
        if (!adminOnly()) return;
        return this.cmdRename(c);
      case "/blocked":
        if (!adminOnly()) return;
        return this.cmdBlocked(c);
      case "/unblock":
        if (!adminOnly()) return;
        return this.cmdUnblock(c);

      case "/slow":
        if (!adminOnly()) return;
        return this.cmdSlow(c);
      case "/filter":
        if (!adminOnly()) return;
        return this.cmdFilter(c);

      case "/lock":
        if (!adminOnly()) return;
        this.setLocked(true);
        return reply(true, "Chat locked. Use /unlock to reopen it.");
      case "/unlock":
        if (!adminOnly()) return;
        this.setLocked(false);
        return reply(true, "Chat unlocked.");

      default:
        reply(false, "Unknown command.");
    }
  }

  // ---- website login (read-only) ----
  // The Worker checks the visitor's login cookie and adds two headers saying whose it is (it removes any
  // such headers a visitor sends themselves). The chat only ever uses the username as a screen name.
  identityOf(request) {
    try {
      const h = request && request.headers;
      const raw = h && h.get && h.get("X-Site-User");
      if (!raw) return null;
      const v = JSON.parse(decodeURIComponent(raw));
      const sh = h.get("X-Site-Session");
      if (typeof v.u !== "string" || !v.u || typeof sh !== "string" || !sh) return null;
      return { username: v.u, sh };
    } catch {
      return null;
    }
  }

  // If a guest is using a name that a logged-in person has just arrived with, give the guest a free one.
  displaceGuests(lname) {
    let moved = false;
    for (const sock of this.ctx.getWebSockets()) {
      const st = this.getState(sock);
      if (st.acct || !st.name || st.name.toLowerCase() !== lname) continue;
      const next = this.freeName(st.name, sock, st.cid, null, "inuse");
      this.setState(sock, { name: next });
      this.send(sock, { type: "forcename", name: next });
      moved = true;
    }
    if (moved) this.queuePresence();
  }

  // Back to a guest (the connection stays open and the page restores its own guest name).
  becomeGuest(ws) {
    this.setState(ws, { acct: null, sh: null, name: null });
    this.sendAuth(ws);
    this.broadcastPresence();
  }

  // Now and then, ask the database whether a logged-in connection is still logged in. If it isn't
  // (logged out, password changed, account removed), it becomes a guest. If the database can't be
  // reached, nothing changes.
  async recheckLogin(ws) {
    const st = this.getState(ws);
    if (!st.acct || !st.sh || !this.env.DB) return;
    const now = Date.now();
    if (now - (st.chk || 0) < LOGIN_RECHECK_MS) return;
    this.setState(ws, { chk: now });
    try {
      if (!(await stillLoggedIn(this.env.DB, st.sh))) this.becomeGuest(ws);
    } catch (e) {
      console.error("login recheck failed:", e && e.message);
    }
  }

  // "/login <token>" gives admin powers without an account.
  cmdLogin({ ws, body, reply }) {
    const st = this.getState(ws);
    if ((st.fails || 0) >= MAX_LOGIN_FAILS) {
      reply(false, "Too many failed attempts.");
      ws.close(1008, "too many attempts");
      return;
    }
    const [first, rest] = splitFirst(body);
    if (!first) return reply(false, "Usage: /login <admin token>");
    if (rest) return reply(false, ACCOUNT_CMDS_OFF);
    if (this.env.ADMIN_TOKEN && safeEqual(first, this.env.ADMIN_TOKEN)) {
      this.setState(ws, { tadmin: true, fails: 0 });
      this.sendAuth(ws);
      this.broadcastPresence();
      reply(true, "Logged in as admin.");
    } else {
      this.setState(ws, { fails: (st.fails || 0) + 1 });
      reply(false, "Login failed.");
    }
  }

  cmdLogout({ ws, reply }) {
    const st = this.getState(ws);
    if (st.tadmin) {
      this.setState(ws, { tadmin: false });
      this.sendAuth(ws);
      this.broadcastPresence();
      return reply(true, "Admin token login ended.");
    }
    reply(false, st.acct ? "Log out on the website." : "You're not logged in.");
  }

  // ---- hiding and restoring messages ----

  // Parse "12" or "12-40" into a range, or null.
  parseRange(rest) {
    const m = rest.length === 1 ? /^(\d+)(?:-(\d+))?$/.exec(rest[0]) : null;
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    return Number.isSafeInteger(from) && Number.isSafeInteger(to) ? { from, to } : null;
  }

  // Large batches need "--yes" so a typo can't change thousands of messages at once.
  confirmThen(reply, ids, confirmed, verb, run) {
    if (ids.length === 0) {
      reply(false, "No matching messages.");
      return false;
    }
    if (ids.length > CONFIRM_ABOVE && !confirmed) {
      reply(false, `${ids.length} messages match. Run the same command again with --yes on the end to ${verb} them.`);
      return false;
    }
    run();
    return true;
  }

  cmdDelete({ args, reply }) {
    const { rest, confirmed } = splitConfirm(args);
    const range = this.parseRange(rest);
    if (!range) return reply(false, "Usage: /delete <id> or /delete <first>-<last>");
    if (range.from > range.to) return reply(false, "In a range, the first id must be the lower one.");
    const ids = this.sql
      .exec("SELECT id FROM messages WHERE id BETWEEN ? AND ? AND deleted = 0 ORDER BY id", range.from, range.to)
      .toArray()
      .map((r) => r.id);
    const done = this.confirmThen(reply, ids, confirmed, "delete", () =>
      this.sql.exec("UPDATE messages SET deleted = 1 WHERE id BETWEEN ? AND ? AND deleted = 0", range.from, range.to)
    );
    if (done) this.afterHide(reply, ids);
  }

  // /deleteuser <name>  (matches the name regardless of capitals)
  cmdDeleteUser({ args, reply }) {
    const { rest, confirmed } = splitConfirm(args);
    const name = rest.join(" ").replace(/@/g, "").trim();
    if (!name) return reply(false, "Usage: /deleteuser <name>");
    const spellings = this.spellingsOf(name.toLowerCase());
    const marks = spellings.map(() => "?").join(",");
    const ids = spellings.length
      ? this.sql
          .exec(`SELECT id FROM messages WHERE name IN (${marks}) AND deleted = 0 ORDER BY id`, ...spellings)
          .toArray()
          .map((r) => r.id)
      : [];
    const done = this.confirmThen(reply, ids, confirmed, "delete", () =>
      this.sql.exec(`UPDATE messages SET deleted = 1 WHERE name IN (${marks}) AND deleted = 0`, ...spellings)
    );
    if (done) this.afterHide(reply, ids);
  }

  afterHide(reply, ids) {
    this.broadcastDeleted(ids);
    const lo = ids[0];
    const hi = ids[ids.length - 1];
    reply(
      true,
      ids.length === 1
        ? `Deleted #${lo}. Undo with /restore ${lo}.`
        : `Deleted ${ids.length} messages. Undo with /restore ${lo}-${hi}.`
    );
  }

  // Send the log to this admin's page in pieces; the page assembles them and saves a file.
  cmdLogs({ ws, args, reply }) {
    let range = null;
    if (args.length) {
      range = this.parseRange(args);
      if (!range) return reply(false, "Usage: /logs or /logs <id> or /logs <first>-<last>");
      if (range.from > range.to) return reply(false, "In a range, the first id must be the lower one.");
    }
    const rows = range
      ? this.sql.exec("SELECT id, name, text, ts, color, admin, deleted FROM messages WHERE id BETWEEN ? AND ? ORDER BY id", range.from, range.to).toArray()
      : this.sql.exec("SELECT id, name, text, ts, color, admin, deleted FROM messages ORDER BY id").toArray();
    if (!rows.length) return reply(false, "No matching messages.");
    const esc = (v) => {
      let t = String(v);
      if (/^[=+\-@]/.test(t)) t = "'" + t; // stop spreadsheet formula injection
      return '"' + t.replace(/"/g, '""') + '"';
    };
    const lines = rows.map((r) =>
      [r.id, new Date(r.ts).toISOString(), esc(r.name), esc(r.text), r.color ?? "", r.admin, r.deleted].join(",")
    );
    const day = new Date().toISOString().slice(0, 10);
    const file = range
      ? `chatlog-${rows[0].id}-${rows[rows.length - 1].id}.csv`
      : `chatlog-all-${day}.csv`;
    // Keep each WebSocket frame well under the size limit.
    const chunks = [];
    let cur = ["id,time,name,text,color,admin,deleted"];
    let size = 0;
    for (const ln of lines) {
      if (size + ln.length > LOG_CHUNK_CHARS && cur.length) {
        chunks.push(cur.join("\n"));
        cur = [];
        size = 0;
      }
      cur.push(ln);
      size += ln.length + 1;
    }
    chunks.push(cur.join("\n"));
    const id = crypto.randomUUID();
    chunks.forEach((data, i) => this.send(ws, { type: "logs", id, file, part: i, parts: chunks.length, data }));
    reply(true, `Sending ${rows.length} message${rows.length === 1 ? "" : "s"} as ${file}.`);
  }

  cmdRestore({ args, reply }) {
    const { rest, confirmed } = splitConfirm(args);
    const range = this.parseRange(rest);
    if (!range) return reply(false, "Usage: /restore <id> or /restore <first>-<last>");
    if (range.from > range.to) return reply(false, "In a range, the first id must be the lower one.");
    const rows = this.sql
      .exec(
        "SELECT id, name, text, ts, color, admin FROM messages WHERE id BETWEEN ? AND ? AND deleted = 1 ORDER BY id",
        range.from,
        range.to
      )
      .toArray();
    const done = this.confirmThen(
      reply,
      rows.map((r) => r.id),
      confirmed,
      "restore",
      () => this.sql.exec("UPDATE messages SET deleted = 0 WHERE id BETWEEN ? AND ? AND deleted = 1", range.from, range.to)
    );
    if (!done) return;
    const ver = this.bumpVer();
    for (let i = 0; i < rows.length; i += 100) this.broadcast({ type: "restored", ver, messages: rows.slice(i, i + 100) });
    reply(true, rows.length === 1 ? `Restored #${rows[0].id}.` : `Restored ${rows.length} messages.`);
  }

  // ---- names ----

  cmdRename({ args, body, reply }) {
    const usage = 'Usage: /rename <old> <new>  (use "quotes" around a name with spaces)';
    const toks = tokenize(body);
    if (toks.length !== 2) return reply(false, usage);
    const oldName = clean(toks[0].replace(/@/g, ""), MAX_NAME);
    const newName = clean(toks[1].replace(/@/g, ""), MAX_NAME);
    if (!oldName || !newName) return reply(false, usage);
    const oldL = oldName.toLowerCase();
    const newL = newName.toLowerCase();
    if (oldL === newL) return reply(false, "Those are the same name.");

    const problem = this.nameProblem(newName, null, null, null);
    if (problem === "blocked") return reply(false, `"${newName}" is a blocked name.`);
    if (problem === "inuse") return reply(false, `Someone is using "${newName}" right now.`);

    // 1. Rewrite the stored messages (hidden ones too, so /restore brings them back under the new name).
    const spellings = this.spellingsOf(oldL);
    let changed = 0;
    if (spellings.length) {
      const marks = spellings.map(() => "?").join(",");
      changed = this.sql.exec(`SELECT COUNT(*) AS c FROM messages WHERE name IN (${marks})`, ...spellings).one().c;
      this.sql.exec(`UPDATE messages SET name = ? WHERE name IN (${marks})`, newName, ...spellings);
    }
    // 2. Stop the old name being picked again.
    this.sql.exec("INSERT OR IGNORE INTO blocked_names (lname, created) VALUES (?, ?)", oldL, Date.now());
    // 3. Rename anyone connected under it right now.
    let people = 0;
    for (const sock of this.ctx.getWebSockets()) {
      const st = this.getState(sock);
      if (st.acct || !st.name || st.name.toLowerCase() !== oldL) continue;
      this.setState(sock, { name: newName });
      this.send(sock, { type: "forcename", name: newName });
      people++;
    }
    // 4. Update what everyone already has on screen.
    this.broadcast({ type: "renamed", ver: this.bumpVer(), old: oldL, name: newName });
    this.broadcastPresence();
    reply(
      true,
      `Renamed "${oldName}" to "${newName}": ${changed} message${changed === 1 ? "" : "s"} updated, ${people} ${people === 1 ? "person" : "people"} renamed. "${oldName}" can't be used again.`
    );
  }

  cmdBlocked({ panel }) {
    const rows = this.sql.exec("SELECT lname, created FROM blocked_names ORDER BY created, lname").toArray();
    const lines = rows.map((r) => `${r.lname}  blocked ${day(r.created)}`);
    if (!rows.length) lines.push("No blocked names. /rename <old> <new> adds one.");
    else lines.push({ head: "Allow one again with /unblock <name>." });
    panel(`Blocked names (${rows.length})`, lines);
  }

  cmdUnblock({ body, reply }) {
    const [name] = tokenize(body);
    const lname = clean((name || "").replace(/@/g, ""), MAX_NAME).toLowerCase();
    if (!lname) return reply(false, "Usage: /unblock <name>");
    const found = this.sql.exec("SELECT 1 AS x FROM blocked_names WHERE lname = ?", lname).toArray().length;
    if (!found) return reply(false, `"${lname}" isn't blocked.`);
    this.sql.exec("DELETE FROM blocked_names WHERE lname = ?", lname);
    reply(true, `"${lname}" can be used again.`);
  }

  // ---- room settings ----

  cmdSlow({ args, reply }) {
    const arg = (args[0] || "").toLowerCase();
    if (!arg) {
      return reply(
        true,
        this.slowMs ? `Slow mode is on: ${this.slowMs} ms between one person's messages.` : "Slow mode is off."
      );
    }
    if (arg === "off") {
      this.setSlow(0);
      return reply(true, "Slow mode off.");
    }
    const m = /^(\d+)(?:ms)?$/.exec(arg);
    const ms = m ? Number(m[1]) : NaN;
    if (!Number.isSafeInteger(ms) || ms < MIN_INTERVAL_MS || ms > MAX_SLOW_MS) {
      return reply(false, `Usage: /slow <milliseconds> (${MIN_INTERVAL_MS} to ${MAX_SLOW_MS}) or /slow off`);
    }
    this.setSlow(ms);
    reply(true, `Slow mode on: ${ms} ms between one person's messages. Admins are exempt.`);
  }

  setSlow(ms) {
    this.slowMs = ms;
    this.setSetting("slow_ms", ms ? ms : null);
    this.broadcast({ type: "slow", ms });
  }

  cmdFilter({ body, reply, panel }) {
    const [sub, restText] = splitFirst(body);
    const word = normFilter(restText);
    switch (sub.toLowerCase()) {
      case "add": {
        const len = Array.from(word).length;
        if (!word) return reply(false, "Usage: /filter add <word>");
        if (len < 2 || len > 40) return reply(false, "A filtered word or phrase must be 2 to 40 characters.");
        if (this.filterWords.includes(word)) return reply(false, `"${word}" is already filtered.`);
        if (this.filterWords.length >= MAX_FILTER_WORDS) return reply(false, `The filter is full (${MAX_FILTER_WORDS} entries).`);
        this.sql.exec("INSERT INTO filter_words (word) VALUES (?)", word);
        this.loadFilter();
        return reply(true, `Messages containing "${word}" are now blocked.`);
      }
      case "remove": {
        if (!word) return reply(false, "Usage: /filter remove <word>");
        if (!this.filterWords.includes(word)) return reply(false, `"${word}" isn't in the filter.`);
        this.sql.exec("DELETE FROM filter_words WHERE word = ?", word);
        this.loadFilter();
        return reply(true, `"${word}" is no longer filtered.`);
      }
      case "list": {
        const lines = this.filterWords.length ? [...this.filterWords] : ["The filter is empty. /filter add <word> adds one."];
        return panel(`Filtered words (${this.filterWords.length})`, lines);
      }
      default:
        return reply(false, "Usage: /filter add <word>, /filter remove <word> or /filter list");
    }
  }

  setLocked(value) {
    this.locked = value;
    this.setSetting("locked", value ? "1" : "0");
    this.broadcast({ type: "lock", locked: value });
  }

  // ---------- leaving ----------

  // A visitor leaves: nothing is announced.
  async webSocketClose(ws, code) {
    this.broadcastPresence(ws);
    try {
      ws.close(1000, "closing");
    } catch {}
  }

  async webSocketError(ws) {
    this.broadcastPresence(ws);
    try {
      ws.close(1011, "error");
    } catch {}
  }

  // Tell every connected page which messages to hide (in chunks to keep frames small).
  broadcastDeleted(ids) {
    const ver = this.bumpVer();
    for (let i = 0; i < ids.length; i += 500) {
      this.broadcast({ type: "delete", ver, ids: ids.slice(i, i + 500) });
    }
  }

  // Used by the Worker's /admin/delete route. Messages are hidden, not erased, so /restore can bring them back.
  async deleteMessage(id) {
    this.sql.exec("UPDATE messages SET deleted = 1 WHERE id = ?", id);
    this.broadcastDeleted([id]);
  }

  // Everything, including hidden messages (marked in the "deleted" column).
  async exportMessages() {
    return this.sql.exec("SELECT id, name, text, ts, color, admin, deleted FROM messages ORDER BY id").toArray();
  }

  // ---------- who is online ----------

  // Who is connected right now: one entry per distinct name (case-insensitive).
  // Connections that haven't told us a name yet are not counted.
  presenceInfo(exclude) {
    const seen = new Map();
    for (const sock of this.ctx.getWebSockets()) {
      if (sock === exclude) continue;
      const st = this.getState(sock);
      if (!st.name) continue;
      const key = st.name.toLowerCase();
      const admin = isAdminState(st);
      const prev = seen.get(key);
      if (!prev) seen.set(key, { name: st.name, admin });
      else if (admin) prev.admin = true;
    }
    const all = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { users: all.slice(0, MAX_PRESENCE), count: all.length };
  }

  // Renames are applied at once but announced in one batch: a client that changes its name
  // rapidly (or floods "name" messages) causes at most a few updates per second for everyone.
  queuePresence() {
    if (this.presenceQueued) return;
    this.presenceQueued = true;
    setTimeout(() => {
      this.presenceQueued = false;
      this.broadcastPresence();
    }, 300);
  }

  broadcastPresence(exclude) {
    this.broadcast({ type: "presence", ...this.presenceInfo(exclude) });
  }

  broadcast(payload) {
    const out = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(out);
      } catch {}
    }
  }
}

function originAllowed(origin, host, list) {
  let o;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (o.host === host) return true;
  return String(list || "")
    .split(",")
    .map((x) => x.trim().replace(/\/+$/, "").toLowerCase())
    .filter(Boolean)
    .includes(o.origin.toLowerCase());
}

export async function chatFetch(request, env) {
    const url = new URL(request.url);

    // The chat connection. /ws is the old name for it.
    if (url.pathname === "/ws" || url.pathname === "/api/chat") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      // Only accept connections from pages served by this same host, or from a page hosted elsewhere
      // that is listed in the ALLOWED_ORIGINS variable (comma-separated, e.g. "https://example.com").
      const origin = request.headers.get("Origin");
      if (origin && !originAllowed(origin, url.host, env.ALLOWED_ORIGINS)) {
        return new Response("Forbidden", { status: 403 });
      }
      // If they are logged in on the website, pass their username to the room. Any identity headers a
      // visitor sent themselves are thrown away first.
      const headers = new Headers(request.headers);
      headers.delete("X-Site-User");
      headers.delete("X-Site-Session");
      if (env.DB) {
        try {
          const who = await loggedInAs(env.DB, request.headers.get("Cookie"), url.protocol === "https:");
          if (who) {
            headers.set("X-Site-User", encodeURIComponent(JSON.stringify({ u: who.name })));
            headers.set("X-Site-Session", who.hash);
          }
        } catch (e) {
          console.error("login lookup failed:", e && e.message); // carry on as a guest
        }
      }
      const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName("main"));
      return stub.fetch(new Request(request, { headers }));
    }

    // Moderation: POST /admin/delete?id=123 with "Authorization: Bearer <ADMIN_TOKEN>"
    if (url.pathname === "/admin/delete" && request.method === "POST") {
      if (!isAdminRequest(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const id = Number(url.searchParams.get("id"));
      if (!Number.isInteger(id)) return new Response("Bad id", { status: 400 });
      const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName("main"));
      await stub.deleteMessage(id);
      return new Response("Deleted", { status: 200 });
    }

    // Export: GET /admin/export (JSON) or /admin/export?format=csv
    if (url.pathname === "/admin/export" && request.method === "GET") {
      if (!isAdminRequest(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName("main"));
      const rows = await stub.exportMessages();

      if (url.searchParams.get("format") === "csv") {
        const esc = (v) => {
          let s = String(v);
          if (/^[=+\-@]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
          return '"' + s.replace(/"/g, '""') + '"';
        };
        const csv = ["id,time,name,text,color,admin,deleted"]
          .concat(
            rows.map((r) =>
              [r.id, new Date(r.ts).toISOString(), esc(r.name), esc(r.text), r.color ?? "", r.admin, r.deleted].join(",")
            )
          )
          .join("\n");
        return new Response("\ufeff" + csv, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="chat.csv"',
          },
        });
      }
      return Response.json(rows);
    }

    return new Response("Not found", { status: 404 });
}
