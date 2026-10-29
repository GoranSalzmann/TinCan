// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { useAudioPrefs } from "./prefs.js";

export interface Devices {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
}

/** Lists audio devices and keeps the list current when one is plugged in or removed (12 §6.1). */
export function useDevices(): Devices {
  const [devices, setDevices] = useState<Devices>({ inputs: [], outputs: [], cameras: [] });
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        if (!alive) return;
        setDevices({
          inputs: all.filter((d) => d.kind === "audioinput"),
          outputs: all.filter((d) => d.kind === "audiooutput"),
          cameras: all.filter((d) => d.kind === "videoinput"),
        });
      } catch {
        // no device API (insecure origin): the pickers stay empty and say so
      }
    };
    void refresh();
    const onChange = () => void refresh();
    navigator.mediaDevices?.addEventListener("devicechange", onChange);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener("devicechange", onChange);
    };
  }, []);
  return devices;
}

/**
 * If the chosen device is gone, fall back to the system default; when it returns, the stored choice is used again
 * because we never overwrite it (W-21). Returns whether the saved choice is currently missing.
 */
export function useSavedDeviceMissing(devices: Devices): boolean {
  const { inputDeviceId } = useAudioPrefs((s) => s.prefs);
  return (
    inputDeviceId !== null &&
    devices.inputs.length > 0 &&
    !devices.inputs.some((d) => d.deviceId === inputDeviceId)
  );
}
