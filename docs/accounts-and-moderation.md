# Accounts and moderation

## Usernames

- 3 to 32 characters: lowercase letters, numbers, `_` and `.` (not starting or ending with a dot, no `..`).
- **Unique across the whole OpenCord network** when the host is part of the [global network](global-network.md); otherwise unique on the host.
- People on other hosts appear as `name@their.host`. Add them as friends by typing that full name.

Accounts created before the 3-character minimum keep their names.

## Password rules

New passwords (registration, password change and reset) must:

- be at least 8 characters (or `[registration] min_password_length` if higher)
- contain at least one letter and one number
- not be a well-known password (`password1`, `12345678`, …)
- not contain the username
- not be one repeated character

The app checks as you type and shows what's missing. Passwords are hashed with Argon2id.

## Several accounts on one email

One email address can own several accounts (up to `[registration] max_accounts_per_email`, default 5). Each has its own username, password, friends and servers.

- **Create one:** *User Settings → Account → Accounts → Add Account*. It uses the same email, and you confirm with your current password. The app switches to it straight away.
- **Switch:** the same section lists accounts signed in on this device, with **Switch**. The other account stays signed in, so you can switch back without a password. Accounts on your email that aren't signed in on this device are listed too, with **Log in**.
- **Logging in with the email:** the password picks the account. If several accounts on that email share the same password, the app asks which one.
- **Password reset:** the reset email contains a code for each account on that address.

## Profile pictures and banners

Avatars, profile banners, server icons and server banners can be **cropped and repositioned** when uploading (drag to move, scroll or slider to zoom), and again later with **Crop / Reposition**.

This works for every image type, **including animated GIF, APNG and WebP**. The crop is applied when the image is displayed, so animations are kept. Avatars are always shown as a circle.

## Message reports

Anyone can report a message: right-click it (or use the ⋯ menu) → **Report Message** → pick a reason and optionally add details. The reporter stays anonymous to the person reported.

Reports go to:

- **Server moderators** (anyone with *Manage Messages*): *Server Settings → Reports*, for messages in that server.
- **Instance admins:** *User Settings → Server Admin → Message Reports*, for every report, including DMs.

Each report keeps a **copy of the message as it was when reported**, so deleting the message doesn't erase the evidence. Moderators can:

| Action | Effect |
|---|---|
| **Delete Message** | Deletes it for everyone and resolves all reports about it |
| **Mark Resolved** | Resolves without deleting (e.g. after a warning or ban) |
| **Dismiss** | Closes the report as not a problem |

Several reports about the same message are grouped (*3 reports*), and resolving one resolves them all. Filter by *Open*, *Resolved* or *Dismissed*.

The API: `POST /api/v1/channels/<channel>/messages/<message>/report` with `{ reason, details }`, where `reason` is one of `spam`, `harassment`, `hate`, `nsfw`, `violence`, `self_harm`, `illegal`, `other`. Queues: `GET /api/v1/guilds/<id>/reports`, `GET /api/v1/admin/reports`. Actions: `POST /api/v1/reports/<id>/resolve` with `{ action: "dismiss" | "delete_message" | "resolve" }`.

## Friends and DMs

When a friend request is accepted, the DM appears in **both** people's Direct Messages list right away, including between hosts.
