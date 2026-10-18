import type { ChunkApi, HeldInput, RuntimeHooks } from "./hooks.js";

/**
 * The runtime's local chunk, served at /_yerd/runtime-local.js: <Local>
 * state. The core loads it when the page has a <yerd-local> scope, and holds
 * the scopes' input until it's in (see the core's holdInput); replay() then
 * runs that input's handlers in order. Self-contained, like the core: it's
 * served as its own source.
 *
 * A <yerd-local> scope carries its initial state as JSON and the name its
 * handlers use for it. Handlers (data-yx-on-<event>) are compiled with the
 * state bound to that name; after each one, the scope's bindings
 * (data-yx-text, data-yx-bind) are re-applied from the state.
 */
export function yerdLocal(hooks: RuntimeHooks): ChunkApi {
  type Scope = { el: Element; state: Record<string, unknown>; name: string; key?: string; storage?: Storage };
  const scopes = new WeakMap<Element, Scope>();
  // The handler attributes each element has a listener for, and the listener.
  const wired = new WeakMap<Element, Map<string, (event: Event) => void>>();
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
    const done = wired.get(el) ?? new Map<string, (event: Event) => void>();
    wired.set(el, done);
    for (const name of names) {
      if (done.has(name)) continue;
      let source = el.getAttribute(name)!;
      let fn = compile(scope, source);
      const listener = (event: Event): void => {
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
      };
      done.set(name, listener);
      el.addEventListener(name.slice("data-yx-on-".length), listener);
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
  hooks.onPage("yerd-local[data-yx-local]", initLocals);

  /**
   * Input that came in before this chunk: each event's handlers run now, in
   * order, from its target up (only the target, for an event that doesn't
   * bubble), as dispatching it would have. The handlers get the event itself,
   * with currentTarget pointing at their element, and see the field as it was
   * then: its value is put back for them, and the live one restored after
   * unless a handler (or a binding) changed it meanwhile.
   */
  function replay(held: HeldInput[]): void {
    for (const { event, value, checked } of held) {
      const target = event.target as HTMLInputElement;
      if (!target.isConnected) continue;
      const was = { value: target.value, checked: target.checked, start: null as number | null, end: null as number | null };
      try {
        was.start = target.selectionStart;
        was.end = target.selectionEnd;
      } catch {
        // a field without a caret (checkbox, number)
      }
      const putBack = value !== undefined && value !== was.value;
      const reCheck = checked !== undefined && checked !== was.checked;
      if (putBack) target.value = value;
      if (reCheck) target.checked = checked;
      let stopped = false;
      for (let el: Element | null = target; el && !stopped; el = event.bubbles ? el.parentElement : null) {
        const listener = wired.get(el)?.get(`data-yx-on-${event.type}`);
        if (!listener) continue;
        const current = el;
        listener(
          new Proxy(event, {
            get(e, key) {
              if (key === "currentTarget") return current;
              if (key === "stopPropagation" || key === "stopImmediatePropagation") return () => void (stopped = true);
              const v: unknown = Reflect.get(e, key);
              return typeof v === "function" ? v.bind(e) : v;
            },
          }),
        );
      }
      if (putBack && target.value === value) {
        target.value = was.value;
        try {
          if (was.start !== null) target.setSelectionRange(was.start, was.end);
        } catch {
          // as above
        }
      }
      if (reCheck && target.checked === checked) target.checked = was.checked;
    }
  }

  return { replay };
}
