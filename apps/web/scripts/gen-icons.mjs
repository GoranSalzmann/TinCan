// SPDX-License-Identifier: AGPL-3.0-or-later
// Renders the PNG icons of the web manifest from the brand logo (public/brand/logo.svg), and the share card that link
// previews in other apps show (public/brand/og-image.png, 1200x630, from logo-dark.svg). Run by hand when the artwork
// changes:
//   node apps/web/scripts/gen-icons.mjs
// It borrows `sharp` from the server workspace, so the web package needs no image dependency. The Apple touch icon
// (180 px, opaque because iOS fills transparency with black) is supplied with the artwork and is not generated here.
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const server = createRequire(new URL("../../server/package.json", import.meta.url));
const sharp = server("sharp");
const pub = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));

/** The page colour of the light theme. Only the maskable icon sits on it: the OS crops that one to its own shape. */
const BACKDROP = "#EFEBE4";
const logo = await readFile(pub("brand/logo.svg"));

/**
 * The logo at `scale` of the canvas, centred. Without a backdrop the icon is transparent (the install icon, the
 * taskbar); maskable icons need an opaque safe zone of about 20 %.
 */
async function icon(size, scale, name, backdrop) {
  const inner = Math.round(size * scale);
  const art = await sharp(logo, { density: 384 })
    .resize(inner, inner, { fit: "contain", background: "#0000" })
    .png()
    .toBuffer();
  const file = await sharp({
    create: { width: size, height: size, channels: 4, background: backdrop ?? "#0000" },
  })
    .composite([{ input: art, gravity: "centre" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(pub(`icons/${name}`), file);
}

/** The share card: the dark page colour with a faint dot grid, the logo centred. No text, so no font is needed. */
async function shareCard() {
  const [w, h, step] = [1200, 630, 30];
  let dots = "";
  for (let y = step / 2; y < h; y += step)
    for (let x = step / 2; x < w; x += step) dots += `<circle cx="${x}" cy="${y}" r="1.4"/>`;
  const backdrop = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#0F0E0C"/><g fill="#EFEBE4" fill-opacity="0.08">${dots}</g></svg>`;
  const art = await sharp(await readFile(pub("brand/logo-dark.svg")), { density: 384 })
    .resize(420, 420, { fit: "contain", background: "#0000" })
    .png()
    .toBuffer();
  const file = await sharp(Buffer.from(backdrop))
    .composite([{ input: art, gravity: "centre" }])
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();
  await writeFile(pub("brand/og-image.png"), file);
}

await icon(192, 0.96, "icon-192.png");
await icon(512, 0.96, "icon-512.png");
await icon(512, 0.62, "icon-maskable-512.png", BACKDROP);
await shareCard();
console.log("wrote 3 icons and the share card");
