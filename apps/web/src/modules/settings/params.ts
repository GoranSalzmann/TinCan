// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMatch } from "react-router-dom";

/**
 * The settings layer is drawn by the app layout, above the route that matched, so `useParams` there
 * cannot see the child route's parameters. Match the path directly instead.
 */
export function useSettingsParams(): { section: string; id: string | undefined } {
  const match = useMatch("/settings/:section/:id?");
  return { section: match?.params.section ?? "account", id: match?.params.id };
}
