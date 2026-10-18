import { minified } from "./runtime-min.js";

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
 * - [data-yx-error]     inside a form: where error messages from the server go;
 *                       [data-yx-error="field"] takes that field's validation message
 *                       (the field gets aria-invalid, and the first is focused)
 * - style[data-yx-css]  css`` rules sent with the elements that use them: moved
 *                       into <head>, one per class
 * - [data-yx-new]       set on elements a morph inserted (style entrance animations with it)
 * - [data-yx-action]    an action on any element: posted (with its data-yx-token)
 *                       when its data-yx-trigger fires: an event ("click",
 *                       "input 250ms", "keydown:Enter"), "visible", "load", "every 5s"
 * - [data-yx-trigger]   on an action form: submits it on that trigger
 * - [data-yx-holes]     values the server left for the browser: read from the
 *                       element (or ref(selector)) when the action fires, sent as _yxh<n>
 * - trigger "drop"      a drop target for the page's draggable elements ("drop:<selector>":
 *                       only those matching it); the action's drag.* holes read the
 *                       dropped one. "drop:files": files from outside the page, posted
 *                       as multipart "files", filtered by the element's accept. While
 *                       dragging, [data-yx-dragging] marks the dragged element and
 *                       [data-yx-over] the target that would take it
 * - [data-yx-drop-to]   a drop zone that adds dropped files to a file input (by
 *                       selector) for its form to upload; data-yx-files="<n>" while
 *                       the input holds some
 * - [data-yx-append]    on a Region in a response: children are appended, not replaced
 *                       (data-yx-prepend: put first)
 * - #yx-notice          a small status message the runtime shows when an action
 *                       fails with nowhere else to say so (no [data-yx-error]),
 *                       the server can't be reached, or the page was stale and got
 *                       refreshed; a "yx:notice" listener can preventDefault()
 *                       and show it its own way
 * - [data-yx-defer]     a prerendered <Dynamic> skeleton: filled from the server after load
 * - [data-yx-disabled]  set on the buttons a pending submit disabled (and will re-enable)
 * - [data-yx-prefetch]  warm a page or JSON response before it's needed (the `prefetch` prop)
 * - [data-yx-sync]      keep the element's looping CSS animations in step with every
 *                       other page, against the server's clock (/_yerd/clock)
 * - [data-yx-cue]       play when the server plays one of these cues (/_yerd/cues,
 *                       rooms from data-yx-cue-room, or the app's own stream at
 *                       data-yx-cue-from): sets data-yx-cued, plays
 *                       <audio>/<video>, dispatches a cancelable "yx:cue"
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
    // A focused select keeps the user's choice: patching its options' `selected`
    // attributes would otherwise move the selection under them.
    const held = a instanceof HTMLSelectElement && a === document.activeElement ? Array.from(a.options).filter((o) => o.selected) : null;
    morphChildren(a, b);
    if (picked && a instanceof HTMLSelectElement) {
      Array.from(a.options).forEach((option, i) => (option.selected = held ? held.includes(option) : (picked[i] ?? false)));
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
    hoistStyles(doc.querySelectorAll("style[data-yx-css]"));
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
    hoistStyles(doc.querySelectorAll("style[data-yx-css]"));
    morph(document.body, document.importNode(doc.body, true));
    if (doc.title) document.title = doc.title;
  }

  // Every navigation bumps `nav`; responses that arrive for an older one are dropped.
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
  // Pages handed to the browser's own prefetch (<link rel=prefetch>) on this page.
  const linkPrefetched = new Set<string>();

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

  /**
   * Make `html` the page. "push" adds `landed` as a new history entry
   * (remembering where this one was scrolled, for Back) and scrolls to its
   * fragment or the top; "restore" scrolls back to where this entry was
   * (Back/Forward); "keep" stays put (the same page again).
   */
  function swapPage(html: string, landed: URL, how: "push" | "restore" | "keep"): void {
    if (how === "push") {
      history.replaceState({ ...(history.state as object | null), yx: true, scroll: window.scrollY }, "");
      history.pushState({ yx: true }, "", landed.href);
    }
    page = location.pathname + location.search;
    linkPrefetched.clear();
    showPage(html);
    if (how === "restore") {
      const scroll = (history.state as { scroll?: unknown } | null)?.scroll;
      if (typeof scroll === "number") window.scrollTo(0, scroll);
    } else if (how === "push") {
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
  }

  /** Boosted navigation: fetch a page and morph the whole <body> into it (focus and state survive where elements match). */
  async function load(url: string, push: boolean): Promise<void> {
    const target = new URL(url, location.href);
    // Only our own pages are morphed in; anything else is a real navigation.
    // Never to script, though: browsers don't follow a redirect to javascript:,
    // so an app's unchecked redirect target (?next=...) can't become XSS here.
    if (target.origin !== location.origin) {
      if (!/^(javascript|data|vbscript):$/.test(target.protocol)) location.assign(target.href);
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
      // fetch drops the fragment; keep the one that was asked for.
      if (!landed.hash) landed.hash = target.hash;
      swapPage(got.text, landed, push ? "push" : "restore");
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
          refreshLater();
        }
      }
    })();
    return refreshing;
  }

  /** refresh() for callers nobody waits on (a live message, a reconnect): a failure (offline) is logged, not thrown. */
  function refreshLater(): void {
    refresh().catch((error: unknown) => console.error("[yerd] couldn't refresh the page", error));
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

  /**
   * An action submit: an action form, or a formaction={action} button (which
   * carries the action's token as its own name="_yx") in any form.
   */
  function isActionSubmit(form: HTMLFormElement, submitter: HTMLElement | null): boolean {
    return form.hasAttribute("data-yx") || submitter?.getAttribute("name") === "_yx";
  }

  /** Forms aimed at another window, or method=dialog, are the browser's. */
  function intercepts(form: HTMLFormElement, submitter: HTMLElement | null): boolean {
    const target = formAttr(form, submitter, "target");
    if (target && target.toLowerCase() !== "_self") return false;
    return (formAttr(form, submitter, "method") ?? "").toLowerCase() !== "dialog";
  }

  let noticeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Tell the user something went wrong when there's no [data-yx-error] to say it in. */
  function notify(message: string): void {
    if (!document.dispatchEvent(new CustomEvent("yx:notice", { detail: { message }, cancelable: true }))) return;
    let box = document.getElementById("yx-notice");
    if (!box) {
      box = document.createElement("div");
      box.id = "yx-notice";
      box.setAttribute("role", "status");
      box.setAttribute("aria-live", "polite");
      box.style.cssText =
        "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;max-width:min(90vw,32rem);" +
        "padding:10px 14px;border-radius:8px;background:#1f1f1f;color:#fff;font:14px/1.4 system-ui,sans-serif;" +
        "box-shadow:0 4px 16px rgba(0,0,0,.25)";
    }
    box.textContent = message;
    document.body.appendChild(box);
    clearTimeout(noticeTimer);
    const shown = box;
    noticeTimer = setTimeout(() => shown.remove(), 5000);
  }

  type Issue = { path: string; message: string };

  /** A failed action's message and validation issues (a JSON error body), or its text. */
  async function readFailure(response: Response): Promise<{ message: string; issues: Issue[] }> {
    const text = (await response.text()) || response.statusText;
    if ((response.headers.get("content-type") ?? "").includes("json")) {
      try {
        const data = JSON.parse(text) as { error?: string; issues?: Issue[] };
        const issues = Array.isArray(data.issues) ? data.issues : [];
        return { message: issues.length ? issues.map((i) => i.message).join(". ") : (data.error ?? text), issues };
      } catch {
        // not JSON after all; show it as text
      }
    }
    return { message: text, issues: [] };
  }

  /**
   * Put each validation issue by its field: in [data-yx-error="<field>"] when
   * the form has one, and the field gets aria-invalid (the first is focused).
   * Returns the messages left for the form's own box, each labelled with its
   * field (the field's <label>, or its name).
   */
  function showIssues(form: HTMLFormElement, issues: Issue[]): string[] {
    const left: string[] = [];
    let first: HTMLElement | undefined;
    const boxes = Array.from(form.querySelectorAll<HTMLElement>("[data-yx-error]"));
    for (const { path, message } of issues) {
      // An issue about the whole form ("(root)", or no path) goes in the form's own box, with the rest.
      const fieldPath = path && path !== "(root)" ? path : "";
      // An item of a list ("photos[0]", "tags[1]") belongs to its field ("photos") when there's nothing for the item itself.
      const owner = fieldPath.replace(/(\[\d+\])+$/, "");
      const lookup = (name: string) => (name ? form.elements.namedItem(name) : null);
      const named = lookup(fieldPath) ?? lookup(owner);
      const field = named instanceof RadioNodeList ? (named[0] as HTMLElement | undefined) : (named as HTMLElement | null);
      if (field) {
        field.setAttribute("aria-invalid", "true");
        field.setAttribute("data-yx-invalid", "");
        first ??= field;
      }
      const box = fieldPath
        ? (boxes.find((b) => b.getAttribute("data-yx-error") === fieldPath) ?? boxes.find((b) => owner !== fieldPath && b.getAttribute("data-yx-error") === owner))
        : undefined;
      if (box) {
        box.textContent = message;
        continue;
      }
      // "What needs doing?" or "Email *" reads better without its trailing marks.
      const label = (field as HTMLInputElement | null)?.labels?.[0]?.textContent?.trim().replace(/[\s?:*]+$/, "");
      left.push(fieldPath ? `${label || owner}: ${message}` : message);
    }
    first?.focus();
    return left;
  }

  /** Clear what showIssues() put on a form. */
  function clearIssues(form: HTMLFormElement): void {
    for (const box of Array.from(form.querySelectorAll<HTMLElement>("[data-yx-error]"))) if (box.getAttribute("data-yx-error")) box.textContent = "";
    for (const field of Array.from(form.querySelectorAll("[data-yx-invalid]"))) {
      field.removeAttribute("aria-invalid");
      field.removeAttribute("data-yx-invalid");
    }
  }

  const STALE = "This page was out of date, so it's been refreshed. Please try again.";
  const OFFLINE = "Couldn't reach the server. Please try again in a moment.";

  /**
   * The server no longer accepts this page's actions (it restarted with a new
   * secret, was redeployed, or the token expired): fetch the page fresh, with
   * new tokens, and say so. The action didn't run, so trying again is safe.
   */
  async function recoverStale(errorBox: HTMLElement | null): Promise<void> {
    prefetched.clear();
    await load(location.href, false);
    if (errorBox?.isConnected) errorBox.textContent = STALE;
    else notify(STALE);
  }

  /**
   * What an action's response means, for a form and an element action alike:
   * yx-location navigates there, yx-stale fetches the page fresh, a failure
   * is shown (by its fields, for a form), and anything else is applied: the
   * Regions in it, or a refresh when there are none (a 204, or no match).
   * A plain form (auto mode; `plain` is the URL it posted to) shows whatever
   * page the server landed on. True once the response's changes are on the page.
   */
  async function handleActionResponse(
    response: Response,
    { errorBox, form, signal, plain }: { errorBox: HTMLElement | null; form?: HTMLFormElement; signal?: AbortSignal; plain?: URL },
  ): Promise<boolean> {
    // A newer run of the same action took over.
    if (signal?.aborted) return false;
    // An action can change any page (signing in changes them all): nothing fetched before it is current.
    prefetched.clear();
    const location_ = response.headers.get("yx-location");
    if (location_) {
      await load(location_, true);
      return false;
    }
    if (response.headers.get("yx-stale")) {
      await recoverStale(errorBox);
      return false;
    }
    // Whatever page the server answered with, after following its
    // redirects, is the new page, errors included.
    if (plain && (response.headers.get("content-type") ?? "").includes("text/html")) {
      const html = await response.text();
      const landed = new URL(response.url || plain.href);
      const moved = landed.pathname + landed.search !== location.pathname + location.search;
      swapPage(html, landed, moved ? "push" : "keep");
      return false;
    }
    if (!response.ok) {
      const { message, issues } = await readFailure(response);
      const rest = form && issues.length ? showIssues(form, issues) : [message];
      // The box is emptied too when every issue went to a field's own box,
      // so an earlier submit's message doesn't linger beside the new ones.
      if (errorBox) errorBox.textContent = rest.join(". ");
      else if (rest.length) notify(rest.join(". "));
      return false;
    }
    if (errorBox) errorBox.textContent = "";
    if (response.status === 204) await refresh();
    else {
      const text = await response.text();
      if (signal?.aborted) return false;
      if (apply(text) === 0) await refresh();
    }
    return true;
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
    const plain = !isActionSubmit(form, submitter);
    const headers: Record<string, string> = plain ? { accept: "text/html" } : { yx: "1", accept: "text/html" };
    if (!multipart) headers["content-type"] = "application/x-www-form-urlencoded";
    // The form's own message box: [data-yx-error] with no field name.
    const errorBox = Array.from(form.querySelectorAll<HTMLElement>("[data-yx-error]")).find((box) => !box.getAttribute("data-yx-error")) ?? null;
    clearIssues(form);
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
      if (!(await handleActionResponse(response, { errorBox, form, plain: plain ? url : undefined }))) return;
      if (form.hasAttribute("data-yx-reset") && form.isConnected) {
        HTMLFormElement.prototype.reset.call(form);
        form.querySelector<HTMLElement>("[autofocus]")?.focus();
      }
      // A form inside a <details> (inline editors, menus) closes once it's done.
      form.closest("details")?.removeAttribute("open");
    } catch (error) {
      if (errorBox) errorBox.textContent = OFFLINE;
      else notify(OFFLINE);
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
    if (!isActionSubmit(form, submitter)) {
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

  // Back/Forward can restore a page from the browser's memory as it was when
  // left: before a sign-in, an order, a delete. Fetch it fresh instead.
  window.addEventListener("pageshow", (event) => {
    if ((event as PageTransitionEvent).persisted) {
      prefetched.clear();
      void load(location.href, false);
    }
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

  // Work that follows the page: run once it's parsed, then again after every
  // change the runtime makes (yx:applied: an apply, a boost, a refresh). One
  // query finds every hook's elements, rather than one query per hook.
  type PageHook = { selector: string; run(found: Element[]): void };
  const hooks: PageHook[] = [];
  function onPage(selector: string, run: (found: Element[]) => void): void {
    hooks.push({ selector, run });
  }
  function scanPage(): void {
    const found = hooks.map((): Element[] => []);
    for (const el of Array.from(document.querySelectorAll(hooks.map((hook) => hook.selector).join(",")))) {
      hooks.forEach((hook, i) => {
        if (el.matches(hook.selector)) found[i]!.push(el);
      });
    }
    hooks.forEach((hook, i) => hook.run(found[i]!));
  }

  // Prerendered pages ship skeletons ([data-yx-defer]) for their <Dynamic>
  // parts; fetch the real content in one request and morph it in. This runs
  // after every load and apply, so skeletons a morph brings back (Back, a
  // refresh) are filled again. A part the server answers with its skeleton
  // again isn't asked for again until the next navigation, and a fill's own
  // apply never starts another.
  const stuck = new WeakMap<Element, number>();
  let filling = -1;
  let ownFill = false;
  async function fillDeferred(skeletons: Element[]): Promise<void> {
    if (ownFill) return;
    const seq = nav;
    const parts = skeletons.filter((el) => stuck.get(el) !== seq);
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
  onPage("[data-yx-defer]", (skeletons) => void fillDeferred(skeletons));

  type Stream = { close(): void };

  /**
   * An EventSource that keeps coming back. The browser retries a dropped
   * connection itself; one it gave up on (CLOSED: a restarting server, a
   * refused room) is reopened here, backing off from 1s to 30s, and the
   * backoff starts over once a connection opens. `reconnected` runs when a
   * connection opens after one was lost: messages may have been missed.
   */
  function stream(url: string, onMessage: (event: MessageEvent<string>) => void, reconnected?: () => void): Stream {
    let delay = 1000;
    let lost = false;
    let closed = false;
    let source: EventSource;
    const open = (): void => {
      const current = (source = new EventSource(url));
      current.onmessage = onMessage;
      current.onopen = () => {
        delay = 1000;
        if (lost) reconnected?.();
        lost = false;
      };
      current.onerror = () => {
        lost = true;
        // CLOSED (2): the browser won't retry this one itself.
        if (current.readyState !== 2) return;
        setTimeout(() => {
          if (!closed && source === current) open();
        }, delay);
        delay = Math.min(delay * 2, 30000);
      };
    };
    open();
    return {
      close() {
        closed = true;
        source.close();
      },
    };
  }

  /** Close the streams no longer wanted and open the ones newly wanted, keeping the rest. */
  function reconcile(streams: Map<string, Stream>, wanted: Set<string>, open: (url: string) => Stream): void {
    for (const [url, current] of Array.from(streams)) {
      if (wanted.has(url)) continue;
      current.close();
      streams.delete(url);
    }
    for (const url of wanted) if (!streams.has(url)) streams.set(url, open(url));
  }

  // One stream per live URL on the page, closed when its elements are gone.
  // Every message refreshes the page's Regions, and so does a connection
  // coming back, since messages may have been missed.
  const live = new Map<string, Stream>();
  onPage("[data-yx-live]", (found) => {
    const urls = new Set(found.map((el) => el.getAttribute("data-yx-live")!));
    reconcile(live, urls, (url) =>
      stream(
        url,
        () => {
          prefetched.clear();
          refreshLater();
        },
        refreshLater,
      ),
    );
  });

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

  // "[a],[b],...": every registered attribute in one selector, so a scan is one query.
  let attrSelector = "";

  /** Connect what `root` and its descendants carry of `names` (every registered attribute by default). */
  function scanAttrs(root: Element, names: Iterable<string> = setups.keys(), selector = attrSelector): void {
    if (!selector) return;
    const list = Array.from(names);
    const found = Array.from(root.querySelectorAll(selector));
    if (root.matches(selector)) found.unshift(root);
    for (const el of found) for (const name of list) if (el.hasAttribute(name)) connectAttr(el, name);
  }

  function onMutations(records: MutationRecord[]): void {
    let removed = false;
    const added = new Set<Element>();
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
        for (const node of Array.from(record.addedNodes)) if (node.nodeType === 1) added.add(node as Element);
        if (record.removedNodes.length > 0) removed = true;
      }
    }
    for (const root of added) {
      // Inside another added element: searched with it.
      let up = root.parentElement;
      while (up && !added.has(up)) up = up.parentElement;
      if (!up) scanAttrs(root);
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

  function observe(): void {
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
  }

  // While the runtime script runs (the built-ins, then the app's client
  // halves appended to it), registrations only queue: one observe and one
  // scan of the page cover them all, in a microtask, before the parser
  // moves on. After that, each registration connects what's already there.
  let booting = true;
  queueMicrotask(() => {
    booting = false;
    observe();
    scanAttrs(document.documentElement);
  });

  function attribute(name: string, setup: Setup): void {
    setups.set(name, setup);
    attrSelector = Array.from(setups.keys(), (key) => `[${key}]`).join(",");
    if (booting) return;
    observe();
    scanAttrs(document.documentElement, [name], `[${name}]`);
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
  // The handler attributes each element has a listener for.
  const wired = new WeakMap<Element, Set<string>>();
  // Persisted scopes by storage key, so scopes sharing a key stay in step.
  // Scopes that left the page are pruned, so a boosted session doesn't keep them.
  const byKey = new Map<string, Set<Scope>>();
  const STORE_PREFIX = "yerd-local:";

  /** Saved state to merge: an object, or undefined for anything else (a string would spread its characters). */
  function savedState(text: string): Record<string, unknown> | undefined {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  }

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
      if (saved) Object.assign(scope.state, savedState(saved));
    } catch {
      // unreadable or blocked: keep the server's defaults
    }
  }

  /** A key's scopes still on the page; the others are dropped (and the key, once none are left). */
  function prune(key: string): Set<Scope> | undefined {
    const group = byKey.get(key);
    if (!group) return undefined;
    for (const scope of group) if (!scope.el.isConnected) group.delete(scope);
    if (group.size === 0) byKey.delete(key);
    return group;
  }

  /** Save a persisted scope and bring the others with its key (in this tab) up to date. */
  function save(scope: Scope): void {
    if (!scope.key || !scope.storage) return;
    let json: string;
    try {
      json = JSON.stringify(scope.state);
      scope.storage.setItem(STORE_PREFIX + scope.key, json);
    } catch {
      // full or blocked (or state that isn't JSON): the page still works
      return;
    }
    for (const other of prune(scope.key) ?? []) {
      if (other === scope || other.storage !== scope.storage) continue;
      Object.assign(other.state, JSON.parse(json));
      applyBindings(other);
    }
  }

  // Persisted scopes changed since their last save. Storage is written once
  // per frame at most, however many handlers ran (a drag, a burst of input),
  // and before the page goes away.
  const unsaved = new Set<Scope>();
  function saveAll(): void {
    for (const scope of Array.from(unsaved)) {
      unsaved.delete(scope);
      save(scope);
    }
  }
  window.addEventListener("pagehide", saveAll);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveAll();
  });

  /** A handler ran: show the state now, and save it soon. */
  function changed(scope: Scope): void {
    applyBindings(scope);
    if (!scope.key || !scope.storage) return;
    if (unsaved.size === 0) requestAnimationFrame(saveAll);
    unsaved.add(scope);
  }

  // Another tab saved: follow it.
  window.addEventListener("storage", (event) => {
    if (!event.key?.startsWith(STORE_PREFIX) || event.newValue === null) return;
    for (const scope of prune(event.key.slice(STORE_PREFIX.length)) ?? []) {
      if (scope.storage !== event.storageArea) continue;
      try {
        Object.assign(scope.state, savedState(event.newValue));
      } catch {
        continue;
      }
      applyBindings(scope);
    }
  });

  /** A binding's value: `[!]path`, or `[!]path=<JSON>` for "field equals this" (eq()). */
  function read(state: unknown, spec: string): unknown {
    const negate = spec.startsWith("!");
    const at = spec.indexOf("=");
    const path = spec.slice(negate ? 1 : 0, at < 0 ? undefined : at);
    let value: unknown = state;
    for (const key of path.split(".")) {
      if (key === "") continue;
      value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    }
    if (at >= 0) {
      let expected: unknown;
      try {
        expected = JSON.parse(decodeURIComponent(spec.slice(at + 1)));
      } catch {
        expected = undefined;
      }
      value = value === expected;
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
        // The last colon: names can have their own (class.md:block,
        // xlink:href), specs can't (an eq() value is URI-encoded).
        const at = entry.lastIndexOf(":");
        if (at < 0) continue;
        const name = entry.slice(0, at);
        const value = read(scope.state, entry.slice(at + 1));
        if (name.startsWith("class.")) el.classList.toggle(name.slice(6), Boolean(value));
        else if (name === "value") (el as HTMLInputElement).value = value === null || value === undefined ? "" : String(value);
        else if (name === "checked") (el as HTMLInputElement).checked = Boolean(value);
        // Like the server renders them: aria-* and the enumerated attributes
        // take the words ("true" / "false", translate "yes" / "no", autocorrect "on" / "off"), not presence.
        else if (typeof value === "boolean" && (name.startsWith("aria-") || name === "draggable" || name === "spellcheck" || name === "contenteditable" || name === "writingsuggestions")) el.setAttribute(name, String(value));
        else if (typeof value === "boolean" && name === "translate") el.setAttribute(name, value ? "yes" : "no");
        else if (typeof value === "boolean" && name === "autocorrect") el.setAttribute(name, value ? "on" : "off");
        else if (value === false || value === null || value === undefined) el.removeAttribute(name);
        else el.setAttribute(name, value === true ? "" : String(value));
      }
    }
  }

  function compile(scope: Scope, source: string): ((event: Event) => unknown) | undefined {
    try {
      return new Function(scope.name, `"use strict"; return (${source});`)(scope.state) as (event: Event) => unknown;
    } catch (error) {
      console.error("[yerd] a <Local> handler didn't compile:", source, error);
      return undefined;
    }
  }

  /**
   * One listener per element and handler attribute. It runs the attribute as
   * it is now: a morph that changes a handler's source gets it recompiled, one
   * that removes it silences it, and one that adds a handler gets a listener.
   */
  function wire(scope: Scope, el: Element, names: string[]): void {
    const done = wired.get(el) ?? new Set<string>();
    wired.set(el, done);
    for (const name of names) {
      if (done.has(name)) continue;
      done.add(name);
      let source = el.getAttribute(name)!;
      let fn = compile(scope, source);
      el.addEventListener(name.slice("data-yx-on-".length), (event) => {
        const now = el.getAttribute(name);
        if (now === null) return;
        if (now !== source) {
          source = now;
          fn = compile(scope, now);
        }
        if (!fn) return;
        let result: unknown;
        try {
          result = fn(event);
        } finally {
          changed(scope);
        }
        if (result && typeof (result as Promise<unknown>).then === "function") {
          const after = () => changed(scope);
          void (result as Promise<unknown>).then(after, after);
        }
      });
    }
  }

  // Elements that arrived in a scope, or got a new handler attribute, since
  // they were last looked at: only these are searched for handlers to wire,
  // not every element of every scope after each change to the page.
  const touched = new Set<Element>();
  function collect(records: MutationRecord[]): void {
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.attributeName!.startsWith("data-yx-on-")) touched.add(record.target as Element);
      } else for (const node of Array.from(record.addedNodes)) if (node.nodeType === 1) touched.add(node as Element);
    }
  }
  const localWatch = new MutationObserver((records) => {
    collect(records);
    wireTouched();
  });

  /** Wire the handlers on touched elements and their descendants, each to the scope it belongs to. */
  function wireTouched(): void {
    const roots = new Set(touched);
    touched.clear();
    for (const root of roots) {
      if (!root.isConnected) continue;
      // Inside another root: walked with it.
      let up = root.parentElement;
      while (up && !roots.has(up)) up = up.parentElement;
      if (up) continue;
      for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
        const names = Array.from(el.attributes, (a) => a.name).filter((name) => name.startsWith("data-yx-on-"));
        if (names.length === 0) continue;
        const host = el.closest("yerd-local");
        const scope = host ? scopes.get(host) : undefined;
        if (scope) wire(scope, el, names);
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
      if (path[0] === "drag") {
        source = dragged;
        if (!source) return undefined;
      }
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

  // ── drag and drop ──
  //
  // Drop targets are elements whose trigger is "drop" (the page's draggable
  // elements), "drop:<selector>" (only draggables matching it) or
  // "drop:files" (files from outside the page, filtered by its accept
  // attribute). Drops are handled here, centrally: the innermost target that
  // accepts what's being dragged gets it.

  let dragged: HTMLElement | null = null;

  /** The page element being dragged, if it's still on the page. */
  function dragSource(): HTMLElement | null {
    if (dragged && !dragged.isConnected) dragged = null;
    return dragged;
  }

  // dragover fires on every pointer move, so a drag remembers what it looked
  // up: the target it marked [data-yx-over] (touched only when that changes),
  // whether the page takes files anywhere, and each target's accept list.
  // Forgotten when the drag ends, leaves the window, or a new one comes in.
  let over: Element | null = null;
  let fileTargets: boolean | undefined;
  const accepted = new Map<Element, string | null>();

  function setOver(target: Element | null): void {
    if (over && over !== target) over.removeAttribute("data-yx-over");
    over = target;
    // Again if a morph took it off meanwhile.
    if (target && !target.hasAttribute("data-yx-over")) target.setAttribute("data-yx-over", "");
  }

  function forgetDrag(): void {
    fileTargets = undefined;
    accepted.clear();
  }

  function endDrag(): void {
    dragged?.removeAttribute("data-yx-dragging");
    dragged = null;
    setOver(null);
    forgetDrag();
  }

  const DROP_TARGETS = '[data-yx-trigger^="drop"], [data-yx-drop-to]';

  /** What a drop target takes: "page" (any draggable), a selector, or "files". */
  function dropKind(target: Element): string {
    if (target.hasAttribute("data-yx-drop-to")) return "files";
    const spec = (target.getAttribute("data-yx-trigger") ?? "").trim();
    return spec === "drop" ? "page" : spec.slice(5).trim() || "page";
  }

  function carriesFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes("Files");
  }

  /** Whether a file (or, while dragging, its item's MIME type) fits an accept list like "image/*,.pdf". */
  function fits(accept: string | null, type: string, name?: string): boolean {
    if (!accept) return true;
    return accept.split(",").some((raw) => {
      const rule = raw.trim().toLowerCase();
      if (!rule) return false;
      if (rule.startsWith(".")) return name === undefined || name.toLowerCase().endsWith(rule);
      if (rule.endsWith("/*")) return type.toLowerCase().startsWith(rule.slice(0, -1));
      return type.toLowerCase() === rule;
    });
  }

  function accepts(target: Element, event: DragEvent): boolean {
    const kind = dropKind(target);
    const source = dragSource();
    if (source) {
      if (kind === "files") return false;
      // Not onto itself, or into something it contains.
      if (source === target || source.contains(target)) return false;
      if (kind !== "page") {
        try {
          return source.matches(kind);
        } catch {
          return false;
        }
      }
      return true;
    }
    if (kind !== "files" || !carriesFiles(event)) return false;
    // While dragging, only types are known (and not in every browser): refuse only a clear mismatch.
    const accept = acceptOf(target);
    const items = Array.from(event.dataTransfer?.items ?? []).filter((item) => item.kind === "file");
    return items.length === 0 || items.some((item) => !item.type || fits(accept, item.type));
  }

  /** The innermost drop target that accepts this drag. */
  function dropTarget(event: DragEvent): HTMLElement | null {
    let target = (event.target as Element).closest?.<HTMLElement>(DROP_TARGETS) ?? null;
    while (target && !accepts(target, event)) target = target.parentElement?.closest<HTMLElement>(DROP_TARGETS) ?? null;
    return target;
  }

  /** Files dropped from outside, minus folders and what `accept` refuses. */
  function droppedFiles(target: Element, event: DragEvent): { files: File[]; refused: number } {
    const transfer = event.dataTransfer;
    if (!transfer) return { files: [], refused: 0 };
    const items = Array.from(transfer.items ?? []).filter((item) => item.kind === "file");
    const all: File[] = [];
    if (items.length) {
      for (const item of items) {
        // A dropped folder shows up as a file with no type and no size; skip it.
        const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory: boolean } | null }).webkitGetAsEntry?.();
        if (entry?.isDirectory) continue;
        const file = item.getAsFile();
        if (file) all.push(file);
      }
    } else all.push(...Array.from(transfer.files ?? []));
    const accept = acceptOf(target);
    const files = all.filter((file) => fits(accept, file.type, file.name));
    return { files, refused: all.length - files.length };
  }

  /** Is there anywhere on the page files may be dropped? Then a missed drop mustn't open the file. */
  function hasFileTargets(): boolean {
    fileTargets ??= document.querySelector('[data-yx-trigger^="drop:files"], [data-yx-drop-to]') !== null;
    return fileTargets;
  }

  /** The file input a dropTo zone fills. */
  function stagingInput(zone: Element): HTMLInputElement | null {
    const selector = zone.getAttribute("data-yx-drop-to");
    let input: Element | null = null;
    try {
      input = selector ? document.querySelector(selector) : null;
    } catch {
      // not a valid selector
    }
    return input instanceof HTMLInputElement && input.type === "file" ? input : null;
  }

  /** What a zone takes: its own accept, or (for dropTo) its input's. */
  function acceptOf(target: Element): string | null {
    if (!accepted.has(target)) accepted.set(target, target.getAttribute("accept") ?? stagingInput(target)?.getAttribute("accept") ?? null);
    return accepted.get(target)!;
  }

  /** Show how many files a zone's input holds: data-yx-files, or none. */
  function countStaged(input: HTMLInputElement): void {
    for (const zone of Array.from(document.querySelectorAll("[data-yx-drop-to]"))) {
      if (stagingInput(zone) !== input) continue;
      const count = input.files?.length ?? 0;
      if (count) zone.setAttribute("data-yx-files", String(count));
      else zone.removeAttribute("data-yx-files");
    }
  }

  /** Add dropped files to a dropTo zone's input (the same file twice counts once). */
  function stage(zone: Element, files: File[]): void {
    const input = stagingInput(zone);
    if (!input) {
      console.error(`[yerd] dropTo=${JSON.stringify(zone.getAttribute("data-yx-drop-to"))} isn't a file input on the page`);
      return;
    }
    const transfer = new DataTransfer();
    const seen = new Set<string>();
    const add = (file: File) => {
      const id = `${file.name}:${file.size}:${file.lastModified}`;
      if (seen.has(id)) return;
      seen.add(id);
      transfer.items.add(file);
    };
    if (input.multiple) for (const file of Array.from(input.files ?? [])) add(file);
    for (const file of input.multiple ? files : files.slice(0, 1)) add(file);
    if (!input.multiple && files.length > 1) notify("Only one file goes here; kept the first.");
    input.files = transfer.files;
    // As if the user had picked them: listeners (and triggers) on the input see it.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  document.addEventListener("change", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.type === "file") countStaged(input);
  });
  document.addEventListener("reset", (event) => {
    // After the reset has cleared the inputs.
    const form = event.target as HTMLFormElement;
    setTimeout(() => {
      for (const input of Array.from(form.querySelectorAll<HTMLInputElement>("input[type=file]"))) countStaged(input);
    }, 0);
  });

  document.addEventListener("dragstart", (event) => {
    endDrag();
    const source = (event.target as Element).closest?.<HTMLElement>("[draggable=true]");
    if (!source) return;
    dragged = source;
    source.setAttribute("data-yx-dragging", "");
    if (event.dataTransfer) {
      // Firefox won't start a drag without data.
      event.dataTransfer.setData("text/plain", source.dataset.id ?? source.id ?? "");
      event.dataTransfer.effectAllowed = "move";
    }
  });
  // Fired on the source element, so a morph that removes it mid-drag can swallow it: drop cleans up too.
  document.addEventListener("dragend", endDrag);

  document.addEventListener("dragover", (event) => {
    const target = dropTarget(event);
    if (!target) {
      setOver(null);
      if (!dragSource() && carriesFiles(event) && hasFileTargets()) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
      }
      return;
    }
    // Allowing the drop is what makes the browser fire "drop" at all.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = dragSource() ? "move" : "copy";
    setOver(target);
  });

  // Coming in from outside the window: a new drag (files from the desktop), with nothing remembered.
  document.addEventListener("dragenter", (event) => {
    if (!event.relatedTarget) forgetDrag();
  });

  document.addEventListener("dragleave", (event) => {
    // Leaving the window altogether (to the desktop, another app).
    if (!event.relatedTarget && (event.clientX <= 0 || event.clientY <= 0 || event.clientX >= innerWidth || event.clientY >= innerHeight)) {
      setOver(null);
      forgetDrag();
    }
  });

  document.addEventListener("drop", (event) => {
    const target = dropTarget(event);
    if (!target) {
      // A missed file drop would navigate to the file: not while the page takes files somewhere.
      if (!dragSource() && carriesFiles(event) && hasFileTargets()) event.preventDefault();
      endDrag();
      return;
    }
    event.preventDefault();
    setOver(null);
    if (dragSource()) {
      void runAction(target);
      endDrag();
      return;
    }
    const { files, refused } = droppedFiles(target, event);
    endDrag();
    if (refused && !files.length) {
      notify("Those files can't be dropped here.");
      return;
    }
    if (refused) notify(`${refused} file${refused === 1 ? "" : "s"} skipped: not a type this takes.`);
    if (!files.length) return;
    if (target.hasAttribute("data-yx-drop-to")) stage(target, files);
    else void runAction(target, files);
  });

  /** Post an element's action (a newer run cancels an older one: typeahead), then apply the result like a form's. */
  async function runAction(el: HTMLElement, files?: File[]): Promise<void> {
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
    // Dropped files go up as multipart, under "files" (form.files("files") in the action).
    const body = files ? new FormData() : new URLSearchParams();
    body.append("_yx", token);
    for (const [name, value] of holes) body.append(name, value);
    for (const file of files ?? []) (body as FormData).append("files", file, file.name);
    // A named field sends itself too, like it would in a form.
    const field = el as HTMLInputElement;
    if (field.name && "value" in field && (!/^(checkbox|radio)$/.test(field.type) || field.checked)) body.append(field.name, field.value);
    el.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(new URL(url, el.baseURI).href, {
        method: "POST",
        body,
        // fetch sets multipart's boundary itself.
        headers: files ? { yx: "1", accept: "text/html" } : { yx: "1", accept: "text/html", "content-type": "application/x-www-form-urlencoded" },
        signal: run.signal,
      });
      await handleActionResponse(response, { errorBox: null, signal: run.signal });
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      notify(OFFLINE);
      console.error("[yerd]", error);
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

  // The trigger specs each element has been wired for: when a morph changes an
  // element's trigger ("every 5s" to "click", a new debounce), the new one is
  // wired and the old one goes quiet (it checks the spec is still current).
  const wiredTriggers = new WeakMap<Element, Set<string>>();
  // visible / load fire once per token: a new render (new token) arms them again.
  const firedWith = new WeakMap<Element, string>();
  let visibility: IntersectionObserver | undefined;

  /** An element's trigger as written now, with its whitespace normalized. */
  function triggerOf(el: Element): string | undefined {
    return el.getAttribute("data-yx-trigger")?.trim().split(/\s+/).join(" ");
  }

  /** Events an action trigger has already answered, so a trigger further up leaves them alone. */
  const triggered = new WeakSet<Event>();

  function initTriggers(found: Element[]): void {
    for (const el of found as HTMLElement[]) {
      const spec = triggerOf(el)!;
      const [kind = "click", option] = spec.split(" ");
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
      // Drops are handled centrally (see drag and drop).
      if (kind === "drop" || kind.startsWith("drop:")) continue;
      const wired = wiredTriggers.get(el) ?? new Set<string>();
      wiredTriggers.set(el, wired);
      if (wired.has(spec)) continue;
      wired.add(spec);
      if (kind === "every") {
        const period = Math.max(duration(option, 0), 250);
        const timer = setInterval(() => {
          if (!el.isConnected || triggerOf(el) !== spec) {
            clearInterval(timer);
            wired.delete(spec);
          } else if (document.visibilityState === "visible") void runAction(el);
        }, period);
        continue;
      }
      // An event, maybe "keydown:Enter" (key filter) or "input 250ms" (debounce).
      const [event, key] = kind.split(":") as [string, string | undefined];
      const wait = duration(option, 0);
      let timer: ReturnType<typeof setTimeout> | undefined;
      el.addEventListener(event, (e) => {
        // The trigger may have been morphed away or changed since.
        if (triggerOf(el) !== spec) return;
        if (key && (e as KeyboardEvent).key !== key) return;
        // The innermost action wins: a button's click doesn't also fire its card's.
        // Marked rather than stopped, so the event still bubbles on to everyone else
        // (the runtime's own listeners, the app's).
        if (triggered.has(e)) return;
        triggered.add(e);
        // A click on a link or a submit button would navigate or submit too.
        if (event === "click" || event === "submit" || key) e.preventDefault();
        clearTimeout(timer);
        if (wait) timer = setTimeout(() => void runAction(el), wait);
        else void runAction(el);
      });
    }
  }
  onPage("[data-yx-trigger]", initTriggers);

  // css`` rules arrive in <style data-yx-css> next to the first element that
  // uses them (in an action's response too). Keep one of each, in <head>, so
  // they outlive the element they came with and a morph can't drop them.
  // apply() and showPage() take them out of a response before morphing (some
  // sit outside every Region, before a class on the Region's own element, or
  // in the new page's <head>, before a class on <body>); the page hook picks
  // up the rest (the first page, markup put in by hand).
  function hoistStyles(styles: Iterable<Element>): void {
    const kept = new Set(Array.from(document.head.querySelectorAll("style[data-yx-css]"), (style) => style.getAttribute("data-yx-css")));
    for (const style of Array.from(styles)) {
      const name = style.getAttribute("data-yx-css");
      if (kept.has(name)) style.remove();
      else {
        kept.add(name);
        document.head.appendChild(style);
      }
    }
  }
  onPage("body style[data-yx-css]", (strays) => {
    if (strays.length) hoistStyles(strays);
  });

  /** Put a persisted scope in its key's group (again, if it was pruned while off the page). */
  function join(scope: Scope): void {
    if (!scope.key) return;
    if (!byKey.has(scope.key)) byKey.set(scope.key, new Set());
    byKey.get(scope.key)!.add(scope);
  }

  function initLocals(found: Element[]): void {
    // Saves still waiting go first: a scope arriving with the same key reads them.
    saveAll();
    for (const key of Array.from(byKey.keys())) prune(key);
    collect(localWatch.takeRecords());
    const live: Scope[] = [];
    for (const el of found) {
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
        }
        scopes.set(el, scope);
        // From now on, only what changes inside it needs looking at.
        localWatch.observe(el, { subtree: true, childList: true, attributes: true });
        touched.add(el);
      }
      join(scope);
      live.push(scope);
    }
    // Wire handlers on new elements (a morph may have added some) and
    // re-apply: a morph puts the server's initial values back.
    wireTouched();
    for (const scope of live) applyBindings(scope);
  }
  onPage("yerd-local[data-yx-local]", initLocals);

  // ── server clock ──
  // `sync` animations and cues are timed on the server's clock. How far this
  // page's clock is from it is measured against /_yerd/clock: a few round
  // trips, keeping the quickest (its midpoint is the best guess at when the
  // server read its clock). Measured on first use, then every few minutes
  // and whenever the tab comes back into view.
  const clock = { offset: 0, rtt: Infinity, ready: undefined as Promise<void> | undefined };
  const localNow = (): number => performance.timeOrigin + performance.now();
  const serverNow = (): number => localNow() + clock.offset;
  async function measureClock(): Promise<void> {
    let best: { offset: number; rtt: number } | undefined;
    for (let i = 0; i < 4; i++) {
      try {
        const t0 = localNow();
        const response = await fetch("/_yerd/clock", { cache: "no-store" });
        const t1 = localNow();
        const now = ((await response.json()) as { now?: unknown }).now;
        if (typeof now !== "number" || !Number.isFinite(now)) break;
        if (!best || t1 - t0 < best.rtt) best = { offset: now - (t0 + t1) / 2, rtt: t1 - t0 };
      } catch {
        break;
      }
    }
    if (!best) return;
    const first = clock.rtt === Infinity;
    const moved = Math.abs(best.offset - clock.offset);
    clock.offset = best.offset;
    clock.rtt = best.rtt;
    // A re-measure that lands within a few ms isn't worth a visible jump.
    if (first || moved > 8) document.dispatchEvent(new CustomEvent("yx:clock", { detail: { offset: clock.offset, rtt: clock.rtt } }));
  }
  function clockReady(): Promise<void> {
    if (!clock.ready) {
      clock.ready = measureClock();
      const again = () => {
        if (document.visibilityState === "visible") void measureClock();
      };
      setInterval(again, 300000);
      document.addEventListener("visibilitychange", again);
    }
    return clock.ready;
  }
  /** The server's clock: measured once, then shared by `sync`, cues and yerd.clock.sync(). */
  function serverClock(): Promise<{ now: number; offset: number; rtt: number }> {
    return clockReady().then(() => ({ now: serverNow(), offset: clock.offset, rtt: clock.rtt }));
  }

  // Before any attribute connects: client halves receive it.
  const api = {
    page: { refresh, load, apply, morph },
    net: { prefetch, fetch: cachedFetch },
    clock: { now: serverNow, sync: serverClock },
    attribute,
  };
  (window as Window & { yerd?: unknown }).yerd = api;

  // Built in: prefetch. data-yx-prefetch is the mode (intent, visible, load);
  // the URL is data-yx-prefetch-url or the link's href.
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
      // Once fetched it's in the browser's cache; the tag has done its job.
      link.onload = link.onerror = () => link.remove();
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

  // Built in: sync. Infinite CSS animations on (and in) the element are lined
  // up as if they'd all started at the server's time zero, so every screen
  // shows the same frame. Done when it connects, when an animation starts
  // inside it (a class change), and when the clock is re-measured.
  const syncing = new Set<Element>();
  function align(el: Element): void {
    if (typeof el.getAnimations !== "function") return;
    const now = serverNow();
    for (const animation of el.getAnimations({ subtree: true })) {
      const timing = animation.effect?.getComputedTiming();
      const duration = Number(timing?.duration);
      if (!timing || timing.iterations !== Infinity || !(duration > 0)) continue;
      const delay = Number(timing.delay) || 0;
      // Two iterations, so an `alternate` one runs the same way everywhere too.
      const period = 2 * duration;
      animation.currentTime = delay + ((((now - delay) % period) + period) % period);
    }
  }
  const aligning = new Set<Element>();
  document.addEventListener("animationstart", (event) => {
    const host = (event.target as Element).closest?.("[data-yx-sync]");
    if (!host || !syncing.has(host) || aligning.has(host)) return;
    aligning.add(host);
    requestAnimationFrame(() => {
      aligning.delete(host);
      align(host);
    });
  });
  document.addEventListener("yx:clock", () => {
    for (const el of syncing) align(el);
  });
  attribute("data-yx-sync", (el) => {
    syncing.add(el);
    align(el);
    void clockReady().then(() => {
      if (syncing.has(el)) align(el);
    });
    return () => void syncing.delete(el);
  });

  // Built in: cue. Elements naming cues listen to their rooms through one
  // EventSource on /_yerd/cues (the public rooms), and elements with
  // data-yx-cue-from through the app's own stream route there (rooms behind
  // its guards); each source is open while an element needs it. Each cue
  // says when it plays on the server's clock: it's played then, or straight
  // away and partway through if that's already passed (a late arrival, a
  // slow link).
  type CueMessage = { id: string; name: string; room: string; at: number; lasts?: number; data?: unknown };
  const cueing = new Set<Element>();
  // Cue name -> the elements naming it; rebuilt when an element or its cues change.
  let cueIndex: Map<string, Element[]> | undefined;
  // Source + cue id -> when it's over (server time): a reconnect replays what's still running, and each plays once.
  const heard = new Map<string, number>();
  const cueRuns = new WeakMap<Element, number>();
  const cueSources = new Map<string, Stream>();
  let cueQueued = false;
  const PUBLIC_CUES = "/_yerd/cues?";
  const roomOf = (el: Element): string => el.getAttribute("data-yx-cue-room") || "main";
  const fromOf = (el: Element): string | null => el.getAttribute("data-yx-cue-from") || null;

  /** Whether a cue that came from `url` is for `el` (which names it). */
  function cueFor(el: Element, url: string, cue: CueMessage): boolean {
    const from = fromOf(el);
    // Public stream: the element's room. Its own route: whatever the route sends, narrowed by cueRoom if it has one.
    if (!from) return url.startsWith(PUBLIC_CUES) && roomOf(el) === cue.room;
    return from === url && (!el.hasAttribute("data-yx-cue-room") || roomOf(el) === cue.room);
  }

  function namedBy(name: string): Element[] {
    if (!cueIndex) {
      cueIndex = new Map();
      for (const el of cueing) {
        for (const cueName of new Set((el.getAttribute("data-yx-cue") ?? "").split(/\s+/))) {
          if (!cueName) continue;
          if (!cueIndex.has(cueName)) cueIndex.set(cueName, []);
          cueIndex.get(cueName)!.push(el);
        }
      }
    }
    return cueIndex.get(name) ?? [];
  }

  function playCue(cue: CueMessage, url: string): void {
    const behind = serverNow() - cue.at;
    // Within a frame is on time (a timer firing a little late): no seeking for that.
    const late = behind < 16 ? 0 : behind;
    if (cue.lasts !== undefined && late >= cue.lasts) return;
    const playing: Array<{ el: Element; before: Set<Animation> | undefined }> = [];
    for (const el of namedBy(cue.name)) {
      if (!el.isConnected || !cueFor(el, url, cue)) continue;
      const detail = { name: cue.name, room: cue.room, data: cue.data, at: cue.at, late };
      // preventDefault(): the listener plays it its own way.
      if (!el.dispatchEvent(new CustomEvent("yx:cue", { bubbles: true, cancelable: true, detail }))) continue;
      const before = typeof el.getAnimations === "function" ? new Set(el.getAnimations({ subtree: true })) : undefined;
      el.removeAttribute("data-yx-cued");
      playing.push({ el, before });
    }
    if (!playing.length) return;
    // Flush styles once between taking the attribute off and putting it back,
    // so an animation keyed off it starts over (on every element at once).
    void (playing[0]!.el as HTMLElement).offsetWidth;
    for (const { el, before } of playing) {
      el.setAttribute("data-yx-cued", cue.name);
      if (late > 0 && before) {
        for (const animation of el.getAnimations({ subtree: true })) {
          if (!before.has(animation)) animation.currentTime = (Number(animation.currentTime) || 0) + late;
        }
      }
      if (el instanceof HTMLMediaElement) {
        try {
          el.currentTime = late / 1000;
        } catch {
          // Not seekable yet: from the start.
        }
        // Browsers refuse sound until the visitor has interacted with the page.
        void el.play()?.catch(() => {});
      }
      const run = (cueRuns.get(el) ?? 0) + 1;
      cueRuns.set(el, run);
      if (cue.lasts !== undefined) {
        setTimeout(() => {
          if (cueRuns.get(el) === run) el.removeAttribute("data-yx-cued");
        }, cue.lasts - late);
      }
    }
  }

  function hear(cue: CueMessage, url: string): void {
    if (!cue || typeof cue.id !== "string" || typeof cue.name !== "string" || typeof cue.room !== "string" || typeof cue.at !== "number") return;
    const key = url + "\n" + cue.id;
    if (heard.has(key)) return;
    heard.set(key, cue.at + (cue.lasts ?? 0));
    if (heard.size > 256) {
      const old = serverNow() - 60000;
      for (const [id, end] of heard) if (end < old) heard.delete(id);
    }
    void clockReady().then(() => {
      const wait = cue.at - serverNow();
      if (wait > 0) setTimeout(() => playCue(cue, url), wait);
      else playCue(cue, url);
    });
  }

  function connectCues(): void {
    cueQueued = false;
    const urls = new Set<string>();
    const rooms = new Set<string>();
    for (const el of cueing) {
      const from = fromOf(el);
      if (from) urls.add(from);
      else rooms.add(roomOf(el));
    }
    if (rooms.size) urls.add(PUBLIC_CUES + Array.from(rooms).sort().map((room) => "room=" + encodeURIComponent(room)).join("&"));
    if (urls.size) void clockReady();
    reconcile(cueSources, urls, (url) =>
      stream(url, (event) => {
        try {
          hear(JSON.parse(event.data) as CueMessage, url);
        } catch {
          // Not a cue.
        }
      }),
    );
  }
  function queueCues(): void {
    cueIndex = undefined;
    if (cueQueued) return;
    cueQueued = true;
    queueMicrotask(connectCues);
  }
  attribute("data-yx-cue", (el) => {
    cueing.add(el);
    queueCues();
    return {
      update: queueCues,
      disconnect: () => {
        cueing.delete(el);
        queueCues();
      },
    };
  });
  // A room or source changed on its own (a morph): listen to the new one.
  for (const name of ["data-yx-cue-room", "data-yx-cue-from"]) {
    attribute(name, () => {
      queueCues();
      return { update: queueCues, disconnect: queueCues };
    });
  }

  // Everything that follows the page is registered: run it on this page.
  document.addEventListener("yx:applied", scanPage);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scanPage);
  else scanPage();
}

let source: string | undefined;

/**
 * The runtime as a script: the minified build when the package was built
 * with one (`npm run build`), otherwise the function's source in an IIFE.
 * The source must be self-contained, so the runtime has to be compiled at
 * ES2017 or later: older targets turn `async` into calls to a helper defined
 * outside the function, which wouldn't exist in the browser.
 */
export function runtimeSource(): string {
  if (source) return source;
  if (minified) return (source = minified);
  const fn = yerdRuntime.toString();
  if (/\b__(async|awaiter|generator)\b/.test(fn)) {
    throw new Error("yerd's client runtime was compiled below ES2017 (async was lowered to a helper); compile server code at ES2022");
  }
  return (source = `(${fn})();\n`);
}
