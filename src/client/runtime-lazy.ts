import type { LazyModule, RuntimeHooks } from "./hooks.js";

/**
 * The runtime's lazy chunk, served at /_yerd/runtime-lazy.js: the app's own
 * client modules, imported when they're first needed instead of with every
 * page. The core loads it when the page has an island ([data-yx-island]), a
 * lazy element's tag, or an attribute whose client half is a module (those
 * two come from the server in hooks.lazy). Self-contained, like the core.
 *
 * - Islands: the module's default export mounts into the element when its
 *   trigger fires, with the JSON props from data-yx-props, and its cleanup
 *   runs when the element leaves the page. Each island has its own trigger.
 * - Lazy elements: the module defines the custom element itself; it's
 *   imported when the first element with that tag fires its trigger, and
 *   the browser upgrades every one of them.
 * - Module-backed attributes: the default export is the client half. It's
 *   imported when the first element carrying the attribute fires its
 *   trigger; from then on it connects everywhere, like an inline one.
 *
 * Triggers (data-yx-when, or the registry's `when`): "load" (now), "idle",
 * "visible" (200px ahead of the viewport), "interaction" (the first
 * pointerenter, pointerdown, focusin or touchstart on the element) and
 * "media:<query>". The triggering event isn't replayed: an interaction
 * trigger fires on the way to a click (hover, press, focus), so the module
 * usually connects before the click lands, but nothing re-sends it if not.
 *
 * While its module loads the element has data-yx-loading, and
 * data-yx-failed if the import (or the mount) threw; yx:lazy-start and
 * yx:lazy-end ({ src, ok, error }) bubble from it. Each URL is imported once
 * per page, and the stylesheets the Vite manifest lists for it are linked
 * first.
 */
