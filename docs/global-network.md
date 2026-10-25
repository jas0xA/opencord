# The global OpenCord network

Every OpenCord host can join one shared network. Nobody owns it: hosts keep it running together. When a host is part of it:

- **Usernames are unique across every host.** `alice` can only exist once on the whole network.
- **Friends and DMs work across hosts.** Add `bob@chat.example.org` from your own server; messages, edits and deletes go both ways.
- **Calls are split between both hosts.** Each person connects to their own host's media server, and the two hosts exchange a single copy of each stream.
- **Global servers** show up in every user's server browser (*Explore Servers → Global Community*). People from other hosts join with their own account; they're signed in to your host automatically.
- **Global cosmetics and themes** can be found and used by anyone on the network.

It's on by default (`[federation] enabled = true`). It only needs a public address.

## Setup

1. Set the address other hosts use to reach you:

   ```toml
   [server]
   public_url = "https://chat.example.com"
   ```

   Without `public_url` the server logs `[federation] disabled` and runs on its own.

2. Give it at least one other host to start from (any host that helps host the network):

   ```toml
   [federation]
   seeds = ["https://opencord.example.org"]
   ```

   From there it discovers every other host through the directory. You can also edit the list in the app under **User Settings → Server Admin → Global Network**.

3. Restart the server. In **Server Admin → Global Network** you'll see the peers it synced with and how many hosts, usernames, servers, cosmetics and themes it knows about.

### Helping host the network

`help_host = true` (the default) means your server stores the full shared directory and serves it to other hosts, which keeps the network alive if any single host disappears. It costs a little disk space (small text records) and bandwidth.

Turn it off with `help_host = false` (or the toggle in Server Admin) if you'd rather not. Your users keep every network feature; your server just stops serving the directory to others. It still publishes its *own* records (its users, global servers and cosmetics).

## How it works

### Host identity

On first start each host creates an Ed25519 key pair, stored as `data/host-key.pem`. Everything a host says on the network is signed with it.

Other hosts learn a host's key the first time they see it, and **pin** it. If a host later shows up with a different key (for example, it was reinstalled without restoring `host-key.pem`), other hosts refuse it until their admin clicks **Reset key** next to that host in Server Admin. Back up `host-key.pem` with the rest of `data/`.

### The directory

The shared directory is a set of small signed records:

| Record | Written by | Contents |
|---|---|---|
| `host:<origin>` | the host itself | name, description, public key, whether it helps host |
| `user:<name>` | the host where the user lives | which host owns the name, and since when |
| `guild:<origin>\|<id>` | the server's host | name, description, icon, member count, a listing invite |
| `item:<origin>\|<id>` | the creator's host | cosmetic name, category, asset URL, whether copies are allowed |
| `theme:<origin>\|<id>` | the author's host | theme name, description, where to download it |

Every few seconds to minutes (`sync_interval_s`), each host pulls new records from up to three random helping hosts. Each record is checked before it's stored:

- its signature must match the key of the host that wrote it
- a host can only write records under its own origin (`guild:`, `item:`, `theme:` keys contain the origin)
- records can't be dated in the future, and are limited in size

Large content (images, theme code) is never copied into the directory. Records point to the host that has it.

### Usernames

When someone registers or renames, their host checks the directory **and** asks a few peers directly, so a name taken a moment ago on another host is caught. The host then publishes a `user:` claim.

If two hosts claim the same name at almost the same moment (inside one sync interval), the earlier claim wins everywhere. The other account keeps working on its own host but isn't reachable by that name from other hosts. In practice this needs two registrations within a few seconds of each other.

Accounts that existed before a host joined the network are claimed on first start. If one collides with an older claim elsewhere, it keeps working locally.

### Users from other hosts

Someone from another host appears on your host as `name@their.host`. They have no password here and can't log in directly. They only exist as a friend or DM partner, or because they signed in through their home host (see below).

### Friends and DMs

`alice@a.example` adds `bob@b.example`:

