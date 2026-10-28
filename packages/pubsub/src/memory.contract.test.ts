// SPDX-License-Identifier: AGPL-3.0-or-later
import { runPubSubContract } from "./contract.js";
import { MemoryPubSub } from "./index.js";

runPubSubContract("memory", async () => {
  let now = 1_000_000;
  return {
    pubsub: new MemoryPubSub({ now: () => now }),
    advance: async (ms) => {
      now += ms;
    },
    cleanup: async () => undefined,
  };
});
