import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { is, length, logger, matches, onBoot, onShutdown, resolve, service, trim, lower, type Logger } from "@toyz/yerd";
import { createAuth, hashPassword } from "@toyz/yerd/auth";

export interface User {
  id: string;
  name: string;
  passwordHash: string;
  createdAt: string;
  /** Set while the user shares a read-only link to their list: /share/<token>. */
  shareToken?: string;
}

export class SignupForm {
  @is.string({ transform: [trim, lower], validate: [length(3, 32), matches(/^[a-z0-9_-]+$/, "Use letters, numbers, - and _ only")] })
  name!: string;
  @is.string({ validate: length(8, 200) }) password!: string;
}

export class LoginForm {
  @is.string({ transform: [trim, lower] }) name!: string;
  @is.string() password!: string;
}

/** Accounts, persisted next to the todos. USERS_FILE=":memory:" keeps nothing on disk. */
@service
export class UserRepo {
  #users: User[] = [];
  #saving: Promise<void> = Promise.resolve();
  readonly #file = process.env.USERS_FILE ?? (process.env.TODO_FILE === ":memory:" ? ":memory:" : join(process.cwd(), ".data", "users.json"));
  @logger accessor log!: Logger;

  @onBoot async load() {
    if (this.#file === ":memory:") return;
    try {
      this.#users = JSON.parse(await readFile(this.#file, "utf8")) as User[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  @onShutdown async flush() {
    await this.#saving;
  }

  get(id: string): User | undefined {
    return this.#users.find((u) => u.id === id);
  }

  byName(name: string): User | undefined {
    return this.#users.find((u) => u.name === name);
  }

  byShareToken(token: string): User | undefined {
    return this.#users.find((u) => u.shareToken !== undefined && u.shareToken === token);
  }

  async create(name: string, password: string): Promise<User> {
    const user: User = { id: randomUUID(), name, passwordHash: await hashPassword(password), createdAt: new Date().toISOString() };
    this.#users.push(user);
    this.#save();
    // Fields named like secrets are redacted anyway; there's just no reason to log more than the name.
    this.log.info("signed up", { name });
    return user;
  }

  /** Start sharing a read-only link to this user's list (a fresh, unguessable token), or keep the current one. */
  share(user: User): string {
    user.shareToken ??= randomBytes(12).toString("base64url");
    this.#save();
    return user.shareToken;
  }

  /** Turn the link off: the old URL is a 404 from now on. */
  unshare(user: User): void {
    delete user.shareToken;
    this.#save();
  }

  #save(): void {
    if (this.#file === ":memory:") return;
    const snapshot = JSON.stringify(this.#users, null, 2);
    const file = this.#file;
    this.#saving = this.#saving
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, snapshot);
        await rename(`${file}.tmp`, file);
      })
      .catch((error) => this.log.error("failed to save users", { file, error }));
  }
}

/** Session auth for the app: `app.use(auth)`, `guards: [auth.required]`, `@auth.user`. */
export const auth = createAuth<User>({
  load: (id) => resolve(UserRepo).get(id),
  loginPath: "/login",
});
