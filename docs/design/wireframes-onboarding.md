# Wireframes: setup, joining and saved servers

> Status: **Approved 2026-10-28** (18 T23). Review table, legend and the calls
> marked **U1–U16** are in [README.md](README.md).

Screens W-30 to W-34: first-run setup for the Host, the desktop first launch, the invite
page, joining and logging in, and the desktop switcher for saved servers. These screens are
centred cards on `--color-bg-sidebar`, at most `--size-dialog-md` wide, and work the same at
every breakpoint.

## W-30 First-run setup

Status: Approved · Trace: R-054, 11 §1.4, 14 §4, K-21

```text
┌─ Set up Tin Can · Step 1 of 4: Setup token ──────────────────┐
│                                                              │
│  Enter the setup token.                                      │
│  `tincan init` printed it in the server log, and it is saved │
│  in data/setup-token on the server.                          │
│                                                              │
│  Setup token  [                                        ]     │
│                                                              │
│                                                  [Continue]  │
├──────────────────────────────────────────────────────────────┤
│  (!) That token doesn't match. Check the server log for the  │
│      current one.                                            │
└──────────────────────────────────────────────────────────────┘
```

```text
┌─ Set up Tin Can · Step 2 of 4: Your account ─────────────────┐
│                                                              │
│  You'll be the owner of this server.                         │
│                                                              │
│  Display name  [ Mika                                   ]    │
│  Username      [ mika                                   ]    │
│                2 to 32 characters: a-z, 0-9, dot, dash, _    │
│  Password      [ ••••••••••••••                 ] [Show]     │
│                At least 10 characters · Strong               │
│                                                              │
│                                            [Create account]  │
└──────────────────────────────────────────────────────────────┘
```

```text
┌─ Set up Tin Can · Step 3 of 4: Your community ───────────────┐
│                                                              │
│  Name   [ Friends of Tin                                 ]   │
│  Icon   [Upload image]  (optional)                           │
│                                                              │
│  We've made #general and the Lounge voice channel to start.  │
│                                                              │
│                                                  [Continue]  │
└──────────────────────────────────────────────────────────────┘
```

```text
┌─ Set up Tin Can · Step 4 of 4: Server checks ────────────────┐
│                                                              │
│  [ok]  HTTPS certificate                 OK                  │
│  [ok]  Realtime connection (WebSocket)   OK                  │
│  [ok]  Voice server reachable            OK                  │
│  [!!]  Voice media port (UDP 7882)       Not reachable       │
│  [ok]  Relay (TURN/TLS 5349)             OK                  │
│  [ok]  Public IP matches                 OK                  │
│                                                              │
│  Some people may not be able to use voice until UDP 7882 is  │
│  open. Voice still works through the relay, a bit slower.    │
│  [How to fix this]                                           │
│                                                              │
│  [Run again]                                       [Finish]  │
└──────────────────────────────────────────────────────────────┘
```

