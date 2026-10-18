import { get, route } from "@toyz/yerd";

@route("/")
export class Home {
  @get index() {
    return (
      <main>
        <h1>yerd</h1>
        <p>routes are classes, TSX is the template engine, and this page is a return value.</p>
      </main>
    );
  }
}

@route("/api/health")
export class Health {
  @get check() {
    return { ok: true, uptime: Math.round(process.uptime()) };
  }
}

@route("/ping")
export class Ping {
  @get pong() {
    return "pong";
  }
}
