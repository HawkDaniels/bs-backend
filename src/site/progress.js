import { ACHIEVEMENTS, QUESTS, EVENTS } from "./defs.js";
import { MAX_QUEST_STATE_CHARS } from "./config.js";

const one = (db, sql, ...p) => db.prepare(sql).bind(...p).first();
const all = async (db, sql, ...p) => (await db.prepare(sql).bind(...p).all()).results || [];

const isPlain = (v, depth = 0) => {
  if (depth > 4) return false;
  if (v === null || ["string", "number", "boolean"].includes(typeof v)) return true;
  if (Array.isArray(v)) return v.length <= 100 && v.every((x) => isPlain(x, depth + 1));
  if (typeof v === "object") {
    const keys = Object.keys(v);
    return keys.length <= 50 && keys.every((k) => isPlain(v[k], depth + 1));
  }
  return false;
};

// ---- achievements ----

// Grants every achievement whose rule matches this happening. Returns the ids that are new.
export async function award(db, userId, happening) {
  const earned = [];
  for (const [id, def] of Object.entries(ACHIEVEMENTS)) {
    const r = def.rule;
    if (!r || r.type !== happening.type) continue;
    let ok = false;
    if (r.type === "register") ok = true;
    else if (r.type === "quest") ok = r.quest === happening.quest && !!r.done(happening.state);
    else if (r.type === "event") ok = r.event === happening.event;
    if (!ok) continue;
    const res = await db
      .prepare("INSERT OR IGNORE INTO achievements (user_id, achievement_id, earned_at) VALUES (?, ?, ?)")
      .bind(userId, id, Date.now())
      .run();
    if (res.meta && res.meta.changes > 0) earned.push(id);
  }
  return earned;
}

export async function achievementsOf(db, userId) {
  const rows = await all(db, "SELECT achievement_id, earned_at FROM achievements WHERE user_id = ? ORDER BY earned_at", userId);
  return rows.filter((r) => ACHIEVEMENTS[r.achievement_id]).map((r) => ({ id: r.achievement_id, earnedAt: r.earned_at }));
}

// How many people earned each achievement (for "x% of players" displays). Counts only, no names.
export async function achievementStats(db) {
  const total = (await one(db, "SELECT COUNT(*) AS c FROM users")).c;
  const rows = await all(db, "SELECT achievement_id, COUNT(*) AS c FROM achievements GROUP BY achievement_id");
  const have = new Map(rows.map((r) => [r.achievement_id, r.c]));
  return {
    users: total,
    achievements: Object.keys(ACHIEVEMENTS).map((id) => ({
      id,
      count: have.get(id) || 0,
      percent: total ? Math.round(((have.get(id) || 0) / total) * 1000) / 10 : 0,
    })),
  };
}

export const publicDefs = () => ({
  achievements: Object.entries(ACHIEVEMENTS).map(([id, d]) => ({ id, title: d.title, description: d.description })),
  quests: Object.entries(QUESTS).map(([id, d]) => ({ id, title: d.title })),
});

// ---- quests ----

export async function questStates(db, userId) {
  const rows = await all(db, "SELECT quest_id, state, updated_at FROM quest_progress WHERE user_id = ?", userId);
  const out = {};
  for (const r of rows) {
    if (!QUESTS[r.quest_id]) continue;
    try {
      out[r.quest_id] = JSON.parse(r.state);
    } catch {}
  }
  return out;
}

// Validates and stores one quest's state. Returns { state, earned } or { error }.
export async function saveQuest(db, userId, questId, state) {
  const def = Object.hasOwn(QUESTS, questId) ? QUESTS[questId] : null;
  if (!def) return { error: "unknown_quest" };
  if (!state || typeof state !== "object" || Array.isArray(state) || !isPlain(state)) return { error: "bad_state" };
  let clean;
  try {
    clean = def.validate(state);
  } catch {
    clean = null;
  }
  if (!clean || typeof clean !== "object") return { error: "bad_state" };
  const json = JSON.stringify(clean);
  if (json.length > MAX_QUEST_STATE_CHARS) return { error: "bad_state" };
  await db
    .prepare(
      "INSERT INTO quest_progress (user_id, quest_id, state, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, quest_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at"
    )
    .bind(userId, questId, json, Date.now())
    .run();
  const earned = await award(db, userId, { type: "quest", quest: questId, state: clean });
  return { state: clean, earned };
}

// ---- page-reported events (see the warning in defs.js) ----

export async function reportEvent(db, userId, event) {
  if (typeof event !== "string" || !EVENTS.includes(event)) return { error: "unknown_event" };
  return { earned: await award(db, userId, { type: "event", event }) };
}
