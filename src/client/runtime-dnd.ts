import type { Carried, ChunkApi, HeldDrop, RuntimeHooks } from "./hooks.js";

/**
 * The runtime's dnd chunk, served at /_yerd/runtime-dnd.js: drop targets,
 * file drops and dropTo staging. The core loads it when the page has a drop
 * target. Starting a drag can't wait for a download, so that part is the
 * core's (dragstart, data-yx-dragging, the dragged element in hooks.drag);
 * until this chunk is in, the core also lets drags over a target through and
 * holds their drops, which drop() then handles. Self-contained, like the core.
 *
 * Drop targets are elements whose trigger is "drop" (the page's draggable
 * elements), "drop:<selector>" (only draggables matching it) or
 * "drop:files" (files from outside the page, filtered by its accept
 * attribute). Drops are handled here, centrally: the innermost target that
 * accepts what's being dragged gets it.
 */
export function yerdDnd(hooks: RuntimeHooks): ChunkApi {
  const { drag, notify, runAction, carried } = hooks;

  /** The page element being dragged, if it's still on the page. */
  function dragSource(): HTMLElement | null {
    if (drag.el && !drag.el.isConnected) drag.el = null;
    return drag.el;
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

  /** What a drop target takes: "page" (any draggable), a selector, or "files". */
  function dropKind(target: Element): string {
    if (target.hasAttribute("data-yx-drop-to")) return "files";
    const spec = (target.getAttribute("data-yx-trigger") ?? "").trim();
    return spec === "drop" ? "page" : spec.slice(5).trim() || "page";
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

  function accepts(target: Element, what: Carried): boolean {
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
    if (kind !== "files" || !what.files) return false;
    // While dragging, only types are known (and not in every browser): refuse only a clear mismatch.
    const accept = acceptOf(target);
    return what.types.length === 0 || what.types.some((type) => !type || fits(accept, type));
  }

  /** The innermost drop target at `from` that accepts this drag. */
  function dropTarget(from: Element, what: Carried): HTMLElement | null {
    let target = from.closest?.<HTMLElement>(hooks.dropTargets) ?? null;
    while (target && !accepts(target, what)) target = target.parentElement?.closest<HTMLElement>(hooks.dropTargets) ?? null;
    return target;
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
  // Files picked before this chunk came in (or kept by Back) are counted too.
  hooks.onPage("[data-yx-drop-to]", (zones) => {
    for (const zone of zones) {
      const input = stagingInput(zone);
      if (input) countStaged(input);
    }
  });

  document.addEventListener("dragover", (event) => {
    const what = carried(event);
    const target = dropTarget(event.target as Element, what);
    if (!target) {
      setOver(null);
      if (!dragSource() && what.files && hasFileTargets()) {
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

  /** A drop on `target` (null: nowhere that takes it): post the action, or stage the files. */
  function dropOn(target: HTMLElement | null, files: File[]): void {
    if (!target) {
      hooks.endDrag();
      return;
    }
    setOver(null);
    if (dragSource()) {
      void runAction(target);
      hooks.endDrag();
      return;
    }
    const accept = acceptOf(target);
    const fitting = files.filter((file) => fits(accept, file.type, file.name));
    const refused = files.length - fitting.length;
    hooks.endDrag();
    if (refused && !fitting.length) {
      notify("Those files can't be dropped here.");
      return;
    }
    if (refused) notify(`${refused} file${refused === 1 ? "" : "s"} skipped: not a type this takes.`);
    if (!fitting.length) return;
    if (target.hasAttribute("data-yx-drop-to")) stage(target, fitting);
    else void runAction(target, fitting);
  }

  document.addEventListener("drop", (event) => {
    const what = carried(event);
    const target = dropTarget(event.target as Element, what);
    // A missed file drop would navigate to the file: not while the page takes files somewhere.
    if (target || (!dragSource() && what.files && hasFileTargets())) event.preventDefault();
    dropOn(target, target && !dragSource() ? hooks.filesOf(event.dataTransfer) : []);
  });

  return {
    reset() {
      setOver(null);
      forgetDrag();
    },
    drop(held: HeldDrop) {
      drag.el = held.source;
      dropOn(dropTarget(held.target, held.carried), held.files);
    },
  };
}
