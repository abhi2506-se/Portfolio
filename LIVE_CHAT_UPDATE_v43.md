# Live Chat v43: co-admin names and replies, video compression

## Co-admin in live chat
- A co-admin's reply shows the co-admin's name to the visitor, not "Abhishek". The
  name is stored per message (`sender_name`) and per chat (`agent_name`,
  `agent_role`, `agent_at`).
- A co-admin can reply only while the real admin is offline. The server enforces
  this (403 in `admin_reply`), and the co-admin's reply box is hidden while the real
  admin is online.
- A co-admin's heartbeat doesn't mark Abhishek as online, and doesn't write the
  admin's presence on a chat. Only the real admin's session does.
- A visitor sees the co-admin's name in the header and typing indicator while the
  real admin is away. The "unavailable" banner is hidden then. It goes back to
  "Abhishek" as soon as the real admin is online, or after 30 minutes without a
  co-admin reply.

## Video compression before sending
- Videos larger than 6 MB are re-encoded in the browser (720px max side, about 12 MB
  target size) before upload, for both the visitor and the admin.
- It runs in real time, so a 1-minute clip takes about a minute. A progress
  indicator is shown while it runs.
- Videos at or under 6 MB, or any video that can't be compressed on the device, are
  sent as they are. The result is used only if it's smaller than the original.
- Still over the 25 MB upload limit after compression: the send is stopped.

## Files
- New: `lib/live-chat-auth.ts`, `lib/video-compress.ts`, this file.
- Changed: `lib/live-chat-db.ts` (agent and sender columns, `setAgent`,
  `setMessageSenderName`), `app/api/live-chat/route.ts`,
  `app/api/live-chat/presence/route.ts`, `app/api/live-chat/admin-status/route.ts`,
  `components/live-chat/user-chat-panel.tsx`, `admin-chat-panel.tsx`,
  `message-bubble.tsx`, `reply-preview.tsx`.

## Known limits
- The media gallery still labels admin media "Abhishek". Message bubbles and reply
  labels use the real sender name.
- Compression runs at real-time speed, and a hidden or locked tab can slow it down.
