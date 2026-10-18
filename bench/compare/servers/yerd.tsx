// yerd: decorated route classes, a DTO for the body, a guard for /secure, TSX layout for /page.
import { body, createGuard, get, is, param, post, query, route, toInt, Unauthorized, yerd, type LayoutProps } from "@toyz/yerd";
import { BEARER, HOST, PORT, ROWS } from "./shared.js";

function Layout({ children, meta }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{meta.title}</title>
      </head>
      <body>
        <header>
          <nav>
            <a href="/">Home</a>
            <a href="/about">About</a>
            <a href="/contact">Contact</a>
          </nav>
        </header>
        <main>{children}</main>
        <footer>bench footer</footer>
      </body>
    </html>
  );
}

@route("/json")
export class Json {
  @get show() {
    return { hello: "world" };
  }
}

@route("/users/:id")
export class User {
  @param("id", { transform: toInt }) accessor id!: number;
  @query("fields") accessor fields: string | undefined;

  @get show() {
    return { id: this.id, fields: this.fields ? this.fields.split(",") : [] };
  }
}

class EchoBody {
  @is.string() name!: string;
  @is.number() age!: number;
}

@route("/echo")
export class Echo {
  @body(EchoBody) accessor input!: Promise<EchoBody>;

  @post async create() {
    const { name, age } = await this.input;
    return { ok: true, name, age };
  }
}

const authorized = createGuard("authorized", (ctx) => ctx.headers.authorization === BEARER || new Unauthorized());

@route("/secure")
@authorized
export class Secure {
  @get show() {
    return { ok: true, user: "bench" };
  }
}

@route("/page", { meta: { title: "Bench page" } })
export class Page {
  @get show() {
    return (
      <>
        <h1>Rows</h1>
        <ul class="rows">
          {ROWS.map((row) => (
            <li class="row" data-id={row.id}>
              <span class="title">{row.title}</span>
              <a href={`/rows/${row.id}`}>open</a>
            </li>
          ))}
        </ul>
      </>
    );
  }
}

await yerd({ handleSignals: true })
  .logging({ filter: "warn" })
  .layout(Layout)
  .listen(PORT, HOST);
console.log("ready");
