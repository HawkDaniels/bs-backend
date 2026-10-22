# Site accounts + chat: setup

What this adds: usernames and passwords for the whole site, with achievements and quest progress saved per user.

## How the two parts relate
The accounts system and the chat are separate programs that share one Worker deployment.

- The accounts code (`src/site/*`) never mentions the chat.
- The chat (`src/chat.js`) has no account logic. It has one link to the accounts: `src/login-check.js`, which can only read. When someone connects, the chat checks whether their browser has a valid site login. If so, it uses that username as their chat name (and locks the name box). If not, they are a guest with a name of their choosing.
- About once a minute, a logged-in chat connection checks again. If the login has ended (logout, password change, account deleted, expired), it becomes a guest. If the database can't be reached, nothing changes.
- The chat never writes to the accounts database. The website never talks to the chat. A login gives no chat powers, no achievements come from chatting, and chat counts nothing.
- The chat's `/register`, `/login <user> <pass>` and `/password` commands are still in the code but switched off. `/login <admin token>` and `/logout` (for the admin token) still work.
- `src/index.js` is the only file that knows both parts. It sends `/api/chat` and `/ws` to the chat, and everything else under `/api/*` to the accounts.

## Where things live
| Piece | File |
|---|---|
| Database tables | `schema.sql` (paste into the D1 console) |
| Account / progress API | `src/site/api.js`, `users.js`, `progress.js`, `crypto.js`, `config.js` |
| Achievements and quests | `src/site/defs.js` (placeholders, yours to fill in) |
| Chat server | `src/chat.js` |
| The chat's one read-only look at the login | `src/login-check.js` |
| Script for your pages | `public/site-account.js` |
| "Log in / Sign up" link that becomes "Signed in as [user]" | `public/site-account-link.js` |
| Log in / sign up page | `public/login.html` |
| Account page (achievements, change password, delete account, log out) | `public/account.html` |
| Owner's account tools (list users, reset a password, delete an account) | `public/account-admin.html` |
| Chat page | `public/index.html` (same file as `standalone/chat.html`) |

## Steps (Cloudflare dashboard, then one deploy)
1. **Create the database.** Storage & Databases -> D1 SQL database -> Create. Name it `site-db`. Copy its **Database ID**.
2. **Create the tables.** Open the database -> Console. Paste all of `schema.sql` and press Execute.
3. **Edit `wrangler.jsonc`.** Paste the Database ID. Replace both `YOURDOMAIN.COM` with your domain, written exactly as visitors see it (with or without `www.`).
4. **Set a secret for the address hashing.** In the `chatroom` folder: `npx wrangler secret put IP_SALT` and enter any long random string.
5. **Deploy.** `npx wrangler deploy`. The chat history and settings are kept (same Worker, same Durable Object).
6. **Add the files to your site repo** (the GitHub repo that Pages deploys): `site-account.js`, `site-account-link.js`, `login.html`, `account.html` and `account-admin.html` at the top level, and `standalone/chat.html` wherever the chat should live (for example `chat.html`). Commit; Pages redeploys.
7. **Put the link on your homepage.** Paste this where the link should appear (use the pages' own paths if they sit in subfolders, for example `../site-account.js`):
   ```html
   <span id="account-link"></span>
   <script src="/site-account.js"></script>
   <script src="/site-account-link.js"></script>
   ```
   Visitors see "Log in / Sign up"; once logged in they see "Signed in as [username]" linking to the account page. The wording and addresses are the settings at the top of `site-account-link.js`.
8. **Try it.** Click the link, sign up, and the page returns you to where you were. Open the chat page: the name box shows your username and is locked. Log out on the account page: the chat returns to your guest name within a moment.

## Owner tools (replace the old chat `/users`, `/op`, `/resetpw`)
Open `account-admin.html` and enter your `ADMIN_TOKEN` (the same one you use for the chat's `/login <token>`; it is kept only in that tab). You can list accounts, reset a password (this ends that person's logins and clears a lockout) and delete an account. The same actions exist as `GET /api/admin/users`, `POST /api/admin/reset-password` and `POST /api/admin/delete-user` with an `Authorization: Bearer <token>` header. If `ADMIN_TOKEN` is not set, these addresses do not exist. They are rate limited.

Chat admin is the token only: `/login <token>` in the chat. There are no admin accounts.

## Optional
- **Human check on sign-up (Turnstile).** Dashboard -> Turnstile -> add a widget for your domain. Put the widget in the register form and pass its token as the third argument of `SiteAccount.register(...)`. Then `npx wrangler secret put TURNSTILE_SECRET`. While the secret is unset the check is off.
- **A page on another domain.** Logins use cookies, so pages must be on the same domain as `/api`. For testing, `https://chatroom.<yourname>.workers.dev/account.html` works because the Worker serves it itself.

## Using it from your own pages
```html
<script src="/site-account.js"></script>
<script>
  SiteAccount.onChange(function (user) { /* user is {username} or null */ });
  SiteAccount.saveQuest("quest_id", { step: 2 }).then(function (r) { /* r.earned lists new achievements */ });
</script>
```
Calls: `me, register, login, logout, changePassword, deleteAccount, progress, saveQuest, event, defs, stats, onChange`.

## What the server decides
- Achievements are only ever granted by the server, from the rules in `defs.js`. The page can ask; it can't claim.
- `event` rules are the exception: the page reports them, so anyone can fake them. Use only for harmless ones.
- User ids come from the login cookie, never from the request. Passwords are PBKDF2 hashes (100,000 rounds, the Workers maximum). The cookie value is never stored, only its hash.

## Stored personal data
Username, password hash and salt, join and last-login times, login sessions, achievements, quest progress. Chat messages stay in the chat's own database under the name used at the time. Visitor IP addresses are never stored; only a salted hash is kept for rate limits, cleared after about two days. A user can delete their own account; their achievements and progress go with it, but their past chat messages stay.

## Consequences of keeping them independent
- Account names are not reserved in the chat. If "Alice" has an account but is not connected, a guest can use the name "Alice". When the real Alice connects while logged in, the guest is moved to another name. Messages already posted under that name stay as they are.
- Old accounts made with the chat's `/register` are not carried over; people register again on the site. The old chat tables stay unused inside the chat's database.
- A logout takes effect in the chat on the next check (up to about a minute), or immediately when the chat page reconnects, which it does on login or logout in another tab.

## Decisions for you
- Whether a site login should ever mean something in the chat (a badge, a reserved name, moderator status). Today it only supplies the name.
- Whether you want email-based recovery. Today a forgotten password means you reset it on `account-admin.html` and tell the person.
- The real achievements and quests (everything in `defs.js` is a placeholder), and which may use unverified `event` rules.
- Whether the site needs a public leaderboard. Nothing is exposed except per-achievement counts.
- Account limit: `MAX_USERS` in `config.js` is 5,000, an arbitrary placeholder. At the limit, new sign-ups get a "closed" message; existing users are unaffected.
- Whether "Signed in as [user]" should also carry a visible "log out" link on the homepage.
- Retention: chat messages are kept until an admin hides them; there is no automatic purge.

## Not verified
Everything was tested with simulated pages and a local stand-in for D1, not on Cloudflare. In particular, PBKDF2 at 100,000 rounds may exceed the 10 ms CPU limit of the Workers Free plan; if sign-up or login fails with CPU errors after deploy, the paid plan is the fix.