- Shown at `/setup` while the server returns `SETUP_REQUIRED`; every other URL redirects here (11 §1.4).
- Step 1 checks the token before showing anything else, so a stranger who finds the page learns nothing.
- Step 2 creates the owner. Username rules and the password policy (10 to 256 characters, common passwords refused) come from 11 §1.1, with an inline strength hint.
- Step 3 names the instance and sets the icon; the default channels already exist (11 §1.4).
- Step 4 runs the server checks from 14 §4. Failures don't block Finish: voice may still work through the relay, and the copy says who is affected.
- Finish opens the app with the invite dialog ([W-43](wireframes-admin.md#w-43-invites)) so the Host can invite friends straight away.
- Back moves to the previous step; Enter submits the step.

## W-31 Desktop first launch and add server

Status: Approved · Trace: 13 §6, 13 §4.5

```text
┌─ Tin Can (first launch) ─────────────────────────────────────┐
│                                                              │
│                      Welcome to Tin Can                      │
│                                                              │
│  Server address or invite link                               │
│  [ chat.example.com  or  https://…/invite/…           ]      │
│                                                  [Continue]  │
│                                                              │
│  No server yet? Ask whoever runs yours for an invite link.   │
│  Running your own?  [Read the host guide]                    │
└──────────────────────────────────────────────────────────────┘
```

```text
┌─ Server found ───────────────────────────────────────────────┐
│                                                              │
│  (FT)  Friends of Tin                                        │
│        chat.example.com · 42 members                         │
│                                                              │
│  [Log in]   [Create an account with an invite]               │
│                                    [Use a different server]  │
└──────────────────────────────────────────────────────────────┘
```

```text
┌─ Errors (one at a time, under the field) ────────────────────┐
│  (!) Couldn't reach chat.example.com. Check the address and  │
│      your connection.                                        │
│  (!) chat.example.com's security certificate isn't valid, so │
│      Tin Can won't connect to it.                            │
│  (!) chat.example.com doesn't look like a Tin Can server.    │
│  (!) This server needs a newer Tin Can.  [Update]            │
└──────────────────────────────────────────────────────────────┘
```

- One field accepts a server address or an invite link; an invite link skips straight to Join ([W-33](#w-33-join-log-in-and-reset-code)).
- The app fetches the public instance preview (`GET /invites/:code`, or the instance info) before asking for credentials.
- A bad TLS certificate is a hard stop with no "continue anyway" (13 §3).
- The same flow opens from the rail's "+" (W-34) and from a `tincan://invite/…` deep link (13 §4.5).

## W-32 Invite page (web)

Status: Approved · Trace: R-002, R-003, 11 §1.5, 13 §4.5

```text
┌─ chat.example.com/invite/k3J9xQ2mPa ─────────────────────────┐
│                                                              │
│                             (FT)                             │
│                 You've been invited to join                  │
│                        Friends of Tin                        │
│                    42 members · 6 online                     │
│                                                              │
│         [Open in Tin Can]      [Continue in browser]         │
│                                                              │
│      No app yet?  [Download for Windows]  Other systems      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

```text
┌─ Invalid, expired or used up ────────────────────────────────┐
│  This invite has expired or been used up. Ask the person who │
│  sent it for a new one.                                      │
└──────────────────────────────────────────────────────────────┘
┌─ Already a member ───────────────────────────────────────────┐
│  You're already a member of Friends of Tin.          [Open]  │
└──────────────────────────────────────────────────────────────┘
```

- `https://host/invite/<code>` shows the instance name, icon and member count without logging in (11 §1.5).
- "Open in Tin Can" uses the `tincan://` link; if nothing happens within a few seconds the page offers the download.
- The download button names the visitor's OS; other systems are one click away.
- Invalid, expired and used-up invites all show the same message, and so does an invite a banned person tries, so the page leaks nothing.

## W-33 Join, log in and reset code

Status: Approved · Trace: R-001, R-004, 11 §1.1, §1.3, §1.6, §1.7

```text
┌─ Join Friends of Tin ────────────────────────┐   ┌─ Log in to Friends of Tin ───────────────────┐
│ Display name  [ Ann                      ]   │   │ Username  [ ann                          ]   │
│ Username      [ ann                      ]   │   │ Password  [ ••••••••••         ] [Show]      │
│               a-z, 0-9, . _ - · 2–32 long    │   │                                     [Log in] │
│ Password      [ ••••••••••••     ] [Show]    │   │ ──────────────────── or ──────────────────── │
│               At least 10 characters         │   │ [Log in with Authentik]   (if OIDC is on)    │
│                                              │   │ Have a reset code?  [Use it]                 │
│                        [Join Friends of Tin] │   ├──────────────────────────────────────────────┤
│ Already have an account?  [Log in]           │   │ (!) Username or password is incorrect.       │
└──────────────────────────────────────────────┘   │ (!) Too many attempts. Try again in 30 s.    │
                                                   └──────────────────────────────────────────────┘

┌─ Use a reset code ───────────────────────────┐
│ Your server admin gave you a one-time code.  │
│                                              │
│ Reset code    [ ____-____ ]                  │
│ New password  [ ••••••••••       ] [Show]    │
│                               [Set password] │
│ This signs you out on every other device.    │
└──────────────────────────────────────────────┘
```

- **Join** registers with the invite code (`POST /auth/register`). Errors sit under the field they belong to. The username is checked for availability as you type (debounced).
- **Log in** shows one generic error for unknown user or wrong password (11 §1.3) and a countdown when rate-limited. The OIDC button appears only when that adapter is on, labelled with the provider name from config (11 §1.7).
- **Reset code** redeems an admin-issued one-time code (11 §1.6) and says up front that it signs out other devices.
- Password fields have Show buttons and never block paste (password managers).

## W-34 Saved servers switcher

Status: Approved · Trace: 13 §6, 18 §F (saved-servers switcher in v1) · Calls: U5, U14

```text
┌──────┐
│ ┌──┐ │
│▌│FT│ │  ← Active server: connected
│ └──┘ │
│ ┌──┐ │
│ │GN│ │  ← Saved, not connected: no unread badges
│ └──┘ │
│ ┌──┐ │
│ │+ │ │  ← Add a server (W-31)
│ └──┘ │
└──────┘
```

Right-click menu, switch confirmation and remove confirmation:

```text
┌─ Gaming Night ───────────────┐   ┌─ Confirm ────────────────────────────────────────┐
│ Switch to this server        │   │ Switch to Gaming Night?                          │
│ Rename on this device        │   │                                                  │
│ Move up                      │   │ You'll leave the Lounge voice channel in         │
│ Move down                    │   │ Friends of Tin.                                  │
│ Copy address                 │   │                                                  │
├──────────────────────────────┤   │                  [Stay] [Leave voice and switch] │
│ Remove from this device      │   └──────────────────────────────────────────────────┘
└──────────────────────────────┘

┌─ Confirm ────────────────────────────────────────┐
│ Remove Gaming Night from this device?            │
│                                                  │
│ You'll be signed out here. Your account and      │
│ messages stay on the server.                     │
│                                                  │
│                                [Cancel] [Remove] │
└──────────────────────────────────────────────────┘
```

- Desktop only (U5). Each saved server is an icon in the rail with its name in a tooltip; the active one has the start-edge bar.
- One active connection at a time (13 §6), so other servers show no unread badges (U14).
- Switching while in voice asks first; "Stay" is the default button. Switching without voice is immediate.
- "Rename on this device" sets a local label; it never changes the server's name.
- "Remove from this device" signs out and deletes the token from the OS keychain (13 §6, 11 §1.2).
- Keyboard: the rail is a vertical toolbar; Ctrl+Alt+↑/↓ (Cmd+Option on macOS) switches servers (proposed).

## Open items

- Whether setup step 4 should also offer to create the first invite inline instead of after Finish.
- Username availability check while typing leaks which usernames exist to invite holders; acceptable for friends-scale instances? (11 §1.3 avoids this for login.)
- Server-switch shortcut (Ctrl+Alt+↑/↓ proposed).
