/**
 * yerd's client runtime, served at /_yerd/runtime.js.
 *
 * The whole runtime is one self-contained function. The server sends its
 * source (`fn.toString()` of whatever the compiler produced) wrapped in an
 * IIFE, so it must not reference anything outside itself: no imports, no
 * module-level helpers. Everything is a progressive enhancement of plain HTML;
 * with this script blocked, every form and link still works.
 *
 * - form[data-yx]       action forms: submitted with fetch, Regions morphed in
 *                       (a form inside a <details> closes it on success)
 * - [data-yx-submit]    inputs that submit their form on change (checkboxes)
 * - [data-yx-confirm]   ask before submitting
 * - [data-yx-reset]     reset the form after a successful submit
 * - a[data-yx-boost]    fetch the page, morph <body> into it, pushState
 *                       (also any link inside an element with data-yx-boost)
 * - [data-yx-live=url]  EventSource; every message refreshes the page's Regions
 * - [data-yx-error]     inside a form: where error messages from the server go
 * - [data-yx-new]       set on elements a morph inserted (style entrance animations with it)
 * - [data-yx-action]    an action on any element: posted (with its data-yx-token)
 *                       when its data-yx-trigger fires: an event ("click",
 *                       "input 250ms", "keydown:Enter"), "visible", "load", "every 5s"
 * - [data-yx-trigger]   on an action form: submits it on that trigger
 * - [data-yx-holes]     values the server left for the browser: read from the
 *                       element (or ref(selector)) when the action fires, sent as _yxh<n>
 * - [data-yx-append]    on a Region in a response: children are appended, not replaced
 *                       (data-yx-prepend: put first)
 * - [data-yx-defer]     a prerendered <Dynamic> skeleton: filled from the server after load
 * - [data-yx-disabled]  set on the buttons a pending submit disabled (and will re-enable)
 * - [data-yx-prefetch]  warm a page or JSON response before it's needed (the `prefetch` prop)
 * - <yerd-local>        client-side state from <Local>: data-yx-on-* handlers
 *                       run against it, data-yx-text / data-yx-bind follow it
 *
 * Auto mode (<Scripts auto />, i.e. script[data-yx-auto]) drops the
 * attributes: every same-origin link boosts, every form submits with fetch
 * and morphs in whatever page the server lands on, and the pointer's path is
 * extrapolated to prefetch the link it's heading for before it gets there.
 * data-yx-boost="false" on an element (or an ancestor) opts it out.
 *
 * Custom attributes (attribute() on the server) register their client half
 * through yerd.attribute(name, setup); a MutationObserver connects and
 * disconnects them as elements come and go, morphs and boosts included.
 *
 * Morphing patches the live DOM in place: elements are matched by id or
 * data-key, attributes and text are patched, focused fields keep their value
 * and caret, and an open <details> stays open.
 */
