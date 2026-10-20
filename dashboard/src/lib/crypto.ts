// Credential encryption, done entirely in the browser with WebCrypto.
//
//   vault passphrase --PBKDF2-SHA256--> wrapping key --AES-GCM--> data key
//   data key --AES-256-GCM--> each credential (bound to its id and project)
//
// The database stores the salt, the wrapped data key, and ciphertext. Neither
// the passphrase nor the data key ever leaves this tab, so nothing on the
// server can decrypt a credential.
import type { VaultConfig } from "./types.ts";

export type CredentialSecret = { username: string; password: string; url: string; notes: string };

/** OWASP's 2023 recommendation for PBKDF2-HMAC-SHA256. */
export const KDF_ITERATIONS = 600_000;
export const MIN_PASSPHRASE = 12;

const te = new TextEncoder();
const td = new TextDecoder();
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// "v1.<iv>.<data>": versioned so the format can change without guessing.
const pack = (iv: Uint8Array, data: ArrayBuffer) => `v1.${toB64(iv)}.${toB64(new Uint8Array(data))}`;
function unpack(s: string) {
  const [v, iv, data, extra] = s.split(".");
  if (v !== "v1" || !iv || !data || extra !== undefined) throw new Error("Unrecognized encrypted data.");
  return { iv: fromB64(iv), data: fromB64(data) };
}

async function wrappingKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const base = await crypto.subtle.importKey("raw", te.encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["wrapKey", "unwrapKey"]);
}
async function wrap(dataKey: CryptoKey, kek: CryptoKey) {
  const iv = random(12);
  return pack(iv, await crypto.subtle.wrapKey("raw", dataKey, kek, { name: "AES-GCM", iv }));
}
async function unwrap(wrapped: string, kek: CryptoKey, extractable: boolean) {
  const { iv, data } = unpack(wrapped);
  try {
    return await crypto.subtle.unwrapKey("raw", data, kek, { name: "AES-GCM", iv }, { name: "AES-GCM", length: 256 }, extractable, ["encrypt", "decrypt"]);
  } catch {
    // AES-GCM authentication fails on the wrong passphrase.
    throw new Error("That passphrase didn't work.");
  }
}

/** A new vault: a random data key, wrapped under the passphrase. Returns what to store and the session key. */
export async function createVault(passphrase: string, iterations = KDF_ITERATIONS): Promise<{ config: VaultConfig; key: CryptoKey }> {
  const salt = random(16);
  const kek = await wrappingKey(passphrase, salt, iterations);
  const dataKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const config = { salt: toB64(salt), iterations, wrapped_key: await wrap(dataKey, kek) };
  // The session gets a non-extractable copy: it can encrypt and decrypt, but can't be exported.
  return { config, key: await unwrap(config.wrapped_key, kek, false) };
}

/** Unlock: the data key for this session (non-extractable), or "That passphrase didn't work." */
export async function openVault(config: VaultConfig, passphrase: string): Promise<CryptoKey> {
  return unwrap(config.wrapped_key, await wrappingKey(passphrase, fromB64(config.salt), config.iterations), false);
}

/** Re-wrap the same data key under a new passphrase (and fresh salt). Saved credentials don't change. */
export async function changePassphrase(config: VaultConfig, current: string, next: string, iterations = KDF_ITERATIONS): Promise<VaultConfig> {
  const dataKey = await unwrap(config.wrapped_key, await wrappingKey(current, fromB64(config.salt), config.iterations), true);
  const salt = random(16);
  return { salt: toB64(salt), iterations, wrapped_key: await wrap(dataKey, await wrappingKey(next, salt, iterations)) };
}

/** Binds a ciphertext to its row, so it can't be moved to another credential or project unnoticed. */
export const credentialAad = (id: string, projectId: string) => te.encode(`cyberxla/credential/${id}/${projectId}`);

export async function sealSecret(key: CryptoKey, secret: CredentialSecret, aad: Uint8Array<ArrayBuffer>): Promise<string> {
  const json = te.encode(JSON.stringify(secret));
  // Pad with spaces (valid trailing JSON) to a multiple of 256 bytes so the
  // ciphertext doesn't give away how long a password is.
  const padded = new Uint8Array(Math.ceil((json.length + 1) / 256) * 256).fill(0x20);
  padded.set(json);
  const iv = random(12);
  return pack(iv, await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, padded));
}

export async function openSecret(key: CryptoKey, sealed: string, aad: Uint8Array<ArrayBuffer>): Promise<CredentialSecret> {
  const { iv, data } = unpack(sealed);
  const o = JSON.parse(td.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, data)));
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return { username: str(o.username), password: str(o.password), url: str(o.url), notes: str(o.notes) };
}

/** A random password without look-alike characters (0/O, 1/l/I). */
export function generatePassword(length = 24): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+?";
  // Drop bytes past the last full multiple of chars.length so every character is equally likely.
  const limit = 256 - (256 % chars.length);
  let out = "";
  while (out.length < length) {
    for (const b of random(length * 2)) {
      if (b < limit && out.length < length) out += chars[b % chars.length];
    }
  }
  return out;
}
