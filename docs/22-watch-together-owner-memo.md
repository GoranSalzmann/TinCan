# 22. Watch Together: decision memo for the owner

> **From:** the planning session. **Date:** 2026-11-02. **Status:** recommendations only; you decide. Evidence and sources are in [19](19-watch-together-adr.md); design in [20](20-watch-together-design.md); plan and spikes in [21](21-watch-together-plan.md); security in [security/watch-together-review.md](security/watch-together-review.md). Items marked *unverified* are in 19 §9 under "not found". Not legal advice.

## In one paragraph

Build our own sync engine (server-authoritative clock, scheduled starts, gentle drift correction) with a small player-adapter interface. Ship a plain HTML5 player first (own files and allow-listed hosts: no third parties, best sync, testable in CI). Add YouTube second, **off by default, opt-in per server and per member**, through its IFrame API with the privacy-enhanced host, labelled best effort until a spike shows how ads and discrete playback rates behave. Keep screenshare as the documented fallback. Nothing fetches a member-supplied URL on the server. About 8 to 12 weeks in total (7 to 10 without uploads), after a 1 to 1.5 week spike round that can still change or stop the plan.

## Decisions only you can take

| # | Decision | Why it is yours | Recommended answer | If you answer otherwise |
|---|---|---|---|---|
| D1 | **Go ahead, and in what shape?** Hybrid (own engine + HTML5 + YouTube opt-in) against HTML5-only, screenshare-only, or adopting an existing app | Direction and effort | **Hybrid, starting with the spike round S1 to S8 as a go/no-go gate** (about 1 to 1.5 weeks). Screenshare alone does not do what you asked (no queue, no per-viewer control) | HTML5-only is the same plan minus W2; adopting SyncTube means a second runtime and a second permission system |
| D2 | **Which providers to support** | Privacy and terms exposure | **HTML5 (own files, allow-listed hosts) first; YouTube second, opt-in; PeerTube later** (AGPL, self-hosted, no ads). **No Twitch live** (cannot sync by time), **no Dailymotion** (no position getter, needs a Player ID), **Vimeo only if asked** (rate control needs a paid owner account, iOS cannot be started by code) | Adding a provider is a small adapter after W2 |
| D3 | **Privacy defaults** | Matches your "no third-party tracking by default" rule | Module **off** by default; every provider **off** by default; three opt-in levels (Host, channel, member notice); nothing loads before the member presses Join; **thumbnails off**; privacy-enhanced YouTube host only | Turning YouTube on by default would break the rule in 15 §6; not recommended |
| D4 | **YouTube compliance stance** | Terms risk is yours to accept; the policies do not mention sync, and the consent rule for remote control is unclear (19 §2) | Ship YouTube as **best effort**, behind its own flag; read the full policy text in spike S7; **ask Google's API compliance audit before announcing YouTube support publicly** (the policy guide offers it for doubtful cases, verified). For the friends group on mkarl.io, accept the grey area meanwhile | If you will not accept any terms risk, drop W2 and use HTML5 + screenshare |
| D5 | **Legal reading for the Host** (privacy notice, GDPR role, "made for kids" rules, hosting rules) | Your legal exposure, your jurisdiction | Keep the instance invite-only; publish the plain notice text (what each provider receives, measured in S4); take a short consultation with counsel **before any public or open-signup use**. I have not verified any statute or case; the sources I could read were secondary | Open signup plus embeds raises the stakes; moderation tooling becomes a launch blocker |
| D6 | **Member uploads in scope?** | Biggest exposure: you would host and serve the files (takedown duties; copyright) and it adds Range serving, claim/release and tooling | **Not in the first release.** Plan W3 as an optional slice, **off by default, `ADD_WATCH_FILES` not given to `@everyone`, never on an open-signup instance**; decide after W1 is in use | Dropping W3 saves 1 to 2 weeks; HTML5 then only plays allow-listed host files |
| D7 | **Arbitrary direct URLs?** (`anyHttpsHost`) | Weakens the CSP (`media-src https:`) and sends members' IPs to any site | **No.** Exact-host allow-list only; the Host can set the flag, `tincan doctor` warns | Allowing it is one config flag |
| D8 | **External review of the outbound fetcher (`safe-fetch`)** and budget | The only server-side outbound fetch we add; `link-previews` will share it | **Yes if budget allows, otherwise a careful second reader**; the design already avoids member-supplied hosts, so this is defence in depth | Skipping is acceptable for friends-only use |
| D9 | **Default control mode and buffering wait** | Product feel | `everyone` may control (friends-sized default); group wait on, capped at 8 s and 2 per viewer per item; per-channel override to `queuer` or `managers` | Large instances should remove `CONTROL_PLAYBACK` from `@everyone` |
| D10 | **Chat beside the video** | Affects scope | **Reuse an existing text channel** shown in a side pane (setting `chatChannelId`); no messages inside watch channels in v1 | Own messages means changing `text-chat` (`type !== "text"` check) |
| D11 | **Naming and placement** | Product wording | "Watch" channel type, feature name "Watch Together"; post-1.0 milestone **M8**, shipped as 1.1 behind a flag | Any name works; the type string `watch` is internal |
| D12 | **Transcoding or any media pipeline** | Cost and exposure | **No.** Members use browser-playable files (mp4 H.264/AAC, webm); the UI says so | A pipeline needs its own ADR and a CPU budget |
| D13 | **Room speed control, repeat modes, provider playlist import** | Scope | Deferred (v1.1 and after); providers disagree on rates; no keyless playlist expansion was verified | Add after real use shows demand |
| D14 | **Start when?** | Capacity | Run the spikes next (they answer the three open technical risks: YouTube sync quality, privacy capture, policy text), then decide W1 with their results in hand | Starting W1 before S1/S2 risks tuning constants twice |

## What I could not verify (so you know the gaps)

- What `youtube-nocookie.com` sets or contacts before play (no official statement found; S4 measures it).
- The full text of YouTube's Developer Policies beyond the first 39,000 characters (nested frames, 30-day storage, ads clauses came from a summary); S7 reads it.
- Vimeo's terms and `dnt` option; Twitch's developer agreement; PeerTube embed-api licence; Video.js licence.
- The Court of Justice judgments (secondary summaries only).
- How the YouTube API reports ads, and whether an iframe we create ourselves keeps its Referer under our headers (S3).

## What happens next if you say yes to D1

1. A branch per spike under `spikes/watch-*`, results written like M0's `RESULTS.md`; the ADR gets an "As measured" addendum and the numbers in 20 §6.5 are replaced.
2. You decide D4 and D6 with S3, S4, S6 and S7 in hand.
3. W0 and W1 start; W2 and W3 only if their gate spikes pass.

## Open items
Everything above is open until you answer; the answers go into 18 §S and the status line of 19.
