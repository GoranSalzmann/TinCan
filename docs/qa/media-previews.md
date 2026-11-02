# Media and link previews: checklist

Design: [23](../23-media-previews.md). Security review: [media-previews-review.md](../security/media-previews-review.md).

**What has been run.** Server rows by automated tests (`apps/server/src/modules/uploads/media.test.ts`, `.../link-previews/link-previews.test.ts`), web rows by component tests (`AttachmentView.test.tsx`, `LinkPreviews.test.tsx`, `fileKind.test.ts`), and a manual pass in the built-in browser against a local server (Chromium, dark and light, 1000 px and phone width) with an animated GIF, a 12 MB GIF, an animated WebP, WAV audio, a recorded MP4 and WebM, text, HTML and binary files, and link cards served by a local test site. **Not run:** real YouTube / X / Vimeo fetches (the dev machine's network was not used for third-party requests), Safari and Firefox codecs, a phone, Caddy in front. Rows marked **(you)** need those.

## A. Automated

- [ ] `pnpm vitest run apps/server/src/modules/uploads apps/server/src/modules/link-previews apps/web/src/modules/chat` is green.
- [ ] `pnpm check` is green.

## B. Animated images

- [ ] A small animated GIF moves in a message without a click, and the **GIF** button pauses it (the button says "Pause animation: name").
- [ ] A GIF over 8 MB shows a still frame and a **▷ GIF 12.0 MB** button; nothing large is downloaded until you press it (network panel: only the `?thumb=1` request).
- [ ] With the system setting "reduce motion" on, even a small GIF shows a still frame and a play button.
- [ ] An animated WebP behaves the same. A static GIF/PNG shows only the still image and no button.
- [ ] A phone-width window shows no sideways scrolling.

## C. Video

- [ ] An uploaded `.mp4` / `.webm` shows a player with controls, no autoplay, a first frame, the size and a Download link.
- [ ] Seeking works; the network panel shows `206 Partial Content` for the file request. **(you)** Behind Caddy on the real host too.
- [ ] Tab/Space/arrows operate the native controls; a screen reader announces "Video: name".
- [ ] **(you)** A `.mov` with HEVC on Firefox shows the "can't play this video" card with a working download link.
- [ ] A video over 1 GiB shows the file card, not a player.

## D. Audio

- [ ] `.wav`, `.mp3`, `.ogg`, `.m4a`, `.flac` files show the audio card with name, size and, once loaded, the duration.
- [ ] Starting one player pauses the one that was playing (audio and video).

## E. File icons

- [ ] A zip, pdf, xlsx, pptx, docx, stl, ttf, json and a plain file each show an icon **and** the type word (Archive, PDF, Spreadsheet, Presentation, Document, 3D model, Font, Code, File).

## F. Text preview

- [ ] `.txt`, `.md`, `.csv`, `.json`, `.log` show the first 8 lines (or 600 characters) in a monospace box; "Only the start is shown." appears when cut.
- [ ] An `.html` file shows its source as text: no heading, no script, no image.
- [ ] A UTF-16 file (with BOM) reads normally; a binary file named `.txt` shows no preview.
- [ ] A message containing only a text file does not show the excerpt in the notification, or in search results.

## G. Link previews

- [ ] Fresh server: Settings › Server › **Link previews** is off; a posted link shows no card and the server logs no outgoing request.
- [ ] Turn it on, post an `https://` article link: a card with site, title, description and an image appears; the image request goes to `/api/v1/link-previews/image/…` (same origin), never to the site. **(you)** On the real host.
- [ ] **(you)** A YouTube link shows title, channel and thumbnail; an X/Twitter link shows the post text (if X still answers without a key) or no card.
- [ ] `<https://…>` in angle brackets, or a link inside a code span, gets no card.
- [ ] A link to `http://127.0.0.1:…`, `http://192.168.x.x`, `http://169.254.169.254/` or `http://[::1]/` gets no card.
- [ ] The **Allowed sites** box already holds the ten default sites before previews were ever switched on; the note says only these and their subdomains are visited; **Restore defaults** brings the list back after an edit.
- [ ] With the default list, a link to a site that is not on it (for example a news site) gets no card and the server makes no request to it; a `github.com` and a `m.youtube.com` link do.
- [ ] Emptying the list says "no site gets a preview" and no link gets a card. Ticking **Allow all sites** shows the red warning and greys out the list; unticking returns to the list.
- [ ] "Never these sites" with a listed domain removes its cards (the deny list wins).
- [ ] A link on an allowed site that redirects to a site that is not allowed gets no card.
- [ ] YouTube card still has its thumbnail although `ytimg.com` is not in the list. **(you)** Real YouTube.
- [ ] The author's and a moderator's **✕** removes the card for everyone; a moderator's removal appears in the audit log as `message.preview.remove`. A member without Manage messages sees no ✕ on someone else's message.
- [ ] Turning previews off again hides all cards after a reload.
- [ ] Turning the setting on or off writes `linkpreviews.settings` in the audit log.

## H. Device and cache

- [ ] The installed app (PWA) does not keep videos, audio, files or preview images in its cache (devtools › Application › Cache storage shows only `/assets/` and `/icons/`).
