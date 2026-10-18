import { every, hosted, onBoot, onShutdown, service } from "@toyz/yerd";

/** A singleton the routes inject. */
@service
export class Visits {
  #count = 0;
  hit() {
    return ++this.#count;
  }
  get count() {
    return this.#count;
  }
}

/** Background work: a hosted service plus a periodic task. */
@hosted
export class Heartbeat {
  beats = 0;
  startedAt = 0;

  @onBoot start() {
    this.startedAt = Date.now();
  }

  async run(signal: AbortSignal) {
    while (!signal.aborted) {
      this.beats++;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  @every("30s") report() {
    console.log(`[hello] heartbeat: ${this.beats} beats`);
  }

  @onShutdown stop() {
    console.log(`[hello] stopping after ${this.beats} beats`);
  }
}
