import type { RuntimeHooks, Stream } from "./hooks.js";

/**
 * The runtime's cues chunk, served at /_yerd/runtime-cues.js: `sync`
 * animations and cue playback. The core loads it when the page has a
 * [data-yx-sync] or [data-yx-cue] element. The server's clock stays in the
 * core (yerd.clock works without this chunk); both features here are timed
 * on it. Self-contained, like the core.
 */
export function yerdCues(hooks: RuntimeHooks): void {
  const { attribute, serverNow, clockReady } = hooks;

  // sync: infinite CSS animations on (and in) the element are lined up as if
  // they'd all started at the server's time zero, so every screen shows the
  // same frame. Done when it connects, when an animation starts inside it (a
  // class change), and when the clock is re-measured.
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

  // cue: elements naming cues listen to their rooms through one EventSource
  // on /_yerd/cues (the public rooms), and elements with data-yx-cue-from
  // through the app's own stream route there (rooms behind its guards); each
  // source is open while an element needs it. Each cue says when it plays on
  // the server's clock: it's played then, or straight away and partway
  // through if that's already passed (a late arrival, a slow link).
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
    hooks.reconcile(cueSources, urls, (url) =>
      hooks.stream(url, (event) => {
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
}
