import { randomUUID } from "node:crypto";
import { service, singleton, token, transient } from "@toyz/yerd";

/**
 * The service lifetimes page's cast: one of each kind of registration, each
 * leaving something on the page you can watch change (or not) as you reload.
 */

const shortId = () => randomUUID().slice(0, 8);

/** Facts about this process. Not a class: registered with a singleton factory in app.ts. */
export interface BootInfo {
  id: string;
  bootedAt: Date;
  pid: number;
}
export const BootInfo = token<BootInfo>("BootInfo");

/** Factory for BootInfo: runs once, the first time something asks. */
export function bootInfo(): BootInfo {
  return { id: shortId(), bootedAt: new Date(), pid: process.pid };
}

/** Every Visit that's been disposed, newest first: proof that scoped services end with their request. */
@singleton
@service
export class Disposals {
  #log: Array<{ id: string; ms: number; at: string }> = [];

  record(id: string, ms: number): void {
    this.#log.unshift({ id, ms, at: new Date().toISOString() });
    this.#log.length = Math.min(this.#log.length, 5);
  }

  recent() {
    return this.#log;
  }
}

/**
 * One per request, registered with a scoped factory in app.ts (it takes a
 * constructor argument, which a decorated class can't). Disposable: yerd
 * calls `[Symbol.dispose]` when the request is over, and it writes itself
 * into Disposals on the way out.
 */
export class Visit implements Disposable {
  readonly id = shortId();
  readonly #started = performance.now();

  constructor(private readonly disposals: Disposals) {}

  [Symbol.dispose](): void {
    this.disposals.record(this.id, performance.now() - this.#started);
  }
}

/** A new one every time it's injected or resolved: two @inject(Dice) fields hold two different dice. */
@transient
@service
export class Dice {
  readonly id = shortId();
  readonly roll = 1 + Math.floor(Math.random() * 6);
}

/** What the page asks for: an interface and a token, no class in sight. */
export interface Fortune {
  tell(): string;
}
export const Fortune = token<Fortune>("Fortune");

const FORTUNES = [
  "A rock you overlooked will become important to you.",
  "Your garden is watching. It approves.",
  "Do not trust the flamingo.",
  "Great things come to those who stand very still on a lawn.",
  "The mushroom ring is not a door. Probably.",
];

/** The implementation behind the Fortune token: `@service({ provides })` registers it under the token. */
@service({ provides: Fortune })
export class GnomeFortunes implements Fortune {
  tell(): string {
    return FORTUNES[Math.floor(Math.random() * FORTUNES.length)]!;
  }
}
