// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runtimeSource } from "../../src/client/runtime.js";
import type { YerdClient } from "../../src/attributes/attribute.js";

beforeAll(() => {
  new Function(runtimeSource())();
  // happy-dom gap: requestSubmit() with no submitter reports the form itself as
  // the submitter (browsers report null), which FormData(form, form) rejects.
  HTMLFormElement.prototype.requestSubmit = function (this: HTMLFormElement, submitter?: HTMLElement | null) {
    this.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: submitter ?? null }));
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.getElementById("yx-notice")?.remove();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

type Call = { url: string; method: string; body: RequestInit["body"]; headers: Record<string, string> };

/** Stub fetch; POSTs get `post`, GETs (refreshes, loads) get `get`. */
function stubFetch(post: (call: Call) => Response | Promise<Response>, get: (url: string) => Response = () => page("")) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), method: init.method ?? "GET", body: init.body, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(call);
    return call.method === "POST" ? post(call) : get(call.url);
  }));
  return calls;
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : body, { status, headers: { "content-type": "text/html", ...headers } });
}

function page(body: string): Response {
  return html(`<html><head><title>p</title></head><body>${body}</body></html>`);
}

function json(data: unknown, status = 400): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const issues = (...list: Array<[string, string]>) => json({ error: "Validation failed", issues: list.map(([path, message]) => ({ path, message })) });

function show(markup: string): void {
  document.body.innerHTML = markup;
  document.dispatchEvent(new CustomEvent("yx:applied", { detail: { regions: 0 } }));
}

function submit(form: Element = document.querySelector("form")!, submitter: HTMLElement | null = null): SubmitEvent {
  const event = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter });
  form.dispatchEvent(event);
  return event;
}

const body = (call: Call) => Object.fromEntries(new URLSearchParams(String(call.body)));
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");
const errorText = (selector = "p[data-yx-error]") => document.querySelector(selector)!.textContent;

describe("which forms the runtime takes", () => {
  it.each([
    ["an action form", '<form data-yx method="post" action="/a"></form>', true],
    ["a plain form (no auto mode)", '<form method="post" action="/a"></form>', false],
    ["an action form targeting another window", '<form data-yx method="post" action="/a" target="_blank"></form>', false],
    ["an action form targeting _self", '<form data-yx method="post" action="/a" target="_self"></form>', true],
    ["an action form with target=_SELF", '<form data-yx method="post" action="/a" target="_SELF"></form>', true],
    ["method=dialog", '<form data-yx method="dialog"></form>', false],
  ])("%s: intercepted %s", (_name, markup, intercepted) => {
    stubFetch(() => html("", 204));
    show(markup);
    expect(submit().defaultPrevented).toBe(intercepted);
  });

  it("leaves a submit the app already prevented alone", async () => {
    const calls = stubFetch(() => html("", 204));
    show('<form data-yx method="post" action="/a"></form>');
    const form = document.querySelector("form")!;
    form.addEventListener("submit", (e) => e.preventDefault());
    submit(form);
    await flush();
    expect(calls).toEqual([]);
  });

  it("a submitter's formtarget sends it to the browser", () => {
    stubFetch(() => html("", 204));
    show('<form data-yx method="post" action="/a"><button formtarget="_blank">x</button></form>');
    expect(submit(undefined, document.querySelector("button")).defaultPrevented).toBe(false);
  });

  it("a formaction={action} button in a plain form is posted by the runtime, with its holes", async () => {
    const calls = stubFetch(() => html("", 204));
    show(`<input id="n" value="5"><form method="post" action="/plain"><input name="t" value="1">
      <button formaction="/act" formmethod="post" name="_yx" value="T" data-yx-holes='[["ref","#n","value"]]'>go</button></form>`);
    const event = submit(undefined, document.querySelector("button"));
    expect(event.defaultPrevented).toBe(true);
    await flush();
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0]!.url).toBe(new URL("/act", location.href).href);
    expect(posts(calls)[0]!.headers.yx).toBe("1");
    expect(body(posts(calls)[0]!)).toEqual({ t: "1", _yx: "T", _yxh0: "5" });
  });

  it("a plain submit button in that plain form is still the browser's", () => {
    stubFetch(() => html("", 204));
    show('<form method="post" action="/plain"><button id="p">plain</button><button formaction="/act" name="_yx" value="T">act</button></form>');
    expect(submit(undefined, document.getElementById("p")).defaultPrevented).toBe(false);
  });
});

