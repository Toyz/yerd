import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HttpError, args, event, get, is, ndjson, ndjsonBody, post, route, signal, sse, yerd,
  type RunningServer,
} from "@toyz/yerd";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const log: string[] = [];

class Row {
  @is.int() id!: number;
  @is.string() name!: string;
}

@route("/rows")
class Rows {
  @get @ndjson async *list() {
    for (let i = 1; i <= 3; i++) yield { id: i };
  }
}

@route("/slow")
class Slow {
  @get @ndjson async *first() {
    await sleep(300);
    yield { late: true };
  }
}

@route("/beat")
class Beat {
  @get @ndjson({ heartbeat: 20 }) async *quiet() {
    await sleep(90);
    yield { done: true };
  }
}

@route("/broken")
class Broken {
  @get @ndjson async *rows() {
    yield { ok: 1 };
    throw new HttpError(409, "conflict halfway");
  }
}

@route("/forever")
class Forever {
  @signal accessor stop!: AbortSignal;

  @get @ndjson async *ticks() {
    try {
      for (let i = 0; !this.stop.aborted; i++) {
        yield { i };
        await sleep(10);
      }
    } finally {
      log.push(`finally:${this.stop.aborted}`);
    }
  }
}

@route("/events")
class Events {
  @get
  feed() {
    return sse(
      (async function* () {
        yield "hello";
        yield event({ event: "user", id: "7", data: { name: "ada" } });
        yield "two\nlines";
      })(),
      { heartbeat: 0 },
    );
  }
}

@route("/events/broken")
class BrokenEvents {
  @get @sse({ heartbeat: 0 }) async *feed() {
    yield 1;
    throw new Error("secret");
  }
}

@route("/import")
class Import {
  @post
  @args(ndjsonBody(Row))
  async run(rows: AsyncIterable<Row>) {
    const names: string[] = [];
    for await (const row of rows) names.push(`${row.id}:${row.name}`);
    return { names };
  }
}

let server: RunningServer;
beforeAll(async () => {
  server = await yerd({
    routes: [Rows, Slow, Beat, Broken, Forever, Events, BrokenEvents, Import],
    handleSignals: false,
  }).listen(0, "127.0.0.1");
});
afterAll(() => server.close());

const url = (path: string) => server.url + path;

describe("NDJSON responses", () => {
  it("streams one JSON value per line with stream headers", async () => {
    const r = await fetch(url("/rows"));
    expect(r.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(r.headers.get("x-yerd-long-lived")).toBeNull();
    expect(await r.text()).toBe('{"id":1}\n{"id":2}\n{"id":3}\n');
  });

  it("sends headers before a slow first item", async () => {
    const started = performance.now();
    const r = await fetch(url("/slow"));
    expect(performance.now() - started).toBeLessThan(250);
    expect(await r.text()).toBe('{"late":true}\n');
  });

  it("writes blank heartbeat lines while the source is quiet", async () => {
    const text = await (await fetch(url("/beat"))).text();
    expect(text.endsWith('{"done":true}\n')).toBe(true);
    expect(text.startsWith("\n")).toBe(true);
  });

  it("ends a failing stream with an error line", async () => {
    expect(await (await fetch(url("/broken"))).text()).toBe('{"ok":1}\n{"error":"conflict halfway"}\n');
  });

  it("stops the generator and aborts the signal when the client disconnects", async () => {
    log.length = 0;
    const controller = new AbortController();
    const r = await fetch(url("/forever"), { signal: controller.signal });
    const reader = r.body!.getReader();
    await reader.read();
    controller.abort();
    await sleep(100);
    expect(log).toEqual(["finally:true"]);
  });
});

describe("SSE", () => {
  it("formats data, named events and multi-line data", async () => {
    const r = await fetch(url("/events"));
    expect(r.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(await r.text()).toBe(
      'data: hello\n\nevent: user\nid: 7\ndata: {"name":"ada"}\n\ndata: two\ndata: lines\n\n',
    );
  });

  it("sends an error event without leaking internal messages", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(await (await fetch(url("/events/broken"))).text()).toBe(
        'data: 1\n\nevent: error\ndata: {"error":"Internal Server Error"}\n\n',
      );
    } finally {
      console.error = quiet;
    }
  });
});

describe("NDJSON request bodies", () => {
  it("streams and validates each line", async () => {
    const body = '{"id":1,"name":"a"}\n\n{"id":"2","name":"b"}\n';
    const r = await fetch(url("/import"), { method: "POST", headers: { "content-type": "application/x-ndjson" }, body });
    expect(await r.json()).toEqual({ names: ["1:a", "2:b"] });
  });

  it("reports the failing line", async () => {
    const r = await fetch(url("/import"), { method: "POST", body: '{"id":1,"name":"a"}\n{"id":"x"}\n' });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({
      error: "Line 2 failed validation",
      line: 2,
      issues: [
        { path: "id", message: "Expected an integer" },
        { path: "name", message: "Required" },
      ],
    });
  });

  it("rejects malformed JSON lines", async () => {
    const r = await fetch(url("/import"), { method: "POST", body: '{"id":1,"name":"a"}\n{nope\n' });
    expect(r.status).toBe(400);
    expect(await r.text()).toBe("Line 2 is not valid JSON");
  });
});

describe("graceful shutdown", () => {
  it("ends long-lived streams so close() finishes", async () => {
    log.length = 0;
    @route("/live")
    class Live {
      @signal accessor stop!: AbortSignal;
      @get @ndjson async *ticks() {
        try {
          while (!this.stop.aborted) {
            yield { t: 1 };
            await sleep(10);
          }
        } finally {
          log.push("live ended");
        }
      }
    }
    const own = await yerd({ routes: [Live], handleSignals: false, shutdownTimeout: 2000 }).listen(0, "127.0.0.1");
    const r = await fetch(own.url + "/live");
    const reader = r.body!.getReader();
    await reader.read();
    const started = performance.now();
    await own.close();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(log).toEqual(["live ended"]);
  });
});