1. Host A creates a local entry for Bob and sends a signed `friend_request` to host B.
2. Host B applies Bob's privacy settings (only *Everyone* allows requests from other hosts) and shows the request.
3. When Bob accepts, B sends `friend_accept`; both hosts now have the friendship and a DM.

Messages in that DM are delivered host-to-host through an **outbox with retries**: if the other host is down, messages are retried for about two days. Only friends can message each other across hosts; anything else is dropped, so the relay can't be used for spam.

Blocking or removing a friend is mirrored to the other host.

### Calls across hosts

When Alice (host A) calls Bob (host B):

1. Host B is told Alice joined; Bob's client **rings** and shows Alice in the call.
2. When Bob answers, the two hosts open a **mediasoup pipe transport** to each other (SRTP-encrypted UDP).
3. Each host pipes its own user's microphone, camera and screen streams through it.

Each client only talks to its own host, and each host sends each stream to the other host once. The work of the call is split evenly.

**Requirement:** the `[sfu]` media port range must accept UDP from other OpenCord hosts, and `announced_ip` (or `public_url`'s host) must be an address the other host can reach.

### Visiting other hosts

To join a global server on another host, the app:

1. asks your home host for a **sign-in assertion**: a short-lived (2 minute) token signed by your home host, addressed to that one host
2. sends it to the other host, which checks the signature against your home host's pinned key and signs you in as `you@your.host`

Your password never leaves your home host. The other host is listed in the app's server list, so you can switch back and forth.

## Global servers

Server owners (or anyone with *Manage Server*) can open **Server Settings → Discovery**:

- **List on this host:** shows the server under *Explore Servers → This Server* for everyone on your host, joinable in one click.
- **Make this a global server:** publishes it to the network so it appears under *Explore Servers → Global Community* on every host.

Listing creates a permanent invite (shown on the same page). Deleting it under *Invites* resets it. Listings refresh every 30 minutes and whenever the server's name or icon changes.

## Global cosmetics and themes

- **Marketplace:** when publishing an item, tick *List on the global network*. Others find it under *Marketplace → Global* and claim it. The image stays on the creator's host.
- **Themes:** set a theme's visibility to *Global (whole network)*. Others find it under *User Settings → Themes → Global*.

Both have **Don't allow copies**: others can use the item or theme, but nobody else can publish the same design or code as their own, and theme source is hidden in the editor. Images and CSS have to reach the user's device to be displayed, so this stops casual copying, not a determined person.

Private items and themes (*Only me*) are never published.

## API reference (host to host)

All under `/api/v1/federation`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/key` | `{ origin, pubkey }` of this host |
| GET | `/records?since=<cursor>` | directory records changed after a cursor (500 per page) |
| GET | `/records/<key>` | one record |
| GET | `/users/<username>` | public profile of a local user |
| POST | `/inbox` | signed events: friend requests, DMs, call signaling |
| POST | `/login` | exchange a sign-in assertion for a session |
| GET | `/themes/<id>` | code of a global theme |

Signed requests carry `X-OpenCord-Host`, `X-OpenCord-Date` and `X-OpenCord-Signature`. The signature is Ed25519 over `POST\n<path>\n<date>\n<sha256(body)>`, and requests more than five minutes old are rejected.

## Troubleshooting

| Symptom | Check |
|---|---|
| Admin page says *Not connected* | `public_url` set? Restarted after enabling? |
| No peers / 0 hosts | Is a seed reachable? `curl https://seed.host/api/v1/federation/key` |
| A host shows many failures | It's down or blocks your requests. Failing hosts are skipped after 20 failures until they recover (re-adding them as a seed resets the counter) |
| Friend request never arrives | The recipient must allow friend requests from *Everyone*. Check *queued deliveries* in Server Admin |
| Cross-host call rings but has no audio | UDP media ports blocked between the hosts, or `announced_ip` unreachable from the other host |
| A host is rejected after reinstalling | It lost `host-key.pem`. Other admins click **Reset key** for it |
