// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { API_VERSION } from "@tincan/shared";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export const VERSION = pkg.version;
export { API_VERSION };
export const DEFAULT_SOURCE_URL = "https://github.com/GoranSalzmann/TinCan";
