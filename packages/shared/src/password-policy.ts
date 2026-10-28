// SPDX-License-Identifier: AGPL-3.0-or-later

/** 11 §1.1: 10–256 characters, no composition rules, common passwords refused (offline list). */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

export type PasswordProblem = "too_short" | "too_long" | "too_common";

/**
 * Only entries of at least PASSWORD_MIN characters matter: shorter ones already fail the length rule.
 * Compared case-insensitively and with spaces removed.
 */
const COMMON = new Set(
  [
    "1234567890 0123456789 12345678910 1234567891 123456789a 1q2w3e4r5t 1q2w3e4r5t6y 1qaz2wsx3edc 1qazxsw23edc",
    "qwertyuiop qwerty1234 qwerty12345 qwerty123456 qwertyuiop1 qwertyuiop123 asdfghjkl1 asdfghjkl123 zxcvbnm123",
    "password12 password123 password1234 password12345 password123456 passw0rd123 password1! password01 password11",
    "passwordpassword changeme123 changemenow letmein123 letmein1234 welcome123 welcome1234 welcome12345",
    "iloveyou12 iloveyou123 iloveyou1234 ilovemyself ilovejesus1 monkey1234 monkey12345 dragon1234 dragon12345",
    "football123 football1234 baseball123 basketball1 superman123 batman12345 starwars123 pokemon123 minecraft123",
    "princess123 princess1234 sunshine123 sunshine1234 shadow1234 master1234 michael123 jennifer123 charlie123",
    "trustno1234 abcdefghij abcd123456 abcdefg123 abc1234567 abc123456789 aaaaaaaaaa 1111111111 0000000000",
    "2222222222 3333333333 4444444444 5555555555 6666666666 7777777777 8888888888 9999999999 1212121212",
    "0987654321 9876543210 1234512345 12345678900 123456789012 1234567890123 12345678901234 123123123123",
    "1472583690 112233445566 1122334455 123321123321 654321654321 adminadmin admin12345 admin123456",
    "administrator root123456 rootroot12 toor123456 test123456 testtest12 tincan1234 tincan12345 tincantincan",
    "qazwsxedc123 qazwsxedcrfv zaq12wsxcde3 zaq1zaq1zaq1 internet123 computer123 whatever123 mustang1234",
    "freedom1234 secret1234 secret12345 mypassword1 mypassword12 mypassword123 yourpassword thepassword",
    "1password1 p@ssw0rd123 p@ssword123 pa$$word123 p@55w0rd123 qwer1234qwer 1234qwer1234 q1w2e3r4t5",
    "q1w2e3r4t5y6 qazwsx1234 lovelovelove loveyou1234",
  ]
    .join(" ")
    .split(/\s+/)
    .filter(Boolean),
);

export function checkPassword(password: string): PasswordProblem | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN) return "too_short";
  if (length > PASSWORD_MAX) return "too_long";
  if (COMMON.has(password.toLowerCase().replace(/\s+/g, ""))) return "too_common";
  if (new Set(password).size <= 2) return "too_common";
  return null;
}

/** Coarse hint for the UI ("At least 10 characters · Strong"); not a security control. */
export function passwordStrength(password: string): "weak" | "ok" | "strong" {
  if (checkPassword(password) !== null) return "weak";
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  const length = [...password].length;
  if (length >= 16 || (length >= 12 && classes >= 3)) return "strong";
  return "ok";
}
