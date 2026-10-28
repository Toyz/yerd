/**
 * Password hashing with node:crypto.
 *
 * argon2id (OWASP's minimum: 19 MiB, 2 passes, 1 lane) via crypto.argon2,
 * stored in the standard PHC format so parameters can be raised later and old
 * hashes still verify. verifyPassword also reads scrypt hashes, which older
 * yerd versions made on Node releases without crypto.argon2.
 */

import { argon2, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const ARGON = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };

function argon2id(password: string, nonce: Buffer, params: typeof ARGON): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2("argon2id", { message: password, nonce, ...params }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function scryptHash(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N, r, p, maxmem: 128 * N * r * 2 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/**
 * Hash a password for storage: argon2id, salted, in PHC format, so the
 * string carries its own parameters and verifyPassword keeps reading it after
 * they're raised. Store the whole string.
 *
 * ```ts
 * @action async signUp(_: {}, form: ActionForm) {
 *   const passwordHash = await hashPassword(form.string("password"));
 *   const user = await this.users.create({ name: form.string("name"), passwordHash });
 *   await auth.login(user);
 *   return redirect("/account");
 * }
 * ```
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await argon2id(password, salt, ARGON);
  return `$argon2id$v=19$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

// A real hash of nothing in particular, so a lookup of an unknown user costs the same.
let dummy: Promise<string> | undefined;

/**
 * Check a password against a stored hash. Pass `undefined` when the user
 * doesn't exist: it still runs a full hash, so response timing doesn't reveal
 * which accounts exist. Comparison is constant-time. Throws on a string that
 * isn't one of its hash formats, rather than answering false.
 *
 * ```ts
 * const user = this.users.byName(form.string("name"));
 * if (!(await verifyPassword(form.string("password"), user?.passwordHash)) || !user) {
 *   throw new Unauthorized("Wrong name or password");
 * }
 * ```
 */
export async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  if (stored === undefined) {
    dummy ??= hashPassword("yerd-dummy-password");
    await verifyPassword(password, await dummy);
    return false;
  }
  let expected: Buffer;
  let actual: Buffer;
  const argonMatch = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored);
  const scryptMatch = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored);
  if (argonMatch) {
    const [, m, t, p, salt, hash] = argonMatch;
    expected = Buffer.from(hash!, "base64url");
    actual = await argon2id(password, Buffer.from(salt!, "base64url"), {
      memory: Number(m), passes: Number(t), parallelism: Number(p), tagLength: expected.length,
    });
  } else if (scryptMatch) {
    const [, N, r, p, salt, hash] = scryptMatch;
    expected = Buffer.from(hash!, "base64url");
    actual = await scryptHash(password, Buffer.from(salt!, "base64url"), Number(N), Number(r), Number(p));
  } else {
    throw new Error("Unrecognized password hash format");
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
