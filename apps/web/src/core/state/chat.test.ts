// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@tincan/shared";
import { api } from "../api/client.js";
import { PAGE, useChat } from "./chat.js";

const msg = (n: number): Message =>
  ({
    id: String(n).padStart(6, "0"),
    channelId: "c1",
    authorId: "u1",
    content: `m${n}`,
    createdAt: new Date(2026, 0, 1, 0, 0, n).toISOString(),
  }) as unknown as Message;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));

beforeEach(() => {
  useChat.getState().reset();
  // The server's newest page: 951..1000.
  vi.spyOn(api, "history").mockResolvedValue(range(1000 - PAGE + 1, 1000));
});
afterEach(() => vi.restoreAllMocks());

describe("open", () => {
  it("cuts a long cached window back to the newest page when re-entering a channel", async () => {
    useChat.setState({ windows: { c1: { messages: range(1, 1000), hasOlder: true, hasNewer: false } } });
    await useChat.getState().open("c1");
    const w = useChat.getState().windows.c1!;
    expect(w.messages).toHaveLength(PAGE);
    expect(w.messages[0]!.id).toBe(msg(1000 - PAGE + 1).id);
    expect(w.messages.at(-1)!.id).toBe(msg(1000).id);
    expect(w.hasOlder).toBe(true);
    expect(w.hasNewer).toBe(false);
  });

  it("drops a window that was away from the live edge", async () => {
    useChat.setState({ windows: { c1: { messages: range(100, 200), hasOlder: true, hasNewer: true } } });
    const p = useChat.getState().open("c1");
    expect(useChat.getState().windows.c1).toBeUndefined();
    await p;
    expect(useChat.getState().windows.c1!.messages.at(-1)!.id).toBe(msg(1000).id);
    expect(useChat.getState().windows.c1!.hasNewer).toBe(false);
  });

  it("keeps the loaded history on a resume (reconnect)", async () => {
    useChat.setState({ windows: { c1: { messages: range(1, 1000), hasOlder: true, hasNewer: false } } });
    await useChat.getState().open("c1", { resume: true });
    expect(useChat.getState().windows.c1!.messages).toHaveLength(1000);
  });
});
