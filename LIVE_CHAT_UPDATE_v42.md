# Live Chat v42 — Extra Security, reply timer blocking, and auto-delete

Nothing here needs an env var or a manual migration. The tables and columns are
created the first time the live chat API runs, same as before.

## 1. Extra Security (per chat)

Open a chat in the admin panel → **⋮ More options → Extra Security**.

- **Turn on** requires a password (4–64 characters). It is stored as an scrypt hash
  (`lib/chat-security.ts`). The plain text is never saved.
- While it is on, the visitor can't see admin details: the presence badge, the
  "Abhishek is unavailable" banner, and typing indicators. The header shows
  "Admin" instead. The visitor sees a **Chat password** box. Entering the right
  password unlocks the details on that device for this chat.
- **Reset password** replaces the password and signs every visitor out of the
  unlock. They have to enter the new one.
- **Turn off** clears the password, all unlocks, and the reply timer.
- Wrong guesses are limited to 5 per chat per device, after which that device is
  locked out of the prompt for 10 minutes. The counter is kept in memory, so it
  resets on a cold start.

## 2. Reply timer → device block

Only available while Extra Security is on.

- Pick a timer (15 seconds to 1 hour). It starts when **you** send a message that the
  visitor hasn't answered yet. The visitor sees a live countdown in their chat. Sending more messages does not restart it.
- The visitor's reply stops the countdown on both sides.
- If the deadline passes, the device is blocked from the website. The chat is
  **not** closed by the block: it stays on screen, read-only. The block is stored in `live_chat_device_blocks` and matches on the
  **signed device cookie or the browser fingerprint**. It never uses the IP address.
  Clearing cookies doesn't get around it.
- A blocked visitor sees an overlay on the site, with the blocked chat (read-only)
  on top of it. The chat comes back after a refresh. The **only way to close it** is to
  enter the chat password. Closing it clears the chat from that screen for good, but the
  site block stays. The **AI assistant stays usable** above the overlay. Normal browsing
  without a block is unaffected.
- The block is checked on every live-chat poll, on every public page load, every
  30 seconds, and when the admin list loads. So a visitor who went quiet and
  comes back is blocked straight away, even if your admin tab is closed.
- The admin panel is never blocked, even from the same browser. The check ignores
  `/admin` and `/portal` routes, and admin sessions are exempt on the server.
- **Unblock visitor** (Extra Security menu, or the Ended tab) lifts the block and
  reopens the chat.

## 3. Auto-delete ("Delete after seen / 24 hours / 7 days / never")

Available from the 🕒 button in the visitor's chat header, and from
**⋮ More options → Auto-delete messages** for you.

- The setting belongs to the chat, and **either side** can change it. The chat
  follows whichever choice was made last. Both sides see the change in real time.
- *Seen*: a message is deleted as soon as the other side has read it.
- *24 hours* / *7 days*: deleted that long after it was sent.
- *Never*: the default, same as before this update.
- **Voice notes and photos/videos saved to Chat Media are never auto-deleted.**
  They're considered kept on purpose.
- Deletion happens when either side polls or reads, and in the admin list on a
  one-minute throttle. A message is only removed from the database once it's due,
  so a message that nobody opens is removed at the next poll after its time.

## Files

New:
- `lib/live-chat-policy.ts`: shared options and validators (client-safe)
- `lib/chat-security.ts`: password hashing, wrong-password limiter, sanitizer (server only)
- `lib/client-fingerprint.ts`: browser fingerprint. Reuses the same `__fp_id` key as the existing security detector.
- `app/api/live-chat/block-status/route.ts`: site-wide block check
- `components/live-chat/live-chat-block-gate.tsx`: overlay for blocked devices (mounted in `app/layout.tsx`)
- `components/live-chat/extra-security-modal.tsx`: admin password / timer / unblock
- `components/live-chat/retention-picker.tsx`: auto-delete picker (both sides)

Changed:
- `lib/live-chat-db.ts`: new columns and tables, plus the timer, block, unlock and purge functions
- `app/api/live-chat/route.ts`: block checks, timer start/stop, new actions, admin details hidden while locked
- `app/api/live-chat/presence/route.ts`: admin presence hidden from locked visitors, and not broadcast on secured chats
- `hooks/use-live-chat-realtime.ts`: `messages_deleted` and `retention_changed` events
- `components/live-chat/user-chat-panel.tsx`: password prompt, auto-delete button, block handling
- `components/live-chat/admin-chat-panel.tsx`: Extra Security and auto-delete menu items, Unblock, Blocked and 🔒 badges
- `components/ai-assistant.tsx`: sends the fingerprint on chat start, closes live chat on block, opens the AI on `lc-open-ai`
- `app/layout.tsx`: mounts `LiveChatBlockGate`

## Limits to know about

- **Fingerprints can collide.** Two visitors on identical devices (same model,
  browser, and screen) could share a fingerprint, so blocking one may also block
  the other. The existing security blocking has the same limit.
- **The site overlay is a client-side gate.** Someone who knows the browser
  devtools well can get past it. The server still refuses live-chat actions from a
  blocked device, and the admin's details are withheld by the server, not just by
  the UI.
- **A visitor on a new browser** (different fingerprint, new cookie) is not
  blocked until they start or resume a chat. A phone-number resume is refused if
  the conversation itself is blocked.
- **Privacy.** Fingerprinting and the block list are personal data under India's
  DPDP Act. Add a line about this to your Privacy Policy and Terms before using
  the timer in production.

## 4. Blocked chats stay open; how a visitor gets unblocked

- A block never ends the chat. Only the visitor or the admin can end it. The
  visitor sees the chat read-only, and the admin sees a "Blocked" tag.
- **Admin:** in the open chat, use the red banner's **Unblock** button or the
  **⋮ → Unblock visitor** menu item. The chat reopens for the visitor.
- **Visitor:** on the block screen, **🙋 I know Abhishek personally** uses the same
  relation and name check as the site-wide self-unblock (`/api/live-chat/self-unblock`).
  It's rate limited. A successful unblock brings the same chat back.
- A chat the visitor closed with the chat password stays closed when unblocked.

## 5. "Delete after seen" with a delay in seconds

- Picking **Delete after seen** opens a list of delays: Instantly, 5, 10, 15, 30, 60,
  120 or 300 seconds. Either the visitor or the admin can choose.
- The timer starts when the other side has read the message (`read_at`), so there
  is time to finish reading it. "Instantly" keeps the old behaviour.
- The setting is stored per chat in `retention_seen_delay`. Deletion is checked on
  the same poll cycle as before (about every 4 seconds), so a delay can be a few
  seconds longer than chosen.
