// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ConfigIssue {
  message: string;
  /** What to change, shown as "→ hint" under the message (04 §4). */
  hint?: string;
}

/** Raised for steps 1 to 4 of the boot sequence; the CLI prints it and exits non-zero. */
export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(ConfigError.format(issues));
    this.name = "ConfigError";
    this.issues = issues;
  }

  static format(issues: ConfigIssue[]): string {
    return issues.map((i) => `Config error: ${i.message}${i.hint ? `\n  → ${i.hint}` : ""}`).join("\n");
  }
}