describe("what a submit sends", () => {
  it("urlencoded by default, with yx and accept headers, in tree order", async () => {
    const calls = stubFetch(() => html("", 204));
    show('<form data-yx method="post" action="/a"><input type="hidden" name="_yx" value="T"><input name="b" value="2"><input name="a" value="1"><select name="s"><option>x</option><option selected>y</option></select><textarea name="t">z</textarea><input type="checkbox" name="c"><input type="checkbox" name="d" checked></form>');
    submit();
    await flush();
    const call = posts(calls)[0]!;
    expect(String(call.body)).toBe("_yx=T&b=2&a=1&s=y&t=z&d=on");
    expect(call.headers).toEqual({ yx: "1", accept: "text/html", "content-type": "application/x-www-form-urlencoded" });
  });

  it("the submitter's name and value are sent; other buttons' are not", async () => {
    const calls = stubFetch(() => html("", 204));
    show('<form data-yx method="post" action="/a"><button name="op" value="save">s</button><button id="del" name="op" value="delete">d</button></form>');
    submit(undefined, document.getElementById("del"));
    await flush();
    expect(String(posts(calls)[0]!.body)).toBe("op=delete");
  });

  it("an empty file input stays urlencoded (sent as an empty name)", async () => {
    const calls = stubFetch(() => html("", 204));
    show('<form data-yx method="post" action="/a"><input name="t" value="1"><input type="file" name="f"></form>');
    submit();
    await flush();
    expect(posts(calls)[0]!.body).toBeInstanceOf(URLSearchParams);
    expect(String(posts(calls)[0]!.body)).toBe("t=1&f=");
  });

  it("enctype=multipart sends multipart even without files, with no content-type of its own", async () => {
    const calls = stubFetch(() => html("", 204));
    show('<form data-yx method="post" action="/a" enctype="multipart/form-data"><input name="t" value="1"></form>');
    submit();
    await flush();
    expect(posts(calls)[0]!.body).toBeInstanceOf(FormData);
    expect(posts(calls)[0]!.headers["content-type"]).toBeUndefined();
  });

  it("ENCTYPE in capitals counts too", async () => {
    const calls = stubFetch(() => html("", 204));
    show('<form data-yx method="post" action="/a" enctype="MULTIPART/FORM-DATA"><input name="t" value="1"></form>');
    submit();
    await flush();
    expect(posts(calls)[0]!.body).toBeInstanceOf(FormData);
  });

  it("method=POST in capitals posts", async () => {
    const calls = stubFetch(() => html("", 204));
    show('<form data-yx method="POST" action="/a"></form>');
    submit();
    await flush();
    expect(posts(calls)).toHaveLength(1);
  });

  it("a form's holes are read when it submits; a submitter's holes replace them", async () => {
    const calls = stubFetch(() => html("", 204));
    show(`<input id="q" value="cats"><form data-yx method="post" action="/a" data-yx-holes='[["ref","#q","value"],["el","id"]]' id="f">
      <button id="own" data-yx-holes='[["el","id"]]' name="_yx" value="B">b</button><button id="plain">p</button></form>`);
    submit(undefined, document.getElementById("plain"));
    await flush();
    expect(body(posts(calls)[0]!)).toEqual({ _yxh0: "cats", _yxh1: "f" });
    submit(undefined, document.getElementById("own"));
    await flush();
    expect(body(posts(calls)[1]!)).toEqual({ _yx: "B", _yxh0: "own" });
  });

  it("a hole whose ref is gone doesn't send, and leaves the buttons enabled", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = stubFetch(() => html("", 204));
    show(`<form data-yx method="post" action="/a" data-yx-holes='[["ref","#gone","value"]]'><button>b</button></form>`);
    submit();
    await flush();
    expect(calls).toEqual([]);
    expect(document.querySelector("button")!.disabled).toBe(false);
    expect(document.querySelector("form")!.hasAttribute("aria-busy")).toBe(false);
  });

  it("garbage in data-yx-holes sends no holes rather than throwing", async () => {
    const calls = stubFetch(() => html("", 204));
    show(`<form data-yx method="post" action="/a" data-yx-holes="not json"><input name="x" value="1"></form>`);
    submit();
    await flush();
    expect(String(posts(calls)[0]!.body)).toBe("x=1");
  });

  it.each([
    ["value", '<input id="t" value="v">', "v"],
    ["checked", '<input id="t" type="checkbox" checked>', "true"],
    ["checked", '<input id="t" type="checkbox">', "false"],
    ["valueAsNumber", '<input id="t" type="number" value="4.5">', "4.5"],
    ["selectedIndex", '<select id="t"><option>a</option><option selected>b</option></select>', "1"],
    ["textContent", '<p id="t"> hi </p>', " hi "],
    ["open", '<details id="t" open></details>', "true"],
    ["disabled", '<button id="t" disabled></button>', "true"],
    ["id", '<b id="t"></b>', "t"],
    ["name", '<input id="t" name="nm">', "nm"],
  ])("ref(...).%s is read as the browser has it", async (field, markup, expected) => {
    const calls = stubFetch(() => html("", 204));
    show(`${markup}<form data-yx method="post" action="/a" data-yx-holes='[["ref","#t","${field}"]]'></form>`);
    submit();
    await flush();
    expect(body(posts(calls)[0]!)._yxh0).toBe(expected);
  });

  it("dataset holes read data-* attributes; a missing one is empty", async () => {
    const calls = stubFetch(() => html("", 204));
    show(`<form data-yx method="post" action="/a" data-user-id="7" data-yx-holes='[["el","dataset","userId"],["el","dataset","missing"]]'></form>`);
    submit();
    await flush();
    expect(body(posts(calls)[0]!)).toEqual({ _yxh0: "7", _yxh1: "" });
  });
});

