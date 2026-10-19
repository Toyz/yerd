// Compile-only checks, run by `npm run check` (tsc). Each @ts-expect-error
// must stay an error; if one stops erroring, tsc fails.
import { inject, maybe, service, token, type Inject } from "@toyz/yerd";

class AuditLog {
  readonly lines: string[] = [];
}
class Hasher {
  hash(s: string) {
    return s;
  }
}
interface Config {
  url: string;
}
const Config = token<Config>("Config");

@service
export class Good {
  @inject(AuditLog) accessor plain!: AuditLog;
  @inject.scoped(AuditLog) accessor audit!: AuditLog;
  @inject.transient(Hasher) accessor hasher!: Hasher;
  @inject.instance(AuditLog) accessor own!: AuditLog;
  @inject.scoped(Config) accessor config!: Config;
  @maybe(Config) accessor optional: Config | undefined;

  use(): string[] {
    return [...this.audit.lines, this.hasher.hash("x"), this.config.url, ...this.own.lines];
  }
}

@service
export class Bad {
  // @ts-expect-error the key gives an AuditLog; the field says Hasher
  @inject.scoped(AuditLog) accessor audit!: Hasher;

  // @ts-expect-error the token gives a Config; the field says string
  @inject.transient(Config) accessor config!: string;

  // @ts-expect-error the key gives a Hasher; the field says number
  @inject.instance(Hasher) accessor hasher!: number;

  // @ts-expect-error the field type must be the key's, as with @inject: not wider
  @inject.transient(Hasher) accessor loose!: Hasher | undefined;

  // @ts-expect-error injection needs the accessor keyword
  @inject.scoped(AuditLog) audit2!: AuditLog;
}

// The forms are members of the Inject type.
const forms: Inject["scoped" | "transient" | "instance"][] = [inject.scoped, inject.transient, inject.instance];
void forms;
