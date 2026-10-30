// SPDX-License-Identifier: AGPL-3.0-or-later
// Renders the PNG icons of the web manifest from the brand logo (public/brand/logo.svg). Run by hand when the artwork
// changes:
//   node apps/web/scripts/gen-icons.mjs
// It borrows `sharp` from the server workspace, so the web package needs no image dependency. The Apple touch icon
// (180 px) is supplied with the artwork and is not generated here.
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const server = createRequire(new URL("../../server/package.json", import.meta.url));
const sharp = server("sharp");
const pub = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));

/** The page colour of the light theme; the logo has a transparent background, so it sits on this. */
const BACKDROP = "#F1F3F6";
const logo = await readFile(pub("brand/logo.svg"));

/** The logo at `scale` of the canvas, centred on the backdrop (maskable icons need a safe zone of about 20 %). */
async function icon(size, scale, name) {
  const inner = Math.round(size * scale);
  const art = await sharp(logo, { density: 384 })
    .resize(inner, inner, { fit: "contain", background: "#0000" })
    .png()
    .toBuffer();
  const file = await sharp({ create: { width: size, height: size, channels: 4, background: BACKDROP } })
    .composite([{ input: art, gravity: "centre" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(pub(`icons/${name}`), file);
}

await icon(192, 0.86, "icon-192.png");
await icon(512, 0.86, "icon-512.png");
await icon(512, 0.62, "icon-maskable-512.png");
console.log("wrote 3 icons");