export function yerdRuntime(): void {
  // Guard on a symbol: `<div id="yerd">` makes `window.yerd` an element.
  const mark = Symbol.for("yerd.runtime");
  const flags = window as unknown as Record<symbol, unknown>;
  if (flags[mark]) return;
  flags[mark] = true;

  function keyOf(node: Node): string | null {
    if (node.nodeType !== 1) return null;
    const el = node as Element;
    return el.getAttribute("data-key") ?? (el.id ? `#${el.id}` : null);
  }

  function sameKind(a: Node, b: Node): boolean {
    return a.nodeType === b.nodeType && a.nodeName === b.nodeName;
  }

  /** What the server last sent as a field's value, read before the morph patches it. */
  function serverValue(el: Element): string | null {
    if (el instanceof HTMLInputElement) return el.getAttribute("value") ?? "";
    if (el instanceof HTMLTextAreaElement) return el.defaultValue;
    return null;
  }

  function syncFormState(from: Element, to: Element, prior: string | null): void {
    const focused = from === document.activeElement;
    if (from instanceof HTMLInputElement && to instanceof HTMLInputElement) {
      // A file input can't be set, and what it holds is the user's pick.
      if (from.type === "file") return;
      if (from.type === "checkbox" || from.type === "radio") from.checked = to.hasAttribute("checked");
      else {
        // Take the server's value unless only the user changed it.
        const next = to.getAttribute("value") ?? "";
        if (!focused && (from.value === prior || next !== prior)) from.value = next;
      }
    } else if (from instanceof HTMLTextAreaElement && to instanceof HTMLTextAreaElement) {
      const next = to.textContent ?? "";
      const edited = from.value !== prior;
      if (from.defaultValue !== next) from.defaultValue = next;
      if (!focused && (!edited || next !== prior)) from.value = next;
    }
  }

  function morphAttributes(from: Element, to: Element): void {
    for (const { name, value } of Array.from(to.attributes)) {
      if (from.getAttribute(name) !== value) from.setAttribute(name, value);
    }
    for (const { name } of Array.from(from.attributes)) {
      // `open` on <details>/<dialog> belongs to the user, not the template.
      if (!to.hasAttribute(name) && name !== "open") from.removeAttribute(name);
    }
  }

  function morph(from: Node, to: Node): void {
    if (!sameKind(from, to)) {
      from.parentNode?.replaceChild(to, from);
      return;
    }
    if (from.nodeType === 3 || from.nodeType === 8) {
      if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
      return;
    }
    if (from.nodeType !== 1) return;
    const a = from as Element;
    const b = to as Element;
    if (a.hasAttribute("data-yx-keep")) return;
    const prior = serverValue(a);
    morphAttributes(a, b);
    syncFormState(a, b, prior);
    // Textarea content is its value; patched above.
    if (a instanceof HTMLTextAreaElement) return;
    // Read before morphChildren moves new options out of `b`.
    const picked = b instanceof HTMLSelectElement ? Array.from(b.options, (o) => o.hasAttribute("selected")) : null;
    morphChildren(a, b);
    if (picked && a instanceof HTMLSelectElement && a !== document.activeElement) {
      Array.from(a.options).forEach((option, i) => (option.selected = picked[i] ?? false));
    }
  }

  function morphChildren(from: Element, to: Element): void {
    const keyed = new Map<string, Node>();
    for (const child of Array.from(from.childNodes)) {
      const key = keyOf(child);
      if (key) keyed.set(key, child);
    }
    let cursor: Node | null = from.firstChild;
    for (const next of Array.from(to.childNodes)) {
      const key = keyOf(next);
      const match = key ? keyed.get(key) : undefined;
      if (match) {
        keyed.delete(key!);
        if (match === cursor) cursor = cursor.nextSibling;
        else from.insertBefore(match, cursor);
        morph(match, next);
        continue;
      }
      // Skip keyed nodes that a later new child will claim.
      while (cursor && keyOf(cursor) && keyed.has(keyOf(cursor)!)) cursor = cursor.nextSibling;
      if (cursor && !keyOf(cursor) && sameKind(cursor, next)) {
        const after: Node | null = cursor.nextSibling;
        morph(cursor, next);
        cursor = after;
      } else {
        // Mark freshly inserted elements so CSS can animate just those: [data-yx-new].
        if (next.nodeType === 1) (next as Element).setAttribute("data-yx-new", "");
        from.insertBefore(next, cursor);
      }
    }
    while (cursor) {
      const after: Node | null = cursor.nextSibling;
      const key = keyOf(cursor);
      if (!key || !keyed.has(key)) from.removeChild(cursor);
      cursor = after;
    }
    for (const leftover of keyed.values()) leftover.parentNode?.removeChild(leftover);
  }

  /**
   * An appending (or prepending) Region: its children join the target's.
   * One the target already has (same id or key) is morphed in place instead.
   */
  function insertChildren(target: Element, incoming: Element): void {
    const prepend = incoming.hasAttribute("data-yx-prepend");
    const anchor = prepend ? target.firstChild : null;
    const existing = new Map<string, Node>();
    for (const child of Array.from(target.childNodes)) {
      const key = keyOf(child);
      if (key) existing.set(key, child);
    }
    for (const child of Array.from(incoming.childNodes)) {
      const key = keyOf(child);
      const match = key ? existing.get(key) : undefined;
      if (match) {
        morph(match, child);
        continue;
      }
      if (child.nodeType === 1) (child as Element).setAttribute("data-yx-new", "");
      target.insertBefore(child, anchor);
    }
  }

  /** Morph every Region in `html` into the matching element on the page. Returns how many matched. */
  function apply(html: string): number {
    const doc = new DOMParser().parseFromString(html, "text/html");
    let applied = 0;
    for (const region of Array.from(doc.querySelectorAll("[data-yx-region]"))) {
      const target = region.id ? document.getElementById(region.id) : null;
      if (!target) continue;
      const incoming = document.importNode(region, true);
      if (incoming.hasAttribute("data-yx-append") || incoming.hasAttribute("data-yx-prepend")) insertChildren(target, incoming);
      else morph(target, incoming);
      applied++;
    }
    if (doc.title && doc.querySelector("head title")) document.title = doc.title;
    document.dispatchEvent(new CustomEvent("yx:applied", { detail: { regions: applied } }));
    return applied;
  }

  // Every navigation bumps `nav`; responses that arrive for an older one are dropped.
  const auto = document.querySelector("script[data-yx-auto]") !== null;

  /** Links the runtime navigates itself: same-origin pages, boosted (or anything, in auto mode). */
  function boostable(link: HTMLAnchorElement): boolean {
    if (link.target && link.target !== "_self") return false;
    if (link.hasAttribute("download") || link.origin !== location.origin) return false;
    if (/(^|\s)external(\s|$)/i.test(link.rel)) return false;
    const opted = link.closest("[data-yx-boost]");
    if (opted?.getAttribute("data-yx-boost") === "false") return false;
    if (!opted && !auto) return false;
    // A file, not a page (report.pdf, data.json): the browser's to handle.
    return !/\.(?!html?$)[a-z0-9]{1,5}$/i.test(link.pathname);
  }

  /** Morph a whole page in: <body> and the title. */
  function showPage(html: string): void {
    const doc = new DOMParser().parseFromString(html, "text/html");
    morph(document.body, document.importNode(doc.body, true));
    if (doc.title) document.title = doc.title;
  }

  let nav = 0;
  let navAbort: AbortController | undefined;
  // The path and query the DOM is showing; fragment changes don't count.
  let page = location.pathname + location.search;
  let refreshing: Promise<void> | undefined;
  let refreshAbort: AbortController | undefined;
  let again = false;

  // Prefetched responses, by kind and URL: short-lived, and dropped whenever
  // the page's data may have changed (a form submit, a live message).
  type Fetched = { ok: boolean; status: number; type: string; url: string; text: string };
  const prefetched = new Map<string, { at: number; got: Promise<Fetched | undefined> }>();
  const PREFETCH_TTL = 15000;

  async function fetchText(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Fetched> {
    const response = await fetch(url, { headers, signal });
    return { ok: response.ok, status: response.status, type: response.headers.get("content-type") ?? "", url: response.url, text: await response.text() };
  }

  function prefetch(url: string, as: "page" | "json" = "page"): void {
    const target = new URL(url, location.href);
    if (target.origin !== location.origin) return;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (connection && (connection.saveData || /2g/.test(connection.effectiveType ?? ""))) return;
    target.hash = "";
    const key = `${as} ${target.href}`;
    const hit = prefetched.get(key);
    if (hit && Date.now() - hit.at < PREFETCH_TTL) return;
    const headers: Record<string, string> = as === "page"
      ? { "yx-boost": "1", "yx-prefetch": "1", accept: "text/html" }
      : { "yx-prefetch": "1", accept: "application/json" };
    const got = fetchText(target.href, headers).then(
      (r) => (r.ok ? r : undefined),
      () => undefined,
    );
    prefetched.set(key, { at: Date.now(), got });
    // Oldest out first (a Map keeps insertion order).
    while (prefetched.size > 30) prefetched.delete(prefetched.keys().next().value!);
  }

  /** A fresh prefetch of this URL, if there is one. */
  function warm(url: string, as: "page" | "json"): Promise<Fetched | undefined> | undefined {
    const target = new URL(url, location.href);
    target.hash = "";
    const key = `${as} ${target.href}`;
    const hit = prefetched.get(key);
    if (!hit) return undefined;
    // A page is used once: the next visit should see newer data.
    if (as === "page") prefetched.delete(key);
    return Date.now() - hit.at < PREFETCH_TTL ? hit.got : undefined;
  }

  /** fetch(), answered from a fresh JSON prefetch of the same URL when there is one. */
  async function cachedFetch(url: string, init?: RequestInit): Promise<Response> {
    if (!init || !init.method || init.method.toUpperCase() === "GET") {
      const hit = await warm(url, "json");
      if (hit) return new Response(hit.text, { status: hit.status, headers: { "content-type": hit.type } });
    }
    return fetch(url, init);
  }

  /** Boosted navigation: fetch a page and morph the whole <body> into it (focus and state survive where elements match). */
  async function load(url: string, push: boolean): Promise<void> {
    const target = new URL(url, location.href);
    // Only our own pages are morphed in; anything else is a real navigation.
    if (target.origin !== location.origin) {
      location.assign(target.href);
      return;
    }
    const seq = ++nav;
    navAbort?.abort();
    refreshAbort?.abort();
    again = false;
    const abort = (navAbort = new AbortController());
    document.documentElement.setAttribute("aria-busy", "true");
    try {
      const got =
        (await warm(target.href, "page")) ??
        (await fetchText(target.href, { "yx-boost": "1", accept: "text/html" }, abort.signal));
      if (seq !== nav) return;
      const landed = got.url ? new URL(got.url) : new URL(target.href);
      if (!got.type.includes("text/html") || landed.origin !== location.origin) {
        location.assign(target.href);
        return;
      }
      const html = got.text;
      // fetch drops the fragment; keep the one that was asked for.
      if (!landed.hash) landed.hash = target.hash;
      if (push) {
        // Remember where this page was scrolled, for Back.
        history.replaceState({ ...(history.state as object | null), yx: true, scroll: window.scrollY }, "");
        history.pushState({ yx: true }, "", landed.href);
      }
      page = location.pathname + location.search;
      showPage(html);
      if (!push) {
        const scroll = (history.state as { scroll?: unknown } | null)?.scroll;
        if (typeof scroll === "number") window.scrollTo(0, scroll);
      } else {
        let id = landed.hash.slice(1);
        try {
          id = decodeURIComponent(id);
        } catch {
          // not percent-encoded; use it as it is
        }
        const anchor = id ? document.getElementById(id) : null;
        if (anchor) anchor.scrollIntoView();
        else window.scrollTo(0, 0);
      }
      document.querySelector<HTMLElement>("[autofocus]")?.focus();
      document.dispatchEvent(new CustomEvent("yx:applied", { detail: { regions: -1 } }));
    } catch {
      // A newer navigation aborted this one; it owns the page now.
      if (seq === nav) location.assign(target.href);
    } finally {
      if (seq === nav) document.documentElement.removeAttribute("aria-busy");
    }
  }

  /** Re-fetch the current page and morph its Regions. Coalesces bursts; a navigation cancels it. */
  function refresh(): Promise<void> {
    if (refreshing) {
      again = true;
      return refreshing;
    }
    const seq = nav;
    const abort = (refreshAbort = new AbortController());
    refreshing = (async () => {
      try {
        const response = await fetch(location.href, { headers: { "yx-boost": "1", accept: "text/html" }, signal: abort.signal });
        if (response.ok) {
          const html = await response.text();
          if (seq === nav) apply(html);
        }
      } catch (error) {
        if (seq === nav) throw error;
      } finally {
        refreshing = undefined;
        if (again) {
          again = false;
          void refresh();
        }
      }
    })();
    return refreshing;
  }

  /**
   * A form attribute, overridden by the submitter's form* attribute
   * (formaction, formmethod, ...). Read with getAttribute: a field named
   * "action" or "method" shadows the form's properties.
   */
  function formAttr(form: HTMLFormElement, submitter: HTMLElement | null, name: string): string | null {
    if (submitter?.hasAttribute(`form${name}`)) return submitter.getAttribute(`form${name}`);
    return form.getAttribute(name);
  }

  /** Forms aimed at another window, or method=dialog, are the browser's. */
  function intercepts(form: HTMLFormElement, submitter: HTMLElement | null): boolean {
    const target = formAttr(form, submitter, "target");
    if (target && target.toLowerCase() !== "_self") return false;
    return (formAttr(form, submitter, "method") ?? "").toLowerCase() !== "dialog";
  }

  async function submit(form: HTMLFormElement, submitter: HTMLElement | null): Promise<void> {
    const question = form.getAttribute("data-yx-confirm");
    if (question && !confirm(question)) return;
    // An empty or missing action submits to the page itself.
    const url = new URL(formAttr(form, submitter, "action") || location.href, form.baseURI);
    const method = (formAttr(form, submitter, "method") || "get").toLowerCase();
    const data = new FormData(form, submitter as HTMLButtonElement | null);
    const holes = holeValues(submitter?.getAttribute("data-yx-holes") != null ? submitter : form);
    if (!holes) return;
    for (const [name, value] of holes) data.append(name, value);
    const entries = Array.from(data);
    if (method === "get") {
      // Like the browser: the fields become the query, and a file becomes its name.
      url.search = new URLSearchParams(entries.map(([name, value]) => [name, typeof value === "string" ? value : value.name])).toString();
      await load(url.href, true);
      return;
    }
    // Files go up as multipart (fetch sets the boundary); everything else urlencoded.
    const hasFiles = entries.some(([, value]) => typeof value !== "string" && (value.name !== "" || value.size > 0));
    const multipart = hasFiles || (formAttr(form, submitter, "enctype") ?? "").toLowerCase() === "multipart/form-data";
    const body = multipart ? data : new URLSearchParams(entries.map(([name, value]) => [name, typeof value === "string" ? value : value.name]));
    // Plain forms (auto mode) let fetch follow redirects to the page they land
    // on; action forms get yx-location instead (see below).
    const headers: Record<string, string> = form.hasAttribute("data-yx") ? { yx: "1", accept: "text/html" } : { accept: "text/html" };
    if (!multipart) headers["content-type"] = "application/x-www-form-urlencoded";
    const errorBox = form.querySelector<HTMLElement>("[data-yx-error]");
    // Only buttons this submit disables are re-enabled after. The mark also
    // tells when a morph has since given a button the server's state instead.
    const buttons = Array.from(form.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input[type=submit]")).filter((b) => !b.disabled);
    form.setAttribute("aria-busy", "true");
    for (const b of buttons) {
      b.disabled = true;
      b.setAttribute("data-yx-disabled", "");
    }
    try {
      const response = await fetch(url.href, { method: "POST", body, headers });
      const location_ = response.headers.get("yx-location");
      if (location_) {
        await load(location_, true);
        return;
      }
      // A plain form (auto mode): whatever page the server answered with,
      // after following its redirects, is the new page, errors included.
      const plain = !form.hasAttribute("data-yx");
      if (plain && (response.headers.get("content-type") ?? "").includes("text/html")) {
        const html = await response.text();
        const landed = new URL(response.url || url.href);
        prefetched.clear();
        if (landed.pathname + landed.search !== location.pathname + location.search) {
          history.replaceState({ ...(history.state as object | null), yx: true, scroll: window.scrollY }, "");
          history.pushState({ yx: true }, "", landed.href);
          page = location.pathname + location.search;
          window.scrollTo(0, 0);
        }
        showPage(html);
        document.querySelector<HTMLElement>("[autofocus]")?.focus();
        document.dispatchEvent(new CustomEvent("yx:applied", { detail: { regions: -1 } }));
        return;
      }
      if (!response.ok) {
        let message = (await response.text()) || response.statusText;
        if ((response.headers.get("content-type") ?? "").includes("json")) {
          try {
            const data = JSON.parse(message) as { error?: string; issues?: Array<{ message: string }> };
            message = data.issues?.length ? data.issues.map((i) => i.message).join(". ") : (data.error ?? message);
          } catch {
            // not JSON after all; show it as text
          }
        }
        if (errorBox) errorBox.textContent = message;
        else console.error("[yerd]", response.status, message);
        return;
      }
      if (errorBox) errorBox.textContent = "";
      prefetched.clear();
      if (response.status === 204) await refresh();
      else if (apply(await response.text()) === 0) await refresh();
      if (form.hasAttribute("data-yx-reset") && form.isConnected) {
        HTMLFormElement.prototype.reset.call(form);
        form.querySelector<HTMLElement>("[autofocus]")?.focus();
      }
      // A form inside a <details> (inline editors, menus) closes once it's done.
      form.closest("details")?.removeAttribute("open");
    } catch (error) {
      if (errorBox) errorBox.textContent = "Network error, please try again.";
      console.error("[yerd]", error);
    } finally {
      form.removeAttribute("aria-busy");
      for (const b of buttons) {
        if (!b.hasAttribute("data-yx-disabled")) continue;
        b.removeAttribute("data-yx-disabled");
        b.disabled = false;
      }
    }
  }

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || event.defaultPrevented) return;
    const submitter = (event as SubmitEvent).submitter;
    if (!form.hasAttribute("data-yx")) {
      // Auto mode: any same-origin form that isn't opted out.
      if (!auto || form.closest("[data-yx-boost]")?.getAttribute("data-yx-boost") === "false") return;
      const action = new URL(formAttr(form, submitter, "action") || location.href, form.baseURI);
      if (action.origin !== location.origin) return;
    }
    if (!intercepts(form, submitter)) return;
    event.preventDefault();
    void submit(form, submitter);
  });

  document.addEventListener("change", (event) => {
    const input = event.target as HTMLElement;
    if (!input.hasAttribute?.("data-yx-submit")) return;
    (input as HTMLInputElement).form?.requestSubmit();
  });

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element).closest?.("a[href]");
    if (!(link instanceof HTMLAnchorElement) || !boostable(link)) return;
    // A fragment on this same page: the browser just scrolls.
    if (link.href.includes("#") && link.pathname === location.pathname && link.search === location.search) return;
    event.preventDefault();
    void load(link.href, true);
  });

  // Back/Forward: only entries this runtime made (or marked), and only when
  // the page itself changed; fragment moves are left to the browser.
  window.addEventListener("popstate", (event) => {
    const state = (event as PopStateEvent).state as { yx?: unknown } | null;
    if (!state?.yx || location.pathname + location.search === page) return;
    void load(location.href, false);
  });
  function markEntry(): void {
    if (history.state === null) history.replaceState({ yx: true }, "");
  }
  markEntry();
  window.addEventListener("hashchange", markEntry);

  // Prerendered pages ship skeletons ([data-yx-defer]) for their <Dynamic>
  // parts; fetch the real content in one request and morph it in. This runs
  // after every load and apply, so skeletons a morph brings back (Back, a
  // refresh) are filled again. A part the server answers with its skeleton
  // again isn't asked for again until the next navigation, and a fill's own
  // apply never starts another.
  const stuck = new WeakMap<Element, number>();
  let filling = -1;
  let ownFill = false;
  async function fillDeferred(): Promise<void> {
    if (ownFill) return;
    const seq = nav;
    const parts = Array.from(document.querySelectorAll("[data-yx-defer]")).filter((el) => stuck.get(el) !== seq);
    if (!parts.length || filling === seq) return;
    filling = seq;
    try {
      const response = await fetch(location.href, { headers: { "yx-dynamic": "1", accept: "text/html" } });
      if (!response.ok || seq !== nav) return;
      const html = await response.text();
      if (seq !== nav) return;
      ownFill = true;
      try {
        apply(html);
      } finally {
        ownFill = false;
      }
      for (const el of parts) if (el.hasAttribute("data-yx-defer")) stuck.set(el, seq);
    } catch (error) {
      if (seq === nav) console.error("[yerd] couldn't load the page's dynamic parts", error);
    } finally {
      if (filling === seq) filling = -1;
    }
  }
  document.addEventListener("yx:applied", () => void fillDeferred());
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void fillDeferred());
  else void fillDeferred();

  // One EventSource per live URL on the page. Sources whose element is gone
  // are closed. When a dropped connection comes back the page refreshes, since
  // messages may have been missed; one the browser gave up on is reopened,
  // backing off.
  const live = new Map<string, EventSource>();
  function liveUrls(): Set<string> {
    return new Set(Array.from(document.querySelectorAll("[data-yx-live]"), (el) => el.getAttribute("data-yx-live")!));
  }
  function openLive(url: string, delay: number, missed: boolean): void {
    const source = new EventSource(url);
    source.onmessage = () => {
      prefetched.clear();
      void refresh();
    };
    source.onopen = () => {
      if (missed) void refresh();
      missed = false;
    };
    source.onerror = () => {
      missed = true;
      // CLOSED (2): the browser won't retry this one itself.
      if (source.readyState !== 2) return;
      setTimeout(() => {
        if (live.get(url) !== source) return;
        live.delete(url);
        if (liveUrls().has(url)) openLive(url, Math.min(delay * 2, 30000), true);
      }, delay);
    };
    live.set(url, source);
  }
  function connectLive(): void {
    const urls = liveUrls();
    for (const [url, source] of live) {
      if (urls.has(url)) continue;
      source.close();
      live.delete(url);
    }
    for (const url of urls) if (!live.has(url)) openLive(url, 1000, false);
  }
  document.addEventListener("yx:applied", connectLive);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", connectLive);
  else connectLive();

  // ── custom attributes ──
  // name -> the client half; element -> its connected attributes' handles.
  type Handle = { update?(value: string): void; disconnect?(): void };
  type Setup = (el: HTMLElement, value: string, api: unknown) => void | (() => void) | Handle;
  const setups = new Map<string, Setup>();
  const connected = new Map<Element, Map<string, Handle>>();

  function connectAttr(el: Element, name: string): void {
    const setup = setups.get(name);
    if (!setup || !el.isConnected) return;
    let byName = connected.get(el);
    if (byName?.has(name)) return;
    if (!byName) connected.set(el, (byName = new Map()));
    let handle: Handle = {};
    try {
      const result = setup(el as HTMLElement, el.getAttribute(name) ?? "", api);
      handle = typeof result === "function" ? { disconnect: result } : (result ?? {});
    } catch (error) {
      console.error(`[yerd] attribute ${name} failed to connect:`, error);
    }
    byName.set(name, handle);
  }

  function disconnectAttr(el: Element, name: string): void {
    const byName = connected.get(el);
    const handle = byName?.get(name);
    if (!byName || !handle) return;
    byName.delete(name);
    if (byName.size === 0) connected.delete(el);
    try {
      handle.disconnect?.();
    } catch (error) {
      console.error(`[yerd] attribute ${name} failed to disconnect:`, error);
    }
  }

  function scanAttrs(root: Element): void {
    for (const name of setups.keys()) {
      if (root.hasAttribute(name)) connectAttr(root, name);
      for (const el of Array.from(root.querySelectorAll(`[${name}]`))) connectAttr(el, name);
    }
  }

  function onMutations(records: MutationRecord[]): void {
    let removed = false;
    for (const record of records) {
      if (record.type === "attributes") {
        const el = record.target as Element;
        const name = record.attributeName!;
        if (!el.hasAttribute(name)) disconnectAttr(el, name);
        else {
          const handle = connected.get(el)?.get(name);
          const value = el.getAttribute(name)!;
          if (!handle) connectAttr(el, name);
          else if (value !== record.oldValue) handle.update?.(value);
        }
      } else {
        for (const node of Array.from(record.addedNodes)) if (node.nodeType === 1) scanAttrs(node as Element);
        if (record.removedNodes.length > 0) removed = true;
      }
    }
    // Moved elements (a keyed morph) are removed and re-added in one batch, so
    // only those still out of the document by now are really gone.
    if (removed) {
      for (const [el, byName] of Array.from(connected)) {
        if (!el.isConnected) for (const name of Array.from(byName.keys())) disconnectAttr(el, name);
      }
    }
  }
  const observer = new MutationObserver(onMutations);

  function attribute(name: string, setup: Setup): void {
    setups.set(name, setup);
    // Re-observe from scratch for the new filter (not every DOM replaces the
    // options of an existing observation), handling what's already queued.
    onMutations(observer.takeRecords());
    observer.disconnect();
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: Array.from(setups.keys()),
    });
    scanAttrs(document.documentElement);
  }

  // A press is ~100ms ahead of its click: start fetching a boosted link then.
  const pressed = (event: Event): void => {
    const link = (event.target as Element).closest?.("a[href]");
    if (link instanceof HTMLAnchorElement && boostable(link)) prefetch(link.href);
  };
  document.addEventListener("mousedown", pressed, { passive: true });
  document.addEventListener("touchstart", pressed, { passive: true });

  // Auto mode, with a mouse: guess where the pointer is going. The last few
  // samples give a velocity; if the pointer is slowing down (aiming, not
  // sweeping past), walk the path it would cover in the next 250ms and
  // prefetch the first link on it. Once per frame at most, and only while
  // the pointer moves.
  if (auto && typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches) {
    const samples: Array<[x: number, y: number, t: number]> = [];
    let queued = false;
    const predict = (): void => {
      queued = false;
      if (samples.length < 4) return;
      const [x0, y0, t0] = samples[0]!;
      const [xm, ym, tm] = samples[samples.length >> 1]!;
      const [x1, y1, t1] = samples[samples.length - 1]!;
      if (t1 - t0 <= 0 || t1 - t0 > 250) return;
      const vx = (x1 - x0) / (t1 - t0);
      const vy = (y1 - y0) / (t1 - t0);
      if (Math.hypot(vx, vy) < 0.05) return;
      const early = Math.hypot(xm - x0, ym - y0) / Math.max(tm - t0, 1);
      const late = Math.hypot(x1 - xm, y1 - ym) / Math.max(t1 - tm, 1);
      if (late > early * 0.9) return;
      for (let step = 1; step <= 5; step++) {
        const f = (step / 5) * 250;
        const hit = document.elementFromPoint(x1 + vx * f, y1 + vy * f)?.closest?.("a[href]");
        if (hit instanceof HTMLAnchorElement && boostable(hit)) {
          prefetch(hit.href);
          return;
        }
      }
    };
    document.addEventListener(
      "pointermove",
      (event) => {
        samples.push([event.clientX, event.clientY, event.timeStamp]);
        if (samples.length > 6) samples.shift();
        if (!queued) {
          queued = true;
          requestAnimationFrame(predict);
        }
      },
      { passive: true },
    );
  }

  // ── <Local> state ──
  // A <yerd-local> scope carries its initial state as JSON and the name its
  // handlers use for it. Handlers (data-yx-on-<event>) are compiled with the
  // state bound to that name; after each one, the scope's bindings
  // (data-yx-text, data-yx-bind) are re-applied from the state.
  type Scope = { el: Element; state: Record<string, unknown>; name: string; key?: string; storage?: Storage };
  const scopes = new WeakMap<Element, Scope>();
  const wired = new WeakSet<Element>();
  // Persisted scopes by storage key, so scopes sharing a key stay in step.
  const byKey = new Map<string, Set<Scope>>();
  const STORE_PREFIX = "yerd-local:";

  function storageFor(el: Element): Storage | undefined {
    try {
      return el.getAttribute("data-yx-storage") === "session" ? sessionStorage : localStorage;
    } catch {
      return undefined; // storage blocked: works, just doesn't persist
    }
  }

  function loadSaved(scope: Scope): void {
    if (!scope.key || !scope.storage) return;
    try {
      const saved = scope.storage.getItem(STORE_PREFIX + scope.key);
      if (saved) Object.assign(scope.state, JSON.parse(saved));
    } catch {
      // unreadable or blocked: keep the server's defaults
    }
  }

  /** Save a persisted scope and bring the others with its key (in this tab) up to date. */
  function save(scope: Scope): void {
    if (!scope.key || !scope.storage) return;
    try {
      scope.storage.setItem(STORE_PREFIX + scope.key, JSON.stringify(scope.state));
    } catch {
      // full or blocked: the page still works
    }
    for (const other of byKey.get(scope.key) ?? []) {
      if (other === scope || other.storage !== scope.storage) continue;
      if (!other.el.isConnected) {
        byKey.get(scope.key)!.delete(other);
        continue;
      }
      Object.assign(other.state, JSON.parse(JSON.stringify(scope.state)));
      applyBindings(other);
    }
  }

  // Another tab saved: follow it.
  window.addEventListener("storage", (event) => {
    if (!event.key?.startsWith(STORE_PREFIX) || event.newValue === null) return;
    for (const scope of byKey.get(event.key.slice(STORE_PREFIX.length)) ?? []) {
      if (scope.storage !== event.storageArea) continue;
      try {
        Object.assign(scope.state, JSON.parse(event.newValue));
      } catch {
        continue;
      }
      applyBindings(scope);
    }
  });

  function read(state: unknown, path: string): unknown {
    const negate = path.startsWith("!");
    let value: unknown = state;
    for (const key of (negate ? path.slice(1) : path).split(".")) {
      if (key === "") continue;
      value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    }
    return negate ? !value : value;
  }

  /** Elements that belong to this scope, not to a <Local> nested inside it. */
  function owned(scope: Scope, selector: string): Element[] {
    return Array.from(scope.el.querySelectorAll(selector)).filter((el) => el.closest("yerd-local") === scope.el);
  }

  function applyBindings(scope: Scope): void {
    for (const el of owned(scope, "[data-yx-text]")) {
      const value = read(scope.state, el.getAttribute("data-yx-text")!);
      const text = value === null || value === undefined ? "" : String(value);
      if (el.textContent !== text) el.textContent = text;
    }
    for (const el of owned(scope, "[data-yx-bind]")) {
      for (const entry of el.getAttribute("data-yx-bind")!.split(";")) {
        const at = entry.indexOf(":");
        if (at < 0) continue;
        const name = entry.slice(0, at);
        const value = read(scope.state, entry.slice(at + 1));
        if (name.startsWith("class.")) el.classList.toggle(name.slice(6), Boolean(value));
        else if (name === "value") (el as HTMLInputElement).value = value === null || value === undefined ? "" : String(value);
        else if (name === "checked") (el as HTMLInputElement).checked = Boolean(value);
        // Like the server renders them: aria-* and the enumerated attributes
        // take the words ("true" / "false", translate "yes" / "no"), not presence.
        else if (typeof value === "boolean" && (name.startsWith("aria-") || name === "draggable" || name === "spellcheck" || name === "contenteditable")) el.setAttribute(name, String(value));
        else if (typeof value === "boolean" && name === "translate") el.setAttribute(name, value ? "yes" : "no");
        else if (value === false || value === null || value === undefined) el.removeAttribute(name);
        else el.setAttribute(name, value === true ? "" : String(value));
      }
    }
  }

  function wire(scope: Scope): void {
    for (const el of [scope.el, ...owned(scope, "*")]) {
      if (wired.has(el)) continue;
      const handlers = Array.from(el.attributes).filter((a) => a.name.startsWith("data-yx-on-"));
      if (handlers.length === 0) continue;
      wired.add(el);
      for (const attr of handlers) {
        let fn: (event: Event) => unknown;
        try {
          fn = new Function(scope.name, `"use strict"; return (${attr.value});`)(scope.state) as (event: Event) => unknown;
        } catch (error) {
          console.error("[yerd] a <Local> handler didn't compile:", attr.value, error);
          continue;
        }
        el.addEventListener(attr.name.slice("data-yx-on-".length), (event) => {
          let result: unknown;
          try {
            result = fn(event);
          } finally {
            applyBindings(scope);
            save(scope);
          }
          if (result && typeof (result as Promise<unknown>).then === "function") {
            const after = () => {
              applyBindings(scope);
              save(scope);
            };
            void (result as Promise<unknown>).then(after, after);
          }
        });
      }
    }
  }

  // ── actions on any element, and triggers ──

  /**
   * The values an action left for the browser (data-yx-holes): fields of the
   * element itself or of ref(selector), read now. Undefined (and logged) when
   * a ref is missing: the action isn't sent.
   */
  function holeValues(el: Element): Array<[string, string]> | undefined {
    const spec = el.getAttribute("data-yx-holes");
    if (!spec) return [];
    let holes: string[][];
    try {
      holes = JSON.parse(spec) as string[][];
    } catch {
      return [];
    }
    const out: Array<[string, string]> = [];
    for (let i = 0; i < holes.length; i++) {
      const path = holes[i]!;
      let source: Element | null = el;
      let rest = path.slice(1);
      if (path[0] === "ref") {
        source = document.querySelector(path[1]!);
        rest = path.slice(2);
        if (!source) {
          console.error(`[yerd] action: ref(${JSON.stringify(path[1])}) matches nothing on the page`);
          return undefined;
        }
      }
      let value: unknown = source;
      for (const key of rest) value = value == null ? undefined : (value as Record<string, unknown>)[key];
      out.push([`_yxh${i}`, value == null ? "" : String(value)]);
    }
    return out;
  }

  const actionRuns = new WeakMap<Element, AbortController>();

  /** Post an element's action (a newer run cancels an older one: typeahead), then apply the result like a form's. */
  async function runAction(el: HTMLElement): Promise<void> {
    // A debounce or timer can outlive its element (morphed or navigated away).
    if (!el.isConnected) return;
    if (el instanceof HTMLFormElement) {
      el.requestSubmit();
      return;
    }
    const url = el.getAttribute("data-yx-action");
    const token = el.getAttribute("data-yx-token");
    if (!url || !token) return;
    const question = el.getAttribute("data-yx-confirm");
    if (question && !confirm(question)) return;
    const holes = holeValues(el);
    if (!holes) return;
    actionRuns.get(el)?.abort();
    const run = new AbortController();
    actionRuns.set(el, run);
    const body = new URLSearchParams([["_yx", token], ...holes]);
    // A named field sends itself too, like it would in a form.
    const field = el as HTMLInputElement;
    if (field.name && "value" in field && (!/^(checkbox|radio)$/.test(field.type) || field.checked)) body.append(field.name, field.value);
    el.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(new URL(url, el.baseURI).href, {
        method: "POST",
        body,
        headers: { yx: "1", accept: "text/html", "content-type": "application/x-www-form-urlencoded" },
        signal: run.signal,
      });
      if (run.signal.aborted) return;
      const location_ = response.headers.get("yx-location");
      if (location_) {
        await load(location_, true);
        return;
      }
      if (!response.ok) {
        console.error("[yerd]", response.status, (await response.text()) || response.statusText);
        return;
      }
      prefetched.clear();
      if (response.status === 204) await refresh();
      else {
        const text = await response.text();
        if (run.signal.aborted) return;
        if (apply(text) === 0) await refresh();
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") console.error("[yerd]", error);
    } finally {
      if (actionRuns.get(el) === run) {
        actionRuns.delete(el);
        el.removeAttribute("aria-busy");
      }
    }
  }

  /** "250ms" / "5s" in ms, or the fallback. */
  function duration(text: string | undefined, fallback: number): number {
    const match = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(text ?? "");
    return match ? Number(match[1]) * (match[2] === "s" ? 1000 : 1) : fallback;
  }

  /** The token an element's action carries now (a morph may have swapped it). */
  function tokenOf(el: Element): string {
    return el.getAttribute("data-yx-token") ?? el.querySelector<HTMLInputElement>("input[name=_yx]")?.value ?? "";
  }

  const wiredTriggers = new WeakSet<Element>();
  // visible / load fire once per token: a new render (new token) arms them again.
  const firedWith = new WeakMap<Element, string>();
  let visibility: IntersectionObserver | undefined;

  function initTriggers(): void {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-yx-trigger]"))) {
      const [kind = "click", option] = el.getAttribute("data-yx-trigger")!.trim().split(/\s+/);
      if (kind === "visible" || kind === "load") {
        if (firedWith.get(el) === tokenOf(el)) continue;
        if (kind === "load") {
          firedWith.set(el, tokenOf(el));
          void runAction(el);
          continue;
        }
        visibility ??= new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const target = entry.target as HTMLElement;
              visibility!.unobserve(target);
              if (firedWith.get(target) === tokenOf(target)) continue;
              firedWith.set(target, tokenOf(target));
              void runAction(target);
            }
          },
          { rootMargin: "200px" },
        );
        visibility.observe(el);
        continue;
      }
      if (wiredTriggers.has(el)) continue;
      wiredTriggers.add(el);
      if (kind === "every") {
        const period = Math.max(duration(option, 0), 250);
        const timer = setInterval(() => {
          if (!el.isConnected) clearInterval(timer);
          else if (document.visibilityState === "visible" && el.hasAttribute("data-yx-trigger")) void runAction(el);
        }, period);
        continue;
      }
      // An event, maybe "keydown:Enter" (key filter) or "input 250ms" (debounce).
      const [event, key] = kind.split(":") as [string, string | undefined];
      const wait = duration(option, 0);
      let timer: ReturnType<typeof setTimeout> | undefined;
      el.addEventListener(event, (e) => {
        // The trigger may have been morphed away or changed since.
        if (el.getAttribute("data-yx-trigger")?.trim().split(/\s+/)[0] !== kind) return;
        if (key && (e as KeyboardEvent).key !== key) return;
        // A click on a link or a submit button would navigate or submit too.
        if (event === "click" || event === "submit" || key) e.preventDefault();
        clearTimeout(timer);
        if (wait) timer = setTimeout(() => void runAction(el), wait);
        else void runAction(el);
      });
    }
  }
  document.addEventListener("yx:applied", initTriggers);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initTriggers);
  else initTriggers();

  function initLocals(): void {
    for (const el of Array.from(document.querySelectorAll("yerd-local[data-yx-local]"))) {
      let scope = scopes.get(el);
      if (!scope) {
        let state: Record<string, unknown>;
        try {
          state = JSON.parse(el.getAttribute("data-yx-local")!) as Record<string, unknown>;
        } catch {
          continue;
        }
        scope = { el, state, name: el.getAttribute("data-yx-as") || "s" };
        const key = el.getAttribute("data-yx-persist");
        if (key) {
          scope.key = key;
          scope.storage = storageFor(el);
          loadSaved(scope);
          if (!byKey.has(key)) byKey.set(key, new Set());
          byKey.get(key)!.add(scope);
        }
        scopes.set(el, scope);
      }
      // Wire handlers on new elements (a morph may have added some) and
      // re-apply: a morph puts the server's initial values back.
      wire(scope);
      applyBindings(scope);
    }
  }
  document.addEventListener("yx:applied", initLocals);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initLocals);
  else initLocals();

  // Before any attribute connects: client halves receive it.
  const api = { morph, apply, refresh, load, prefetch, fetch: cachedFetch, attribute, auto };
  (window as Window & { yerd?: unknown }).yerd = api;

  // Built in: prefetch. data-yx-prefetch is the mode (intent, visible, load);
  // the URL is data-yx-prefetch-url or the link's href.
  const linkPrefetched = new Set<string>();
  attribute("data-yx-prefetch", (el, mode) => {
    const url = el.getAttribute("data-yx-prefetch-url") ?? el.getAttribute("href");
    if (!url) return;
    const as = el.getAttribute("data-yx-prefetch-as") === "json" ? "json" : "page";
    const go = (): void => {
      // Pages only boosted navigation can use go into the runtime cache;
      // ordinary links get the browser's own prefetch, which a normal
      // navigation picks up.
      if (as === "json" || (el instanceof HTMLAnchorElement ? boostable(el) : el.closest("[data-yx-boost]") !== null)) {
        prefetch(url, as);
        return;
      }
      const href = new URL(url, location.href).href;
      if (linkPrefetched.has(href)) return;
      linkPrefetched.add(href);
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.href = href;
      document.head.appendChild(link);
    };
    if (mode === "load") {
      go();
      return;
    }
    if (mode === "visible") {
      if (typeof IntersectionObserver === "undefined") {
        go();
        return;
      }
      const seen = new IntersectionObserver((entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        seen.disconnect();
        go();
      });
      seen.observe(el);
      return () => seen.disconnect();
    }
    // intent: a short hover (so sweeping the pointer across links doesn't
    // fetch them all), focus, or a touch.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const enter = (): void => {
      clearTimeout(timer);
      timer = setTimeout(go, 65);
    };
    const leave = (): void => clearTimeout(timer);
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("focusin", go);
    el.addEventListener("touchstart", go, { passive: true });
    return () => {
      clearTimeout(timer);
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("focusin", go);
      el.removeEventListener("touchstart", go);
    };
  });

}

let source: string | undefined;

/**
 * The runtime as a script: the function's source in an IIFE. The source must
 * be self-contained, so the runtime has to be compiled at ES2017 or later:
 * older targets turn `async` into calls to a helper defined outside the
 * function, which wouldn't exist in the browser.
 */
export function runtimeSource(): string {
  if (source) return source;
  const fn = yerdRuntime.toString();
  if (/\b__(async|awaiter|generator)\b/.test(fn)) {
    throw new Error("yerd's client runtime was compiled below ES2017 (async was lowered to a helper); compile server code at ES2022");
  }
  return (source = `(${fn})();\n`);
}