export function yerdLazy(hooks: RuntimeHooks): void {
  const { lazy, importModule, attribute, onPage } = hooks;
  type Handle = { update?(value: string): void; disconnect?(): void };
  type Setup = (el: HTMLElement, value: string, api: unknown) => void | (() => void) | Handle;

  const modules = new Map<string, Promise<{ default?: unknown }>>();
  const sheets = new Map<string, Promise<void>>();

  /** Link a stylesheet (unless the page already has it); resolves once it has loaded or failed, which shouldn't keep the module from running. */
  function stylesheet(href: string): Promise<void> {
    const url = new URL(href, document.baseURI).href;
    let ready = sheets.get(url);
    if (!ready) {
      ready = new Promise<void>((resolve) => {
        for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))) {
          if (link.href === url) return resolve();
        }
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = url;
        link.onload = link.onerror = () => resolve();
        document.head.appendChild(link);
      });
      sheets.set(url, ready);
    }
    return ready;
  }

  /**
   * A module, imported once per page, with its stylesheets in first. A
   * custom element upgrades the moment its module defines it, so for those
   * (`styledFirst`) the stylesheets go in before the import starts;
   * otherwise they load alongside it.
   */
  function load(spec: LazyModule, styledFirst = false): Promise<{ default?: unknown }> {
    let module = modules.get(spec.url);
    if (!module) {
      const styled = Promise.all((spec.css ?? []).map(stylesheet));
      module = styledFirst ? styled.then(() => importModule(spec.url)) : Promise.all([importModule(spec.url), styled]).then(([loaded]) => loaded);
      modules.set(spec.url, module);
    }
    return module;
  }

  // ── triggers ──
  let seen: IntersectionObserver | undefined;
  const onSeen = new Map<Element, () => void>();
  const INTERACTIONS = ["pointerenter", "pointerdown", "focusin", "touchstart"];

  /** Call `go` once, when `when` fires for `el`. Returns a function that stops waiting. */
  function arm(el: Element, when: string, go: () => void): () => void {
    let done = false;
    let stop = (): void => {};
    const fire = (): void => {
      if (done) return;
      done = true;
      stop();
      go();
    };
    if (when === "idle") {
      if (typeof requestIdleCallback === "function") {
        // An idle period may never come on a busy page: two seconds at most.
        const id = requestIdleCallback(fire, { timeout: 2000 });
        stop = () => cancelIdleCallback(id);
      } else {
        const id = setTimeout(fire, 200);
        stop = () => clearTimeout(id);
      }
    } else if (when === "visible" && typeof IntersectionObserver === "function") {
      seen ??= new IntersectionObserver(
        (entries) => {
          for (const entry of entries) if (entry.isIntersecting) onSeen.get(entry.target)?.();
        },
        { rootMargin: "200px" },
      );
      onSeen.set(el, fire);
      seen.observe(el);
      stop = () => {
        onSeen.delete(el);
        seen!.unobserve(el);
      };
    } else if (when === "interaction") {
      for (const type of INTERACTIONS) el.addEventListener(type, fire, { passive: true });
      stop = () => {
        for (const type of INTERACTIONS) el.removeEventListener(type, fire);
      };
    } else if (when.startsWith("media:") && typeof matchMedia === "function") {
      const query = matchMedia(when.slice(6));
      if (!query.matches) {
        const change = (): void => {
          if (query.matches) fire();
        };
        query.addEventListener("change", change);
        stop = () => query.removeEventListener("change", change);
        return () => {
          done = true;
          stop();
        };
      }
      fire();
    } else {
      // "load", or a browser without the API the trigger needs: now.
      fire();
    }
    return () => {
      done = true;
      stop();
    };
  }

  // ── loading state ──
  function begin(el: Element, src: string): void {
    el.removeAttribute("data-yx-failed");
    el.setAttribute("data-yx-loading", "");
    el.dispatchEvent(new CustomEvent("yx:lazy-start", { bubbles: true, detail: { src } }));
  }

  function end(el: Element, src: string, failed: boolean, error?: unknown): void {
    el.removeAttribute("data-yx-loading");
    if (failed) {
      el.setAttribute("data-yx-failed", "");
      console.error(`[yerd] couldn't load ${src}:`, error);
    }
    el.dispatchEvent(new CustomEvent("yx:lazy-end", { bubbles: true, detail: failed ? { src, ok: false, error } : { src, ok: true } }));
  }

  function handleOf(result: unknown): Handle {
    return typeof result === "function" ? { disconnect: result as () => void } : ((result ?? {}) as Handle);
  }

  // ── islands ──
  // Connected and disconnected by the core like a custom attribute, so an
  // island that leaves the page (a morph, a boost) runs its cleanup. Islands
  // render data-yx-keep, so a morph never patches what a mount drew.
  attribute("data-yx-island", (el, src, api) => {
    let cleanup: (() => void) | undefined;
    let gone = false;
    const spec: LazyModule = { url: src, when: el.getAttribute("data-yx-when") || "load", css: (el.getAttribute("data-yx-styles") ?? "").split(" ").filter(Boolean) };
    const disarm = arm(el, spec.when, () => {
      begin(el, src);
      load(spec)
        .then(async (module) => {
          const mount = module.default;
          if (typeof mount !== "function") throw new TypeError(`${src} has no default export to mount`);
          if (gone) return;
          const props = el.hasAttribute("data-yx-props") ? JSON.parse(el.getAttribute("data-yx-props")!) : undefined;
          const result: unknown = await mount(el, props, api);
          const done = typeof result === "function" ? (result as () => void) : undefined;
          // Gone while an async mount ran: clean up straight away.
          if (gone) done?.();
          else cleanup = done;
        })
        .then(
          () => end(el, src, false),
          (error: unknown) => end(el, src, true, error),
        );
    });
    return {
      disconnect() {
        gone = true;
        disarm();
        try {
          cleanup?.();
        } catch (error) {
          console.error(`[yerd] the island from ${src} failed to clean up:`, error);
        }
      },
    };
  });

  // ── module-backed attributes ──
  for (const [name, spec] of Object.entries(lazy.attributes)) {
    let setup: Setup | undefined;
    // The elements waiting for the module: connect each (and stop its trigger) once it's in.
    const waiting = new Map<() => void, () => void>();
    attribute(name, (el, _value, api) => {
      let real: Handle | undefined;
      let gone = false;
      const connect = (): void => {
        if (gone || !setup) return;
        try {
          real = handleOf(setup(el, el.getAttribute(name) ?? "", api));
        } catch (error) {
          console.error(`[yerd] attribute ${name} failed to connect:`, error);
        }
      };
      if (setup) connect();
      else {
        const disarm = arm(el, spec.when, () => {
          begin(el, spec.url);
          load(spec)
            .then((module) => {
              if (typeof module.default !== "function") throw new TypeError(`${spec.url} has no default export for attribute ${name}`);
              setup ??= module.default as Setup;
              for (const [ready, stop] of Array.from(waiting)) {
                waiting.delete(ready);
                stop();
                ready();
              }
            })
            .then(
              () => end(el, spec.url, false),
              (error: unknown) => end(el, spec.url, true, error),
            );
        });
        waiting.set(connect, disarm);
      }
      return {
        update(value) {
          real?.update?.(value);
        },
        disconnect() {
          gone = true;
          waiting.get(connect)?.();
          waiting.delete(connect);
          real?.disconnect?.();
        },
      };
    });
  }

  // ── lazy elements ──
  const tags = Object.keys(lazy.elements);
  if (!tags.length) return;
  const selector = tags.join(", ");
  const armed = new WeakSet<Element>();
  // tag -> how to stop each of its elements' triggers, once one has loaded the module.
  const pending = new Map<string, Array<() => void>>();

  function upgrade(el: Element, tag: string): void {
    const spec = lazy.elements[tag]!;
    begin(el, spec.url);
    load(spec, true)
      .then(() => {
        for (const stop of pending.get(tag) ?? []) stop();
        pending.delete(tag);
        if (!customElements.get(tag)) throw new TypeError(`${spec.url} didn't define <${tag}>`);
      })
      .then(
        () => end(el, spec.url, false),
        (error: unknown) => end(el, spec.url, true, error),
      );
  }

  function watch(found: Element[]): void {
    for (const el of found) {
      const tag = el.localName;
      if (armed.has(el) || customElements.get(tag)) continue;
      armed.add(el);
      const stops = pending.get(tag) ?? [];
      pending.set(tag, stops);
      stops.push(arm(el, lazy.elements[tag]!.when, () => upgrade(el, tag)));
    }
  }

  // On the page now and after each apply, and whenever app code adds one.
  onPage(selector, watch);
  new MutationObserver((records) => {
    const found: Element[] = [];
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node.nodeType !== 1) continue;
        const el = node as Element;
        if (el.matches(selector)) found.push(el);
        found.push(...Array.from(el.querySelectorAll(selector)));
      }
    }
    if (found.length) watch(found);
  }).observe(document.documentElement, { childList: true, subtree: true });
}
