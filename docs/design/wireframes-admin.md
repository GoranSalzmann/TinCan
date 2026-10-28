# Wireframes: admin tooling

> Status: **Approved 2026-10-28** (18 T23). Review table, legend and the calls
> marked **U1–U16** are in [README.md](README.md).

Screens W-40 to W-43, all inside Server settings ([W-20](wireframes-settings.md#w-20-settings-shell)).
They cover the 11 §4 admin UI: the role editor with "preview as member", the channel
permission editor with its effective result, and invites. Every page is gated by its
permission; the server re-checks everything (11 §2.5), so the UI rules below are for clarity,
not security.

## W-40 Role editor

Status: Approved · Trace: R-050, 11 §2.2, §2.4, §4

```text
┌─────────────────────────┬────────────────────────────────────────────────────────────────────────┐
│ Roles                   │ Moderator                                          [Preview as member] │
├─────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Higher roles outrank    │ [Display]   [Permissions]   [Members (3)]                              │
│ lower ones. Drag, or    │             ─────────────                                              │
│ use Move up / down.     │ [Filter permissions…]                                                  │
│                         │                                                                        │
│▌ ≡ Admin                │ Text                                                                   │
│  ≡ Moderator            │   Manage messages                                                [on ] │
│  ≡ DJ                   │     Delete and pin other people's messages.                            │
│    @everyone            │   Mention everyone                                               [on ] │
│                         │     Use @everyone to notify the whole server.                          │
│ [+ Create role]         │ Voice                                                                  │
│                         │   Mute members                                                   [on ] │
│ Mika owns this server   │     Server-mute people in voice channels.                              │
│ and has every           │   Move members                                                   [on ] │
│ permission.             │     Move or disconnect people in voice.                                │
│                         │ Moderation                                                             │
│                         │   Ban members                                           [off (locked)] │
│                         │     You don't have this permission, so you can't grant it.             │
│                         │ Advanced                                                               │
│                         │   Administrator                                                  [off] │
│                         │     (!) Grants every permission and ignores channel overrides.         │
│                         ├────────────────────────────────────────────────────────────────────────┤
│                         │ You have unsaved changes.                               [Reset] [Save] │
└─────────────────────────┴────────────────────────────────────────────────────────────────────────┘
```

When the role is above your own:

```text
┌─ Role above yours ─────────────────────────────────────────────────────┐
│ This role is above your highest role (Moderator).                      │
│ You can view it, but you can't edit it.                                │
└────────────────────────────────────────────────────────────────────────┘
```

- **Role list:** ordered by position, highest first; `@everyone` is fixed at the bottom. Reorder by drag or Move up / Move down. Roles above your highest role are listed but locked (11 §2.4).
- **Display tab:** name, colour (shown as a dot and pill only, U7), and "Show members separately" (U12).
- **Permissions tab:** grouped by scope (General, Text, Voice, Moderation, Advanced), each permission a switch with a one-line description. A filter box narrows the list.
- Permissions you don't hold are locked with the reason, because you can't grant what you lack (11 §2.4).
- **Administrator** sits alone in Advanced with a warning, and turning it on asks for confirmation.
- **Members tab:** who has the role, with add and remove (Manage roles).
- Changes are batched behind the unsaved-changes bar; leaving with unsaved changes asks first.
- **Preview as member** opens [W-42](#w-42-preview-as-member) for a member with this role.
- The owner is not a role; the list explains that the owner always has every permission (11 §2.1).

## W-41 Channel permissions

Status: Approved · Trace: R-051, 11 §2.3, §4

```text
┌─────────────────────────┬────────────────────────────────────────────────────────────────────────┐
│ #general                │ @everyone in #general                                                  │
│ Permissions             │   Deny shows ×, Inherit /, Allow √ next to the label                   │
├─────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Overrides               │   View channel            ( ) Deny  (•) Inherit  ( ) Allow             │
│▌ @everyone              │   Send messages           (•) Deny  ( ) Inherit  ( ) Allow             │
│  Moderator              │   Read history            ( ) Deny  (•) Inherit  ( ) Allow             │
│  Bo (member)            │   Attach files            ( ) Deny  (•) Inherit  ( ) Allow             │
│                         │   Add reactions           ( ) Deny  ( ) Inherit  (•) Allow             │
│ [+ Add role or member]  │   Mention everyone        ( ) Deny  (•) Inherit  ( ) Allow             │
│                         │   Manage messages         ( ) Deny  (•) Inherit  ( ) Allow             │
│                         ├────────────────────────────────────────────────────────────────────────┤
│                         │ You have unsaved changes.                               [Reset] [Save] │
└─────────────────────────┴────────────────────────────────────────────────────────────────────────┘
```

The effective result for a chosen member, with the deciding step:

```text
┌─ Effective permissions in #general ──────────────────────────────────────────────┐
│ Check access for  [ Bo ▼ ]    Roles: Moderator, @everyone                        │
│                                                                                  │
│ Permission          Result     Decided by                                        │
│ ──────────────────────────────────────────────────────────────────────────────── │
│ View channel        Allowed    Base: @everyone                                   │
│ Send messages       Allowed    Moderator role override allows (wins over deny)   │
│ Read history        Allowed    Base: @everyone                                   │
│ Add reactions       Allowed    Channel override: @everyone allows                │
│ Manage messages     Allowed    Base: Moderator                                   │
│ Mention everyone    Denied     Member override: Bo denies                        │
│                                                                                  │
│ [Show every step]                                                                │
└──────────────────────────────────────────────────────────────────────────────────┘
```

```text
┌─ Show every step (same steps as `tincan perms explain`) ─────────────────────────┐
│ Send messages                                                                    │
│   1  Base permissions (@everyone + Moderator)            allowed                 │
│   2  @everyone override in #general                      denied                  │
│   3  Role overrides (Moderator)                          allowed                 │
│   4  Member override (Bo)                                no change               │
│   5  Rules: can view the channel, not timed out          no change               │
│      Result                                              Allowed                 │
├──────────────────────────────────────────────────────────────────────────────────┤
│ Special cases: "Bo is an Administrator: every permission; channel overrides      │
│ don't apply."  "Mika owns this server: every permission."                        │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **Overrides list:** roles and members with an override in this channel; "Add role or member" opens a combobox.
- **Rows** show only permissions that apply to the channel type (text rows here; voice channels show Connect, Speak, Video, Share screen, Use voice activity, Mute members, Move members).
- Each row is a three-way choice, Deny / Inherit / Allow, with an icon and the word in each segment (style guide §4); Inherit is the default.
- **Effective result:** pick any member to see their final permissions in this channel and the step that decided each one. "Show every step" expands the same steps as `tincan perms explain` (11 §4), computed by the shared permission function (11 §2.3), so the UI and the server agree.
- The effective panel updates live as you change rows, before you save, so you can see the result of an edit before committing it.
- Implicit rules show as their own step: no View channel means nothing else applies; a timeout removes send, react, speak, video and share (11 §2.3).

## W-42 Preview as member

Status: Approved · Trace: 11 §4

```text
┌─ Preview banner (top of the app, above everything) ──────────────────────────────────────────────┐
│ Previewing as Bo (Moderator). You see what Bo would see. Actions are turned off.  [Exit preview] │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- Shows the app as the chosen member (or a member with the chosen role) would see it: channel list, channels, composer permissions, voice controls.
- Read-only: actions are turned off and say why; nothing is sent.
- Exit returns to the page that started the preview. The banner stays above everything, including dialogs.
- Computed on the client with the shared permission function; it uses only data the admin can already see.

## W-43 Invites

Status: Approved · Trace: R-003, 11 §1.5, §5

```text
┌─ Invite people to Friends of Tin ──────────────────────── [×] ─┐
│ Share this link:                                               │
│ [ https://chat.example.com/invite/k3J9xQ2mPa ]  [Copy]         │
│                                                                │
│ Expires after   [ 7 days        ▼ ]                            │
│ Max uses        [ No limit      ▼ ]                            │
│ Starting role   [ @everyone     ▼ ]   (with Manage roles)      │
│                                                                │
│ The desktop app opens these links too.                         │
│                                              [Make a new link] │
└────────────────────────────────────────────────────────────────┘
```

Server settings, Invites:

```text
┌─ Server settings · Invites ──────────────────────────────────────────────────────┐
│ Link            Created by    Uses      Expires                                  │
│ ──────────────────────────────────────────────────────────────────────────────── │
│ …/k3J9…2mPa     Mika          3 / 10    in 6 days     [Copy] [Revoke]            │
│ …/Q8rT…x1Lm     Bo            1 / ∞     never         [Copy] [Revoke]            │
│                                                                                  │
│ Invite codes are secrets: shown shortened here, copied in full.                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- Opened from the instance menu ("Invite people", needs Create invite) and after setup (W-30).
- Defaults: expires after 7 days, no use limit. Options: 30 minutes, 1 hour, 1 day, 7 days, 30 days, never; uses: 1, 5, 10, 25, 100, no limit.
- "Starting role" appears only with Manage roles and lists only roles below yours.
- Copying shows a short "Copied" toast. The link text is selectable for people who copy by hand.
- The Invites page lists active invites with creator, uses and expiry; revoke asks first. Codes are bearer secrets, so the list shows them shortened (11 §5).

## Not drawn

Members (list with roles, joined date, kick/ban/timeout), Audit log (filterable table), Server
overview (name, icon, disk warning from R-021), Channels (list with reorder) and Modules &
status reuse the table, list and confirm patterns above. Say if you want any drawn before M2.

## Open items

- Whether the role editor needs a "duplicate role" action.
- Invite defaults (7 days, unlimited uses proposed).
