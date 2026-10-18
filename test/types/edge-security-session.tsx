// Compile-only: Session<T> keeps members and data apart, and the auth/session APIs are typed tightly.
import { MemoryStore, get, route, session, yerd, type Session, type SessionRecord, type SessionStore } from "@toyz/yerd";
import { createAuth, safeNext, verifyPassword } from "@toyz/yerd/auth";

interface Clashing {
  /** Named like Session members: left out of the properties, reachable with get()/set(). */
  id?: number;
  flash?: string;
  clear?: boolean;
  isNew?: string;
  createdAt?: string;
  /** Ordinary fields. */
  theme?: "light" | "dark";
  count: number;
}

@route("/edge-types")
export class EdgeTypes {
  @session accessor session!: Session<Clashing>;

  @get show() {
    const s = this.session;
    // Members keep their own types.
    const id: string | undefined = s.id;
    const isNew: boolean = s.isNew;
    const createdAt: number = s.createdAt;
    s.flash("notice", "x");
    s.clear();
    // The data under those names, by name.
    const dataId: number | undefined = s.get("id");
    const dataFlash: string | undefined = s.get("flash");
    s.set("isNew", "yes");
    // @ts-expect-error isNew is a member (boolean, read-only), not the string field
    s.isNew = "yes";
    // @ts-expect-error createdAt is read-only
    s.createdAt = 5;
    // Literal unions are enforced.
    s.theme = "dark";
    // @ts-expect-error "blue" isn't a theme
    s.theme = "blue";
    // Required fields read as possibly undefined through get() (nothing guarantees they were set).
    const count: number | undefined = s.get("count");
    // @ts-expect-error count is a number
    s.set("count", "1");
    // @ts-expect-error unknown keys are refused by name too
    s.delete("nope");
    // @ts-expect-error delete takes one key
    s.delete();
    // flash reads are unknown: check before use.
    const notice: unknown = s.flash("notice");
    // @ts-expect-error unknown isn't a string
    const asString: string = s.flash("notice");
    return [id, isNew, createdAt, dataId, dataFlash, count, notice, asString];
  }
}

// A custom store must say which kind it is and match the method shapes (sync or async).
export const asyncStore: SessionStore = {
  kind: "id",
  get: async (_id: string): Promise<SessionRecord | undefined> => undefined,
  set: async () => {},
  destroy: () => {},
};

export const badKind: SessionStore = {
  // @ts-expect-error kind is "cookie" or "id"
  kind: "redis",
  get: () => undefined,
  set: () => {},
  destroy: () => {},
};

// generateId may be async; it must produce a string.
yerd().sessions({ store: new MemoryStore(), generateId: async () => "id" });
// @ts-expect-error generateId returns a string
yerd().sessions({ store: new MemoryStore(), generateId: () => 42 });

interface Member {
  id: string;
  roles: string[];
}

export const members = createAuth<Member>({
  load: async (id) => ({ id, roles: [] }),
  roles: (m) => m.roles,
  sessionKey: "edge_types_uid",
  onLogin: async (member, s) => {
    const id: string = member.id;
    s.set("__yerd_csrf", "x");
    void id;
  },
});

// @ts-expect-error load must return a Member (or undefined)
createAuth<Member>({ load: () => ({ id: 1 }), sessionKey: "edge_types_bad" });

// login() takes the auth's user type.
// @ts-expect-error not a Member
export const wrongLogin = () => members.login({ name: "x" });

// The helpers take strings (or nothing).
const next: string = safeNext(null);
const fallback: string = safeNext("/x", "/home");
const ok: Promise<boolean> = verifyPassword("pw", undefined);
// @ts-expect-error a stored hash is a string
verifyPassword("pw", 42);
void [next, fallback, ok];
