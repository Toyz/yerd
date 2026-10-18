import { between, body, get, inject, is, lower, matches, ndjson, post, query, route, signal, toInt, trim } from "@toyz/yerd";
import { Heartbeat, Visits } from "../services.js";

class Signup {
  @is.string({ transform: [trim, lower], validate: matches(/@/, "that is not an email") }) email!: string;
  @is.int({ validate: between(13, 120) }) age!: number;
  @is.oneOf(["free", "pro"]) plan: "free" | "pro" = "free";
}

/** curl -X POST localhost:3000/api/signup -H 'content-type: application/json' -d '{"email":" ADA@x.io ","age":36}' */
@route("/api/signup")
export class SignupApi {
  @body(Signup) accessor signup!: Promise<Signup>;

  @post async create() {
    const s = await this.signup;
    return { welcome: s.email, plan: s.plan };
  }
}

/** curl -N 'localhost:3000/api/ticks?count=5' */
@route("/api/ticks")
export class Ticks {
  @query("count", { transform: toInt, validate: between(1, 100) }) accessor count = 10;
  @signal accessor stop!: AbortSignal;

  @get @ndjson async *stream() {
    for (let i = 1; i <= this.count && !this.stop.aborted; i++) {
      yield { tick: i, at: new Date().toISOString() };
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** curl localhost:3000/api/stats */
@route("/api/stats")
export class Stats {
  @inject(Visits) accessor visits!: Visits;
  @inject(Heartbeat) accessor heartbeat!: Heartbeat;

  @get show() {
    return { visits: this.visits.hit(), beats: this.heartbeat.beats, upSince: new Date(this.heartbeat.startedAt).toISOString() };
  }
}
