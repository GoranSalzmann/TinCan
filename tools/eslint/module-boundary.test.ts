// SPDX-License-Identifier: AGPL-3.0-or-later
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";
import rule from "./module-boundary.js";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, sourceType: "module" },
});

const file = "apps/server/src/modules/voice/service.ts";

tester.run("module-boundary", rule, {
  valid: [
    { code: 'import { x } from "./helpers.js";', filename: file },
    { code: 'import { x } from "../voice/other.js";', filename: file },
    { code: 'import type { AccountsApi } from "../accounts/api.js";', filename: file },
    { code: 'import { type AccountsApi } from "../accounts/api.js";', filename: file },
    { code: 'export type { AccountsApi } from "../accounts/api.js";', filename: file },
    { code: 'import { defineModule } from "../../framework/types.js";', filename: file },
    { code: 'import { z } from "zod";', filename: file },
    // files outside modules/ are not restricted (boot, cli)
    { code: 'import { x } from "./modules/accounts/service.js";', filename: "apps/server/src/boot.ts" },
    { code: 'import { x } from "../modules/accounts/service.js";', filename: "apps/server/src/cli/init.ts" },
  ],
  invalid: [
    {
      code: 'import { AccountsService } from "../accounts/service.js";',
      filename: file,
      errors: [{ messageId: "crossModule" }],
    },
    {
      code: 'import type { Row } from "../accounts/schema.js";',
      filename: file,
      errors: [{ messageId: "crossModule" }],
    },
    {
      code: 'import { x } from "../accounts/api.js";',
      filename: file,
      errors: [{ messageId: "valueApi" }],
    },
    {
      code: 'export { x } from "../channels/service.js";',
      filename: file,
      errors: [{ messageId: "crossModule" }],
    },
    {
      code: 'const m = await import("../accounts/service.js");',
      filename: file,
      errors: [{ messageId: "crossModule" }],
    },
    {
      code: 'import { x } from "../../modules/accounts/users.js";',
      filename: file,
      errors: [{ messageId: "crossModule" }],
    },
    {
      code: 'import x from "../accounts/index.js";',
      filename: String.raw`apps\server\src\modules\voice\routes.ts`,
      errors: [{ messageId: "crossModule" }],
    },
  ],
});