describe("GET forms", () => {
  it("navigate to the action with the fields as its query, replacing the action's own", async () => {
    const calls = stubFetch(() => html(""), () => page('<p id="landed">results</p>'));
    show('<form data-yx method="get" action="/search?old=1#frag"><input name="q" value="a b&c"><input type="file" name="f"></form>');
    submit();
    await flush();
    const get = calls.find((c) => c.method === "GET")!;
    expect(new URL(get.url).pathname + new URL(get.url).search).toBe("/search?q=a+b%26c&f=");
    expect(location.pathname + location.search).toBe("/search?q=a+b%26c&f=");
    expect(document.getElementById("landed")).not.toBeNull();
  });

  it("a submitter's formmethod=get turns a post form into a navigation", async () => {
    const calls = stubFetch(() => html("", 204), () => page("<p>ok</p>"));
    show('<form data-yx method="post" action="/x"><input name="q" value="1"><button formmethod="get" formaction="/find">f</button></form>');
    submit(undefined, document.querySelector("button"));
    await flush();
    expect(posts(calls)).toEqual([]);
    expect(location.pathname + location.search).toBe("/find?q=1");
  });
});

describe("responses", () => {
  it("204 refreshes the page's regions with a boosted GET of this page", async () => {
    const calls = stubFetch(() => html("", 204), () => page('<div id="r" data-yx-region>fresh</div>'));
    show('<div id="r" data-yx-region>old</div><form data-yx method="post" action="/a"></form>');
    submit();
    await flush();
    const get = calls.find((c) => c.method === "GET")!;
    expect(get.url).toBe(location.href);
    expect(get.headers["yx-boost"]).toBe("1");
    expect(document.getElementById("r")!.textContent).toBe("fresh");
  });

  it("HTML with no matching region falls back to a refresh", async () => {
    const calls = stubFetch(() => html('<div id="nothere" data-yx-region>x</div>'), () => page('<div id="r" data-yx-region>fresh</div>'));
    show('<div id="r" data-yx-region>old</div><form data-yx method="post" action="/a"></form>');
    submit();
    await flush();
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);
    expect(document.getElementById("r")!.textContent).toBe("fresh");
  });

  it("matching regions are applied with no extra request", async () => {
    const calls = stubFetch(() => html('<div id="r" data-yx-region>new</div>'));
    show('<div id="r" data-yx-region>old</div><form data-yx method="post" action="/a"></form>');
    submit();
    await flush();
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
    expect(document.getElementById("r")!.textContent).toBe("new");
  });

  it("yx-location navigates there and pushes history", async () => {
    stubFetch(() => html("", 200, { "yx-location": "/next?x=1#top" }), () => page('<h1 id="top">next</h1>'));
    show('<form data-yx method="post" action="/a"></form>');
    const before = history.length;
    submit();
    await flush();
    expect(location.pathname + location.search + location.hash).toBe("/next?x=1#top");
    expect(history.length).toBe(before + 1);
    expect(document.getElementById("top")!.textContent).toBe("next");
  });

  it("yx-location to another origin is a real navigation, not a morph", async () => {
    const assign = vi.fn();
    vi.spyOn(location, "assign").mockImplementation(assign);
    const calls = stubFetch(() => html("", 200, { "yx-location": "https://elsewhere.test/x" }));
    show('<p id="keep">k</p><form data-yx method="post" action="/a"></form>');
    submit();
    await flush();
    expect(assign).toHaveBeenCalledWith("https://elsewhere.test/x");
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
  });

  // An app that redirects to a URL it was given (an unchecked ?next=) mustn't
  // become script execution: browsers never follow a Location to javascript:.
  it.each(["javascript:window.pwned=1", "JavaScript:window.pwned=1", " javascript:window.pwned=1", "java\tscript:window.pwned=1", "data:text/html,<script>window.pwned=1</script>", "vbscript:x"])(
    "yx-location %j is refused",
    async (target) => {
      const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
      stubFetch(() => html("", 200, { "yx-location": target }));
      show('<form data-yx method="post" action="/a"></form>');
      submit();
      await flush();
      expect(assign).not.toHaveBeenCalled();
      expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    },
  );

  it("yerd.load refuses a javascript: URL too", async () => {
    const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
    await (window as unknown as { yerd: YerdClient }).yerd.page.load("javascript:alert(1)", true);
    expect(assign).not.toHaveBeenCalled();
  });

  it("aria-busy and disabled buttons last exactly as long as the request", async () => {
    let release!: (r: Response) => void;
    stubFetch(() => new Promise<Response>((resolve) => (release = resolve)));
    show('<form data-yx method="post" action="/a"><button>a</button><input type="submit" value="b"><button type="button">c</button></form>');
    const form = document.querySelector("form")!;
    submit(form);
    await flush();
    expect(form.getAttribute("aria-busy")).toBe("true");
    const all = Array.from(form.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input"));
    expect(all.map((b) => b.disabled)).toEqual([true, true, true]);
    expect(all.every((b) => b.hasAttribute("data-yx-disabled"))).toBe(true);
    release(html("", 204));
    await flush();
    expect(form.hasAttribute("aria-busy")).toBe(false);
    expect(all.map((b) => b.disabled)).toEqual([false, false, false]);
    expect(all.some((b) => b.hasAttribute("data-yx-disabled"))).toBe(false);
  });

  it("buttons are re-enabled after a failure and after a network error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let mode = "fail";
    stubFetch(() => {
      if (mode === "fail") return html("Nope", 500);
      throw new TypeError("Failed to fetch");
    });
    show('<form data-yx method="post" action="/a"><p data-yx-error></p><button>a</button></form>');
    submit();
    await flush();
    expect(document.querySelector("button")!.disabled).toBe(false);
    mode = "offline";
    submit();
    await flush();
    expect(document.querySelector("button")!.disabled).toBe(false);
  });

  it("a button the response morphed to disabled stays disabled", async () => {
    stubFetch(() => html('<form id="f" data-yx-region data-yx method="post" action="/a"><button disabled>done</button></form>'));
    show('<form id="f" data-yx-region data-yx method="post" action="/a"><button>go</button></form>');
    submit();
    await flush();
    expect(document.querySelector("button")!.disabled).toBe(true);
  });

  it("closes the <details> around a form on success only", async () => {
    let ok = false;
    stubFetch(() => (ok ? html("", 204) : html("bad", 400)));
    show('<details open id="d"><summary>edit</summary><form data-yx method="post" action="/a"><p data-yx-error></p></form></details>');
    const details = document.getElementById("d") as HTMLDetailsElement;
    submit();
    await flush();
    expect(details.open).toBe(true);
    ok = true;
    submit();
    await flush();
    expect(details.open).toBe(false);
  });

  it("data-yx-reset clears the form after success only, and focuses its autofocus field", async () => {
    let ok = false;
    stubFetch(() => (ok ? html("", 204) : html("bad", 400)));
    show('<form data-yx data-yx-reset method="post" action="/a"><input id="t" name="t" autofocus><input id="u" name="u"><p data-yx-error></p></form>');
    const t = document.getElementById("t") as HTMLInputElement;
    const u = document.getElementById("u") as HTMLInputElement;
    t.value = "typed";
    u.value = "more";
    u.focus();
    submit();
    await flush();
    expect(t.value).toBe("typed");
    ok = true;
    submit();
    await flush();
    expect([t.value, u.value]).toEqual(["", ""]);
    expect(document.activeElement).toBe(t);
  });

  it("data-yx-reset on a form the response removed doesn't throw", async () => {
    stubFetch(() => html('<div id="r" data-yx-region>gone</div>'));
    show('<div id="r" data-yx-region><form data-yx data-yx-reset method="post" action="/a"><input name="t" value="x"></form></div>');
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    submit();
    await flush();
    expect(document.getElementById("r")!.textContent).toBe("gone");
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("confirm", () => {
  it.each([
    [false, 0],
    [true, 1],
  ])("confirm() answering %s sends %i requests", async (answer, count) => {
    const ask = vi.fn(() => answer);
    vi.stubGlobal("confirm", ask);
    const calls = stubFetch(() => html("", 204));
    show('<form data-yx data-yx-confirm="Really delete &quot;x&quot;?" method="post" action="/a"><button>x</button></form>');
    const event = submit();
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(ask).toHaveBeenCalledWith('Really delete "x"?');
    expect(posts(calls)).toHaveLength(count);
    expect(document.querySelector("button")!.disabled).toBe(false);
  });

  it("an empty data-yx-confirm doesn't ask", async () => {
    const ask = vi.fn(() => false);
    vi.stubGlobal("confirm", ask);
    const calls = stubFetch(() => html("", 204));
    show('<form data-yx data-yx-confirm="" method="post" action="/a"></form>');
    submit();
    await flush();
    expect(ask).not.toHaveBeenCalled();
    expect(posts(calls)).toHaveLength(1);
  });
});

describe("errors", () => {
  const form = (extra = "") => `<form data-yx method="post" action="/a">
    <label for="title">Title *</label><input id="title" name="title"><span data-yx-error="title"></span>
    <label>Price: <input name="price"></label>
    <label>Email? <input name="email"></label>
    <input type="radio" name="size" value="s"><input type="radio" name="size" value="m">
    ${extra}<p data-yx-error></p><button>save</button></form>`;

  it.each([
    ["plain text", html("Out of stock", 409), "Out of stock"],
    ["a JSON error", json({ error: "Not yours" }, 403), "Not yours"],
    ["JSON with an empty issues list", json({ error: "Bad", issues: [] }), "Bad"],
    ["broken JSON", new Response("{oops", { status: 400, headers: { "content-type": "application/json" } }), "{oops"],
    ["JSON that isn't an object", json("just a string"), '"just a string"'],
    ["an empty body", new Response("", { status: 503, statusText: "Service Unavailable" }), "Service Unavailable"],
    ["HTML in the message stays text", html("<img src=x onerror=alert(1)>", 400), "<img src=x onerror=alert(1)>"],
  ])("%s goes in the form's box", async (_name, response, expected) => {
    stubFetch(() => response.clone());
    show(form());
    submit();
    await flush();
    expect(errorText()).toBe(expected);
    expect(document.querySelector("p[data-yx-error] img")).toBeNull();
  });

  it("labels issues by <label for>, a wrapping label, or the name, minus trailing marks", async () => {
    stubFetch(() => issues(["price", "Too low"], ["email", "Not an email"], ["nickname", "Taken"], ["size", "Pick one"]));
    show(form());
    submit();
    await flush();
    expect(errorText()).toBe("Price: Too low. Email: Not an email. nickname: Taken. size: Pick one");
  });

  it("a field box takes its message unlabelled; the field is marked and focused first", async () => {
    stubFetch(() => issues(["price", "Too low"], ["title", "Can't be empty"]));
    show(form());
    submit();
    await flush();
    expect(errorText('[data-yx-error="title"]')).toBe("Can't be empty");
    expect(errorText()).toBe("Price: Too low");
    expect(document.activeElement).toBe(document.querySelector("[name=price]"));
    for (const name of ["price", "title"]) {
      const field = document.querySelector(`[name=${name}]`)!;
      expect([field.getAttribute("aria-invalid"), field.hasAttribute("data-yx-invalid")]).toEqual(["true", true]);
    }
  });

  it("a radio group's issue marks its first radio", async () => {
    stubFetch(() => issues(["size", "Pick one"]));
    show(form());
    submit();
    await flush();
    const [s, m] = Array.from(document.querySelectorAll("[name=size]"));
    expect(s!.getAttribute("aria-invalid")).toBe("true");
    expect(m!.hasAttribute("aria-invalid")).toBe(false);
  });

  it("(root) and empty paths are unlabelled", async () => {
    stubFetch(() => issues(["(root)", "Whole thing"], ["", "Also whole"]));
    show(form());
    submit();
    await flush();
    expect(errorText()).toBe("Whole thing. Also whole");
  });

  it("two issues for one field box: the last wins there", async () => {
    stubFetch(() => issues(["title", "First"], ["title", "Second"]));
    show(form());
    submit();
    await flush();
    expect(errorText('[data-yx-error="title"]')).toBe("Second");
  });

  it("a box for a field the form doesn't have still shows its message", async () => {
    stubFetch(() => issues(["ghost", "Boo"]));
    show(form('<span data-yx-error="ghost"></span>'));
    submit();
    await flush();
    expect(errorText('[data-yx-error="ghost"]')).toBe("Boo");
  });

  it("an issue path that is a selector-ish string is compared, not queried", async () => {
    stubFetch(() => issues(['a"]', "Odd"], ["items.0.name", "Nested"]));
    show(form('<span data-yx-error="items.0.name"></span>'));
    submit();
    await flush();
    expect(errorText('[data-yx-error="items.0.name"]')).toBe("Nested");
    expect(errorText()).toBe('a"]: Odd');
  });

  it("everything is cleared on the next submit, the form's own box included", async () => {
    let next: () => Response = () => html("General failure", 400);
    stubFetch(() => next());
    show(form());
    submit();
    await flush();
    expect(errorText()).toBe("General failure");
    // Now only a field error, which has its own box: the old general message must go.
    next = () => issues(["title", "Can't be empty"]);
    submit();
    await flush();
    expect(errorText('[data-yx-error="title"]')).toBe("Can't be empty");
    expect(errorText()).toBe("");
    next = () => html("", 204);
    submit();
    await flush();
    expect(errorText('[data-yx-error="title"]')).toBe("");
    expect(document.querySelector("[aria-invalid]")).toBeNull();
  });

  it("without a box, failures become a notice", async () => {
    stubFetch(() => issues(["title", "Can't be empty"]));
    show('<form data-yx method="post" action="/a"><input name="title"></form>');
    submit();
    await flush();
    expect(document.getElementById("yx-notice")!.textContent).toBe("title: Can't be empty");
    expect(document.getElementById("yx-notice")!.getAttribute("role")).toBe("status");
  });

  it("an error box inside a nested form-like element is still the form's", async () => {
    stubFetch(() => html("Nope", 400));
    show('<form data-yx method="post" action="/a"><fieldset><div><p data-yx-error></p></div></fieldset></form>');
    submit();
    await flush();
    expect(errorText()).toBe("Nope");
  });

  it("can't reach the server: says so in the box, and logs the error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    show(form());
    submit();
    await flush();
    expect(errorText()).toBe("Couldn't reach the server. Please try again in a moment.");
    expect(log).toHaveBeenCalled();
  });
});

describe("stale pages", () => {
  it("a stale token reloads the page and says so in the form's box", async () => {
    const calls = stubFetch(
      () => new Response("Invalid action signature", { status: 400, headers: { "yx-stale": "1" } }),
      () => page('<form data-yx method="post" action="/a"><input type="hidden" name="_yx" value="NEW"><p data-yx-error></p></form>'),
    );
    show('<form data-yx method="post" action="/a"><input type="hidden" name="_yx" value="OLD"><p data-yx-error></p></form>');
    submit();
    await flush();
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);
    expect(document.querySelector<HTMLInputElement>("[name=_yx]")!.value).toBe("NEW");
    expect(errorText()).toMatch(/out of date/);
    expect(document.getElementById("yx-notice")).toBeNull();
  });

  it("when the fresh page has no box, it becomes a notice", async () => {
    stubFetch(
      () => new Response("expired", { status: 403, headers: { "yx-stale": "1" } }),
      () => page("<p>fresh, no form</p>"),
    );
    show('<form data-yx method="post" action="/a"><p data-yx-error></p></form>');
    submit();
    await flush();
    expect(document.getElementById("yx-notice")!.textContent).toMatch(/out of date/);
  });
});

describe("notices", () => {
  it("one notice box at a time, replaced by the next, gone after 5s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stubFetch(() => html("first", 400));
    show('<form data-yx method="post" action="/a"></form>');
    submit();
    await vi.advanceTimersByTimeAsync(10);
    expect(document.querySelectorAll("#yx-notice")).toHaveLength(1);
    expect(document.getElementById("yx-notice")!.textContent).toBe("first");
    await vi.advanceTimersByTimeAsync(4000);
    stubFetch(() => html("second", 400));
    submit();
    await vi.advanceTimersByTimeAsync(10);
    expect(document.querySelectorAll("#yx-notice")).toHaveLength(1);
    expect(document.getElementById("yx-notice")!.textContent).toBe("second");
    // The first one's timer doesn't cut the second short.
    await vi.advanceTimersByTimeAsync(2000);
    expect(document.getElementById("yx-notice")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(3100);
    expect(document.getElementById("yx-notice")).toBeNull();
  });

  it("a yx:notice listener that prevents default shows it its own way", async () => {
    const seen: string[] = [];
    const listen = (e: Event) => {
      e.preventDefault();
      seen.push((e as CustomEvent<{ message: string }>).detail.message);
    };
    document.addEventListener("yx:notice", listen);
    stubFetch(() => html("Nope", 400));
    show('<form data-yx method="post" action="/a"></form>');
    submit();
    await flush();
    document.removeEventListener("yx:notice", listen);
    expect(seen).toEqual(["Nope"]);
    expect(document.getElementById("yx-notice")).toBeNull();
  });

  it("a listener that doesn't prevent default still gets the box shown", async () => {
    const listen = vi.fn();
    document.addEventListener("yx:notice", listen);
    stubFetch(() => html("Nope", 400));
    show('<form data-yx method="post" action="/a"></form>');
    submit();
    await flush();
    document.removeEventListener("yx:notice", listen);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(document.getElementById("yx-notice")!.textContent).toBe("Nope");
  });

  it("a page element with id yx-notice is used as the box", async () => {
    stubFetch(() => html("Nope", 400));
    show('<form data-yx method="post" action="/a"></form><div id="yx-notice" class="mine"></div>');
    submit();
    await flush();
    const box = document.getElementById("yx-notice")!;
    expect(box.className).toBe("mine");
    expect(box.textContent).toBe("Nope");
  });
});

describe("data-yx-submit", () => {
  it("a change on the input submits its form; other changes don't", async () => {
    const calls = stubFetch(() => html("", 204));
    show('<form data-yx method="post" action="/a"><input type="checkbox" name="done" data-yx-submit><input type="checkbox" name="other"></form>');
    const [done, other] = Array.from(document.querySelectorAll("input"));
    other!.checked = true;
    other!.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(posts(calls)).toHaveLength(0);
    done!.checked = true;
    done!.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(String(posts(calls)[0]!.body)).toBe("done=on&other=on");
  });

  it("an input outside any form doesn't throw", async () => {
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.error);
    window.addEventListener("error", onError);
    show('<input type="checkbox" data-yx-submit>');
    document.querySelector("input")!.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    window.removeEventListener("error", onError);
    expect(errors).toEqual([]);
  });
});
