// SPDX-License-Identifier: AGPL-3.0-or-later

/** The release this page was built from. */
export const APP_VERSION: string = __APP_VERSION__;

/** True when the server reports a release other than the build this tab runs. Unknown versions never count as a difference. */
export function isVersionMismatch(
  serverVersion: string | undefined | null,
  own: string = APP_VERSION,
): boolean {
  return typeof serverVersion === "string" && serverVersion !== "" && own !== "" && serverVersion !== own;
}
