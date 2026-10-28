// SPDX-License-Identifier: AGPL-3.0-or-later
import { writeFileSync } from "node:fs";
import { renderTokensCss } from "../src/theme/css.js";

const target = new URL("../src/theme/tokens.generated.css", import.meta.url);
writeFileSync(target, renderTokensCss());
console.log(`wrote ${target.pathname}`);
