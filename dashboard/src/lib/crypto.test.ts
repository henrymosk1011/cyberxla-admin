import { test } from "node:test";
import assert from "node:assert/strict";
import { changePassphrase, createVault, credentialAad, generatePassword, openSecret, openVault, sealSecret } from "./crypto.ts";

// Real KDF cost is for the browser; tests use the minimum the database allows.
const FAST = 100_000;
const secret = { username: "admin@contoso.com", password: "correct horse battery staple", url: "https://portal.example.com", notes: "Recovery codes: 1234 5678" };

test("a vault round-trips a credential", async () => {
  const { config, key } = await createVault("a long vault passphrase", FAST);
  assert.equal(config.iterations, FAST);
  assert.match(config.wrapped_key, /^v1\.[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}$/);
  const aad = credentialAad("cred-1", "proj-1");
  const sealed = await sealSecret(key, secret, aad);
  assert.match(sealed, /^v1\./);
  assert.ok(!sealed.includes("contoso") && !sealed.includes("horse"));
  assert.deepEqual(await openSecret(key, sealed, aad), secret);
  // A fresh unlock with the passphrase opens it too.
  assert.deepEqual(await openSecret(await openVault(config, "a long vault passphrase"), sealed, aad), secret);
});

test("the session key can't be exported", async () => {
  const { config, key } = await createVault("a long vault passphrase", FAST);
  await assert.rejects(crypto.subtle.exportKey("raw", key));
  await assert.rejects(crypto.subtle.exportKey("raw", await openVault(config, "a long vault passphrase")));
});

test("the wrong passphrase doesn't unlock", async () => {
  const { config } = await createVault("a long vault passphrase", FAST);
  await assert.rejects(openVault(config, "a long vault passphrasE"), /didn't work/);
});

test("a credential moved to another row or tampered with won't open", async () => {
  const { key } = await createVault("a long vault passphrase", FAST);
  const sealed = await sealSecret(key, secret, credentialAad("cred-1", "proj-1"));
  await assert.rejects(openSecret(key, sealed, credentialAad("cred-2", "proj-1")));
  await assert.rejects(openSecret(key, sealed, credentialAad("cred-1", "proj-2")));
  const [v, iv, data] = sealed.split(".");
  const flipped = data!.slice(0, 4) + (data![4] === "A" ? "B" : "A") + data!.slice(5);
  await assert.rejects(openSecret(key, [v, iv, flipped].join("."), credentialAad("cred-1", "proj-1")));
});

test("ciphertext length doesn't reveal password length", async () => {
  const { key } = await createVault("a long vault passphrase", FAST);
  const aad = credentialAad("c", "p");
  const short = await sealSecret(key, { ...secret, password: "a" }, aad);
  const long = await sealSecret(key, { ...secret, password: "a".repeat(40) }, aad);
  assert.equal(short.length, long.length);
});

test("changing the passphrase keeps credentials readable", async () => {
  const { config, key } = await createVault("first passphrase here", FAST);
  const aad = credentialAad("cred-1", "proj-1");
  const sealed = await sealSecret(key, secret, aad);
  const next = await changePassphrase(config, "first passphrase here", "second passphrase here", FAST);
  assert.notEqual(next.salt, config.salt);
  assert.deepEqual(await openSecret(await openVault(next, "second passphrase here"), sealed, aad), secret);
  await assert.rejects(openVault(next, "first passphrase here"), /didn't work/);
  await assert.rejects(changePassphrase(config, "not the passphrase", "x".repeat(20), FAST), /didn't work/);
});

test("generated passwords use the safe alphabet at the requested length", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const p = generatePassword();
    assert.equal(p.length, 24);
    assert.doesNotMatch(p, /[0O1lI]/);
    seen.add(p);
  }
  assert.equal(seen.size, 200);
  assert.equal(generatePassword(40).length, 40);
});
