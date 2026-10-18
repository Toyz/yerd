/**
 * What the client runtime's core hands its chunks (cues, dnd, local, lazy), and
 * what they hand back. Types only: every chunk is a self-contained function
 * served as text (see runtime.ts), so nothing here exists in the browser.
 * The object itself is internal, passed to each chunk as it starts; it isn't
 * part of window.yerd.
 */

/** A chunk's name: also its URL, `/_yerd/runtime-<name>.js`. */
export type ChunkName = "cues" | "dnd" | "local" | "lazy";

/** A client module the lazy chunk imports: its URL, when to import it, and the stylesheets it needs (from the Vite manifest). */
export interface LazyModule {
  url: string;
  /** "load", "idle", "visible", "interaction" or "media:<query>". */
  when: string;
  /** Linked before the module runs. Only in production: in dev, Vite's own client injects a module's CSS. */
  css?: string[];
}

/**
 * The app's lazy elements and module-backed attributes, as the server
 * resolved them (sent with the runtime script). Islands carry their own
 * module on the element, so they aren't listed.
 */
export interface LazyRegistry {
  /** Custom element tag -> the module that defines it. */
  elements: Record<string, LazyModule>;
  /** Attribute name -> the module whose default export is its client half. */
  attributes: Record<string, LazyModule>;
}

/** A server-sent event stream that reopens itself (see stream() in the core). */
export interface Stream {
  close(): void;
}

/** A custom attribute's client half, as yerd.attribute() takes it. */
export type AttributeSetup = (el: HTMLElement, value: string, api: unknown) => void | (() => void) | { update?(value: string): void; disconnect?(): void };

/** What's being dragged, as far as a drop target needs to know: whether it's files, and their MIME types. */
export interface Carried {
  files: boolean;
  types: string[];
}

/** A drop the core caught before the dnd chunk was in, handed to it once it is. */
export interface HeldDrop {
  target: Element;
  /** The page element that was being dragged, or null for files from outside. */
  source: HTMLElement | null;
  carried: Carried;
  files: File[];
}

/** An event the core caught in a <Local> scope before the local chunk was in, and what its field held then. */
export interface HeldInput {
  event: Event;
  value?: string;
  checked?: boolean;
  /**
   * The core cancelled what the browser would have done (follow a link,
   * submit), since a handler on the way may cancel it: replay does it
   * afterwards, through runDefault(), unless one did.
   */
  deferred?: boolean;
}

export interface RuntimeHooks {
  /** Run `run` with the matching elements once the page is scanned, and after every apply, boost and refresh. */
  onPage(selector: string, run: (found: Element[]) => void): void;
  /** yerd.attribute(): connect a client attribute on every element carrying it. */
  attribute(name: string, setup: AttributeSetup): void;
  /** Show a short status message (#yx-notice). */
  notify(message: string): void;
  /** Post an element's action, as its trigger would. */
  runAction(el: HTMLElement, files?: File[]): Promise<void>;
  /** The server's clock, as measured so far. */
  serverNow(): number;
  /** Resolves once the server's clock has been measured. */
  clockReady(): Promise<void>;
  /** An EventSource that keeps coming back. */
  stream(url: string, onMessage: (event: MessageEvent<string>) => void, reconnected?: () => void): Stream;
  /** Close the streams no longer wanted and open the new ones. */
  reconcile(streams: Map<string, Stream>, wanted: Set<string>, open: (url: string) => Stream): void;
  /** The page element being dragged (the core starts drags; the chunk ends them). */
  drag: { el: HTMLElement | null };
  /** Clear the drag: the core's part, then the chunk's own (its reset()). */
  endDrag(): void;
  /** What a drag event carries. */
  carried(event: DragEvent): Carried;
  /** The files in a drop, minus folders. Only readable while the drop is being dispatched. */
  filesOf(transfer: DataTransfer | null): File[];
  /** Elements that take drops. */
  dropTargets: string;
  /**
   * The server has a newer runtime than this page's core (a deploy while the
   * page was open): its chunk can't be trusted to fit, so reload the page.
   */
  outdated(): void;
  /** Do what the browser would have done for a deferred event (see HeldInput.deferred). */
  runDefault(event: Event): void;
  /** True while the core re-submits a form whose <Local> submit handlers already ran in a replay: they sit this one out. */
  quiet(): boolean;
  /** lazy: the app's lazy elements and module-backed attributes. */
  lazy: LazyRegistry;
  /** lazy: import() an app module (only the served script can call import(), so the core lends its own). */
  importModule(url: string): Promise<{ default?: unknown }>;
}

/** What a chunk may hand back to the core. */
export interface ChunkApi {
  /** dnd: forget what the current drag looked up. */
  reset?(): void;
  /** dnd: handle a drop the core held. */
  drop?(held: HeldDrop): void;
  /** local: run the handlers for input the core held, in order. */
  replay?(held: HeldInput[]): void;
}

/** A chunk: started once, with the core's hooks. */
export type Chunk = (hooks: RuntimeHooks) => ChunkApi | void;
