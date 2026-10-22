// ============================================================================
// WHAT CAN BE EARNED. This is the only file you edit to add achievements and quests.
// Everything below is a PLACEHOLDER: replace the ids, titles and descriptions with your own.
//
// An achievement is only ever granted by the server, when one of its rules is met.
// The page can never say "I earned it". The rule types are:
//   { type: "register" }                       when the account is created
//   { type: "quest", quest, done(state) }      when a saved quest state satisfies done()
//   { type: "event", event }                   when the page reports the event (see the warning below)
//
// WARNING about "event": the browser reports it, so anyone who reads the page's code can report
// it without doing the thing. Use it only for harmless, for-fun achievements. Anything people
// compete on should use "register" or "quest" rules that the server checks itself.
// ============================================================================

export const ACHIEVEMENTS = {
  placeholder_welcome: {
    title: "PLACEHOLDER: first achievement",
    description: "PLACEHOLDER: made an account",
    rule: { type: "register" },
  },
  placeholder_quest: {
    title: "PLACEHOLDER: quest achievement",
    description: "PLACEHOLDER: finished the example quest",
    rule: { type: "quest", quest: "placeholder_quest", done: (state) => state.step >= 3 },
  },
  placeholder_event: {
    title: "PLACEHOLDER: page event achievement",
    description: "PLACEHOLDER: reported by a page (not verified)",
    rule: { type: "event", event: "placeholder_visited_page" },
  },
};

// Quests: saved progress per user. validate() receives the state the page sent and returns the
// cleaned state to store, or null to reject it. Keep it small: no more than about 2 KB of JSON.
export const QUESTS = {
  placeholder_quest: {
    title: "PLACEHOLDER: example quest",
    validate(state) {
      const step = Number(state.step);
      if (!Number.isInteger(step) || step < 0 || step > 10) return null;
      return { step };
    },
  },
};

// Page events accepted by POST /api/event (must match the "event" rules above).
export const EVENTS = ["placeholder_visited_page"];
