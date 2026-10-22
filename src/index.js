// Entry point. Two separate things share this one Worker:
//   - the website's accounts and progress, under /api/*          (src/site/*)
//   - the chat room, at /api/chat (and the older /ws)             (src/chat.js)
// They don't depend on each other. The chat's only use of the accounts is the read-only check in
// src/login-check.js; the accounts side never calls the chat.
import { handleApi } from "./site/api.js";
import { chatFetch } from "./chat.js";

export { ChatRoom } from "./chat.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isChat = url.pathname === "/ws" || url.pathname === "/api/chat";
    if (!isChat) {
      const res = await handleApi(request, env, ctx);
      if (res) return res;
    }
    return chatFetch(request, env, ctx);
  },
};
