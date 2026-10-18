// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runtimeSource } from "../../src/client/runtime.js";

beforeAll(() => {
  // What <Scripts auto /> renders; the runtime reads it on start.
  const script = document.createElement("script");
  script.setAttribute("data-yx-auto", "");
  document.head.appendChild(script);
  new Function(runtimeSource())();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function page(body: string, url?: string): Response {
  const response = new Response(`<html><head><title>t</title></head><body>${body}</body></html>`, { headers: { "content-type": "text/html" } });
  if (url) Object.defineProperty(response, "url", { value: url });
  return response;
}

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const fn = vi.fn((url: string | URL, init: RequestInit = {}) => Promise.resolve(handler(String(url), init)));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function click(el: Element): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  el.dispatchEvent(event);
  return event;
}

describe("auto mode", () => {
  it("boosts a plain link: no attributes needed", async () => {
    const fetch = stubFetch(() => page("<main>second</main>"));
    document.body.innerHTML = '<a id="go" href="/second">go</a>';
    const event = click(document.getElementById("go")!);
    expect(event.defaultPrevented).toBe(true);
    await flush();
    expect((fetch.mock.calls[0]![1]!.headers as Record<string, string>)["yx-boost"]).toBe("1");
    expect(location.pathname).toBe("/second");
    expect(document.querySelector("main")?.textContent).toBe("second");
  });

  it("leaves files, other origins, targets and opted-out links to the browser", () => {
    stubFetch(() => page(""));
    document.body.innerHTML = `
      <a id="pdf" href="/report.pdf">pdf</a>
      <a id="ext" href="https://elsewhere.example/">ext</a>
      <a id="blank" href="/x" target="_blank">blank</a>
      <a id="rel" href="/x" rel="external">rel</a>
      <div data-yx-boost="false"><a id="off" href="/x">off</a></div>`;
    for (const id of ["pdf", "ext", "blank", "rel", "off"]) {
      // Window listeners run after the runtime's (on document): record whether
      // it took the click, then stop happy-dom from really navigating.
      let taken: boolean | undefined;
      window.addEventListener("click", (e) => {
        taken = e.defaultPrevented;
        e.preventDefault();
      }, { once: true });
      click(document.getElementById(id)!);
      expect(taken, id).toBe(false);
    }
  });

  it("submits a plain form with fetch and morphs in the page it lands on", async () => {
    const fetch = stubFetch(() => page('<p id="done">saved</p>', `${location.origin}/thanks`));
    document.body.innerHTML = '<form method="post" action="/signup"><input name="name" value="ada"><button>go</button></form>';
    const form = document.querySelector("form")!;
    const event = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: form.querySelector("button") });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await flush();
    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(url).pathname).toBe("/signup");
    // Not an action request: redirects are followed, not turned into yx-location.
    expect((init!.headers as Record<string, string>).yx).toBeUndefined();
    expect(String(init!.body)).toBe("name=ada");
    expect(location.pathname).toBe("/thanks");
    expect(document.getElementById("done")?.textContent).toBe("saved");
  });

  it("starts fetching a link on mousedown, and the click uses it", async () => {
    const fetch = stubFetch(() => page("<main>warm</main>"));
    document.body.innerHTML = '<a id="w" href="/warm">warm</a>';
    const link = document.getElementById("w")!;
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect((fetch.mock.calls[0]![1]!.headers as Record<string, string>)["yx-prefetch"]).toBe("1");
    click(link);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(document.querySelector("main")?.textContent).toBe("warm");
  });
});
