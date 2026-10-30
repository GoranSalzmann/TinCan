// SPDX-License-Identifier: AGPL-3.0-or-later
// Renders the PNG icons of the web manifest from the SVG sources. Run by hand when the artwork changes:
//   node apps/web/scripts/gen-icons.mjs
// It borrows `sharp` from the server workspace, so the web package needs no image dependency.
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const server = createRequire(new URL("../../server/package.json", import.meta.url));
const sharp = server("sharp");
const out = (name) => fileURLToPath(new URL(`../public/icons/${name}`, import.meta.url));

const any = await readFile(out("icon.svg"));
const maskable = await readFile(out("icon-maskable.svg"));
const jobs = [
  [any, 192, "icon-192.png"],
  [any, 512, "icon-512.png"],
  [any, 180, "apple-touch-icon.png"],
  [maskable, 512, "icon-maskable-512.png"],
];
for (const [svg, size, name] of jobs) {
  await writeFile(
    out(name),
    await sharp(svg, { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer(),
  );
}
console.log(`wrote ${jobs.length} icons`);
