// SPDX-License-Identifier: AGPL-3.0-or-later
import { API_VERSION, type Capabilities, type User } from "@tincan/shared";
import { create } from "zustand";
import { api, ApiError } from "../api/client.js";
import { GatewayClient, gatewayUrl, type GatewayState } from "../gateway/client.js";
import { dispatchEvent, setDispatchSelf } from "../gateway/dispatch.js";
import { setSelfId, useChat } from "../state/chat.js";
import { useCommunity } from "../state/community.js";
import { useUi } from "../state/ui.js";

/**
 * What the shell knows: the server's capabilities (04 §7), who is logged in, and the gateway state.
 * Feature modules read `capabilities.features` and register only what the server offers (04 §10).
 */

export type BootStatus = "loading" | "unreachable" | "too-new" | "ready";

interface SessionState {
  boot: BootStatus;
  capabilities: Capabilities | null;
  user: User | null;
  gateway: GatewayState;
  /** True from the moment the owner is created until the setup wizard is finished. */
  wizardActive: boolean;
  bootstrap: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  signedIn: (user: User) => void;
  /** The owner was just created through the wizard: the server no longer needs setup, but the wizard is still on screen. */
  setupCompleted: (user: User) => void;
  setWizardActive: (active: boolean) => void;
  setInstanceName: (name: string) => void;
}

let gateway: GatewayClient | null = null;

export function stopGateway(): void {
  gateway?.disconnect();
  gateway = null;
}

/** Sends a gateway command such as typing.start or presence.set. */
export function sendCommand(cmd: string, args: unknown): void {
  gateway?.command(cmd, args);
}

/** Forgets everything tied to the signed-in user (logout, revoked session). */
function forgetUser(): void {
  setSelfId(null);
  setDispatchSelf(null);
  useCommunity.getState().reset();
  useChat.getState().reset();
  useUi.getState().select(null);
}

function rememberUser(id: string): void {
  setSelfId(id);
  setDispatchSelf(id);
}

export const useSession = create<SessionState>((set, get) => {
  function startGateway() {
    if (gateway) return;
    gateway = new GatewayClient({
      url: gatewayUrl(window.location),
      getCredentials: async () => ({ ticket: (await api.gatewayTicket()).ticket }),
      client: { name: "web", version: "0.1.0", platform: "web" },
      onDispatch: (t, d) => dispatchEvent(t, d),
      onState: (gw) => {
        set({ gateway: gw });
        if (gw === "unauthenticated") {
          stopGateway();
          forgetUser();
          set({ user: null, gateway: "closed" });
        }
      },
    });
    gateway.connect();
  }

  return {
    boot: "loading",
    capabilities: null,
    user: null,
    gateway: "closed",
    wizardActive: false,

    async bootstrap() {
      set({ boot: "loading" });
      let capabilities: Capabilities;
      try {
        capabilities = await api.capabilities();
      } catch {
        set({ boot: "unreachable" });
        return;
      }
      if (capabilities.server.apiVersion !== API_VERSION) {
        set({ capabilities, boot: "too-new" });
        return;
      }
      set({ capabilities });
      let user: User | null = null;
      if (!capabilities.auth.setupRequired) {
        try {
          user = await api.me();
        } catch (e) {
          if (!(e instanceof ApiError) || e.code === "NETWORK") {
            set({ boot: "unreachable" });
            return;
          }
          // 401: not logged in. Any other API error leaves the user at the login screen too.
        }
      }
      set({ user, boot: "ready" });
      if (user) {
        rememberUser(user.id);
        startGateway();
      }
    },

    async login(username, password) {
      const res = await api.login(username, password);
      get().signedIn(res.user);
    },

    async logout() {
      try {
        await api.logout();
      } finally {
        stopGateway();
        forgetUser();
        set({ user: null, gateway: "closed" });
      }
    },

    signedIn(user) {
      set({ user });
      rememberUser(user.id);
      startGateway();
    },

    setupCompleted(user) {
      const caps = get().capabilities;
      set({
        user,
        wizardActive: true,
        ...(caps ? { capabilities: { ...caps, auth: { ...caps.auth, setupRequired: false } } } : {}),
      });
      rememberUser(user.id);
      startGateway();
    },

    setWizardActive(active) {
      set({ wizardActive: active });
    },

    setInstanceName(name) {
      const caps = get().capabilities;
      if (caps) set({ capabilities: { ...caps, server: { ...caps.server, name } } });
    },
  };
});

export function useCapabilities(): Capabilities | null {
  return useSession((s) => s.capabilities);
}

/** True when the server offers the feature (04 §7). Absent or false means hide the UI. */
export function useFeature(id: string): boolean {
  return useSession((s) => Boolean(s.capabilities?.features[id]));
}
