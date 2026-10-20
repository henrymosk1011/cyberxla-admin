// Whether the credential vault is unlocked in this tab. The key itself lives
// only in this module's memory: never in storage, and gone on reload, sign-out,
// Lock, or 10 minutes without activity.
import { watchIdle } from "./idle.ts";

const AUTO_LOCK_MS = 10 * 60 * 1000;

let key: CryptoKey | null = null;
let stopIdle: (() => void) | null = null;

export const vault = $state({ unlocked: false });

export function unlock(k: CryptoKey) {
  stopIdle?.();
  key = k;
  vault.unlocked = true;
  stopIdle = watchIdle(AUTO_LOCK_MS, lock);
}

export function lock() {
  stopIdle?.();
  stopIdle = null;
  key = null;
  vault.unlocked = false;
}

export function vaultKey(): CryptoKey {
  if (!key) throw new Error("The vault is locked. Unlock it and try again.");
  return key;
}
