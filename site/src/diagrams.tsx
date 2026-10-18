/**
 * Diagrams the guides ask for by name (```diagram lifecycle```, see
 * docs/WRITING.md). markdown.ts writes <yerd-diagram name="..."> with the
 * block's text inside; this component draws the named diagram in its own
 * shadow root, and that text becomes its accessible name.
 *
 * Each diagram is laid out twice, wide and tall, from the same pieces; a
 * container query picks the tall one when the column is narrow, so nothing
 * shrinks below reading size on a phone. Colors are the site's tokens, so
 * both themes come for free.
 */

import { LoomElement, component, css, styles } from "@toyz/loom";

type Tone = "plain" | "key" | "side" | "error" | "ghost";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The label, one or two lines. */
  text: string[];
  /** Smaller lines under the label. */
  caption?: string[];
  tone?: Tone;
}

interface Path {
  points: Array<[number, number]>;
  tone?: "plain" | "side" | "error" | "ghost";
  arrow?: boolean;
}

interface Label {
  x: number;
  y: number;
  text: string;
  anchor?: "start" | "middle" | "end";
  kind?: "caption" | "lane" | "error" | "code";
}

interface Layout {
  w: number;
  h: number;
  lanes?: Array<{ x: number; y: number; w: number; h: number }>;
  boxes: Box[];
  paths: Path[];
  labels?: Label[];
  dots?: Array<[number, number]>;
}

interface Diagram {
  wide: Layout;
  tall: Layout;
}

// ── lifecycle: one request through yerd ──

function lifecycle(): Diagram {
  // Wide: the main line left to right, the error branch under it, the session commit above the way out.
  // Longer labels sit on two lines in a narrow box.
  const names = [["request"], ["middleware"], ["guards"], ["handler"], ["returns", "a value"], ["coerce +", "layouts"]];
  const w = 82;
  const col = (i: number) => 3 + i * (w + 16);
  const top = 56;
  const h = 46;
  const mid = top + h / 2;
  const responseX = col(5) + w + 60;
  const join = col(5) + w + 22;
  const tap = join + 18;
  const errTop = 136;
  const errMid = errTop + 16;
  const wide: Layout = {
    w: 720,
    h: 178,
    boxes: [
      ...names.map((text, i): Box => ({ x: col(i), y: top, w, h, text, tone: i === 3 ? "key" : "plain" })),
      { x: responseX, y: top, w, h, text: ["response"], tone: "plain" },
      { x: 537, y: 4, w: 180, h: 30, text: ["session commit + cookies"], tone: "side" },
      { x: col(3), y: errTop, w, h: 32, text: ["@catches"], tone: "error" },
      { x: col(4), y: errTop, w, h: 32, text: ["onError"], tone: "error" },
      { x: col(5), y: errTop, w, h: 32, text: ["error page"], tone: "error" },
    ],
    paths: [
      ...[0, 1, 2, 3, 4].map((i): Path => ({ points: [[col(i) + w, mid], [col(i + 1), mid]], arrow: true })),
      { points: [[col(5) + w, mid], [responseX, mid]], arrow: true },
      { points: [[tap, mid], [tap, 34]], tone: "side" },
      // Anything thrown on the way in goes to the error branch.
      { points: [[col(1) + w / 2, top + h], [col(1) + w / 2, errMid], [col(3), errMid]], tone: "error", arrow: true },
      { points: [[col(2) + w / 2, top + h], [col(2) + w / 2, errMid]], tone: "error" },
      { points: [[col(3) + w / 2, top + h], [col(3) + w / 2, errTop]], tone: "error", arrow: true },
      { points: [[col(3) + w, errMid], [col(4), errMid]], tone: "error", arrow: true },
      { points: [[col(4) + w, errMid], [col(5), errMid]], tone: "error", arrow: true },
      { points: [[col(5) + w, errMid], [join, errMid], [join, mid]], tone: "error" },
    ],
    labels: [
      { x: 529, y: 23, text: "on the way out", anchor: "end", kind: "caption" },
      { x: col(1) + w / 2 + 8, y: errMid - 6, text: "throws", kind: "error" },
    ],
    dots: [[join, mid], [tap, mid]],
  };

  // Tall: the main line top to bottom, the error branch in a column on the right.
  const tx = 10;
  const tw = 180;
  const th = 38;
  const row = (i: number) => 8 + i * 58;
  const tmid = (i: number) => row(i) + th / 2;
  const ex = 214;
  const ew = 116;
  const ecx = ex + ew / 2;
  const cx = tx + tw / 2;
  const tjoin = row(5) + th + 18;
  const ttap = tjoin + 34;
  const tresp = ttap + 34;
  const tall: Layout = {
    w: 340,
    h: tresp + th + 6,
    boxes: [
      ...["request", "middleware", "guards", "handler", "returns a value", "coerce + layouts"].map(
        (label, i): Box => ({ x: tx, y: row(i), w: tw, h: th, text: [label], tone: i === 3 ? "key" : "plain" }),
      ),
      { x: tx, y: tresp, w: tw, h: th, text: ["response"] },
      { x: ex, y: row(3), w: ew, h: th, text: ["@catches"], tone: "error" },
      { x: ex, y: row(4), w: ew, h: th, text: ["onError"], tone: "error" },
      { x: ex, y: row(5), w: ew, h: th, text: ["error page"], tone: "error" },
      { x: ex, y: ttap - 18, w: ew, h: 36, text: ["session commit", "+ cookies"], tone: "side" },
    ],
    paths: [
      ...[0, 1, 2, 3, 4].map((i): Path => ({ points: [[cx, row(i) + th], [cx, row(i + 1)]], arrow: true })),
      { points: [[cx, row(5) + th], [cx, tresp]], arrow: true },
      { points: [[cx, ttap], [ex, ttap]], tone: "side" },
      { points: [[tx + tw, tmid(1)], [tx + tw + 12, tmid(1)], [tx + tw + 12, tmid(3)]], tone: "error" },
      { points: [[tx + tw, tmid(2)], [tx + tw + 12, tmid(2)]], tone: "error" },
      { points: [[tx + tw, tmid(3)], [ex, tmid(3)]], tone: "error", arrow: true },
      { points: [[ecx, row(3) + th], [ecx, row(4)]], tone: "error", arrow: true },
      { points: [[ecx, row(4) + th], [ecx, row(5)]], tone: "error", arrow: true },
      { points: [[ecx, row(5) + th], [ecx, tjoin], [cx, tjoin]], tone: "error" },
    ],
    labels: [
      { x: tx + tw + 18, y: tmid(1) + 4, text: "throws", kind: "error" },
      { x: ecx, y: ttap + 32, text: "on the way out", anchor: "middle", kind: "caption" },
    ],
    dots: [[cx, tjoin], [cx, ttap]],
  };
  return { wide, tall };
}

// ── action: a form or element action, answered with Regions ──

function action(): Diagram {
  const sw = 140;
  const sx = (i: number) => 25 + i * (sw + 30);
  const sy = 150;
  const sh = 40;
  const wide: Layout = {
    w: 720,
    h: 214,
    lanes: [
      { x: 0, y: 0, w: 720, h: 96 },
      { x: 0, y: 108, w: 720, h: 106 },
    ],
    boxes: [
      { x: 10, y: 30, w: 170, h: 50, text: ["form or element"], caption: ["with a signed action token"] },
      { x: 222, y: 34, w: 256, h: 42, text: ["without JS: a plain POST,", "then a redirect back"], tone: "ghost" },
      { x: 520, y: 30, w: 190, h: 50, text: ["runtime morphs"], caption: ["matching Regions in place"], tone: "key" },
      { x: sx(0), y: sy, w: sw, h: sh, text: ["verify token"] },
      { x: sx(1), y: sy, w: sw, h: sh, text: ["guards"] },
      { x: sx(2), y: sy, w: sw, h: sh, text: ["action method"], tone: "key" },
      { x: sx(3), y: sy, w: sw, h: sh, text: ["JSX with <Region>s"] },
    ],
    paths: [
      { points: [[95, 80], [95, sy]], arrow: true },
      { points: [[180, 55], [222, 55]], tone: "ghost", arrow: true },
      ...[0, 1, 2].map((i): Path => ({ points: [[sx(i) + sw, sy + sh / 2], [sx(i + 1), sy + sh / 2]], arrow: true })),
      { points: [[sx(3) + sw / 2, sy], [sx(3) + sw / 2, 80]], arrow: true },
    ],
    labels: [
      { x: 12, y: 18, text: "BROWSER", kind: "lane" },
      { x: 12, y: 128, text: "SERVER", kind: "lane" },
      { x: 103, y: 124, text: "POST, yx header", kind: "code" },
      { x: sx(3) + sw / 2 - 8, y: 124, text: "the Regions, as HTML", anchor: "end", kind: "code" },
    ],
  };

  const bx = 14;
  const bw = 140;
  const bcx = bx + bw / 2;
  const svx = 186;
  const svw = 140;
  const svcx = svx + svw / 2;
  const srow = (i: number) => 96 + i * 58;
  const tall: Layout = {
    w: 340,
    h: 452,
    lanes: [
      { x: 0, y: 0, w: 164, h: 452 },
      { x: 176, y: 0, w: 164, h: 452 },
    ],
    boxes: [
      { x: bx, y: 28, w: bw, h: 50, text: ["form or element"], caption: ["with a signed token"] },
      { x: bx, y: 160, w: bw, h: 60, text: ["without JS:", "a plain POST, then", "a redirect back"], tone: "ghost" },
      { x: bx, y: 388, w: bw, h: 50, text: ["runtime morphs"], caption: ["matching Regions"], tone: "key" },
      { x: svx, y: srow(0), w: svw, h: 36, text: ["verify token"] },
      { x: svx, y: srow(1), w: svw, h: 36, text: ["guards"] },
      { x: svx, y: srow(2), w: svw, h: 36, text: ["action method"], tone: "key" },
      { x: svx, y: srow(3), w: svw, h: 36, text: ["JSX with <Region>s"] },
    ],
    paths: [
      { points: [[bx + bw, 53], [svcx, 53], [svcx, srow(0)]], arrow: true },
      { points: [[bcx, 78], [bcx, 160]], tone: "ghost", arrow: true },
      ...[0, 1, 2].map((i): Path => ({ points: [[svcx, srow(i) + 36], [svcx, srow(i + 1)]], arrow: true })),
      { points: [[svcx, srow(3) + 36], [svcx, 362], [bcx, 362], [bcx, 388]], arrow: true },
    ],
    labels: [
      { x: 10, y: 16, text: "BROWSER", kind: "lane" },
      { x: 186, y: 16, text: "SERVER", kind: "lane" },
      { x: (bx + bw + svcx) / 2, y: 46, text: "POST, yx header", anchor: "middle", kind: "code" },
      { x: svcx - 8, y: 354, text: "the Regions, as HTML", anchor: "end", kind: "code" },
    ],
  };
  return { wide, tall };
}

const DIAGRAMS: Record<string, () => Diagram> = { lifecycle, action };

/** Whether a diagram block's name is one this file draws. */
export function hasDiagram(name: string): boolean {
  return Object.hasOwn(DIAGRAMS, name);
}

// ── drawing ──

function arrowHead([x1, y1]: [number, number], [x2, y2]: [number, number]): string {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const size = 6;
  const spread = 0.45;
  const a = [x2 - size * Math.cos(angle - spread), y2 - size * Math.sin(angle - spread)];
  const b = [x2 - size * Math.cos(angle + spread), y2 - size * Math.sin(angle + spread)];
  return `${x2},${y2} ${a[0]!.toFixed(1)},${a[1]!.toFixed(1)} ${b[0]!.toFixed(1)},${b[1]!.toFixed(1)}`;
}

function BoxText({ box }: { box: Box }) {
  const lines = [...box.text.map((t) => ({ t, cap: false })), ...(box.caption ?? []).map((t) => ({ t, cap: true }))];
  const lineH = (cap: boolean) => (cap ? 13.5 : 15.5);
  const total = lines.reduce((sum, l) => sum + lineH(l.cap), 0);
  let y = box.y + (box.h - total) / 2;
  return (
    <text x={box.x + box.w / 2} text-anchor="middle">
      {lines.map((l) => {
        y += lineH(l.cap);
        return (
          <tspan x={box.x + box.w / 2} y={y - (l.cap ? 3.5 : 4)} class={l.cap ? "cap" : "label"}>
            {l.t}
          </tspan>
        );
      })}
    </text>
  );
}

function Drawing({ layout, class: className }: { layout: Layout; class: string }) {
  return (
    <svg class={className} viewBox={`0 0 ${layout.w} ${layout.h}`} width="100%" aria-hidden="true">
      {(layout.lanes ?? []).map((l) => (
        <rect class="lane" x={l.x} y={l.y} width={l.w} height={l.h} rx={8} />
      ))}
      {layout.paths.map((p) => (
        <g class={`path ${p.tone ?? "plain"}`}>
          <polyline points={p.points.map(([x, y]) => `${x},${y}`).join(" ")} />
          {p.arrow ? <polygon points={arrowHead(p.points[p.points.length - 2]!, p.points[p.points.length - 1]!)} /> : null}
        </g>
      ))}
      {(layout.dots ?? []).map(([x, y]) => (
        <circle class="dot" cx={x} cy={y} r={3} />
      ))}
      {layout.boxes.map((b) => (
        <g class={`box ${b.tone ?? "plain"}`}>
          <rect x={b.x + 0.5} y={b.y + 0.5} width={b.w - 1} height={b.h - 1} rx={6} />
          <BoxText box={b} />
        </g>
      ))}
      {(layout.labels ?? []).map((l) => (
        <text class={`note ${l.kind ?? "caption"}`} x={l.x} y={l.y} text-anchor={l.anchor ?? "start"}>
          {l.text}
        </text>
      ))}
    </svg>
  );
}

const sheet = css`
  :host { display: block; container-type: inline-size; }
  figure { margin: 0; }
  svg { display: block; height: auto; overflow: visible; }
  .tall { display: none; max-width: 400px; margin: 0 auto; }
  @container (max-width: 540px) {
    .wide { display: none; }
    .tall { display: block; }
  }

  text { font-family: var(--font); fill: var(--text); }
  .label { font-size: 12.5px; font-weight: 700; }
  .cap { font-size: 10.5px; fill: var(--text-faint); font-weight: 400; }
  .cap.code, .note.code { font-family: var(--mono); }
  .note { font-size: 10.5px; fill: var(--text-faint); }
  .note.lane { font-size: 10px; font-weight: 700; letter-spacing: 0.12em; fill: var(--text-faint); }
  .note.error { fill: var(--danger); }
  .note.code { fill: var(--text-dim); }

  .lane { fill: var(--bg-sunken); opacity: 0.7; }
  .box rect { fill: var(--bg-raised); stroke: var(--border-strong); stroke-width: 1; }
  .box.key rect { fill: light-dark(#fbeee8, #2e211c); stroke: var(--brand); }
  .box.key .label { fill: var(--accent); }
  .box.side rect { fill: light-dark(#eef1e6, #212519); stroke: var(--moss-fill); }
  .box.side .label, .box.side .cap { fill: var(--moss); }
  .box.side .label { font-weight: 600; font-size: 11.5px; }
  .box.error rect { fill: light-dark(#f8ebe6, #2a1d19); stroke: var(--danger); stroke-dasharray: 4 3; }
  .box.error .label { fill: var(--danger); font-family: var(--mono); font-weight: 600; font-size: 11.5px; }
  .box.ghost rect { fill: none; stroke: var(--border-strong); stroke-dasharray: 4 3; }
  .box.ghost .label { fill: var(--text-dim); font-size: 11px; font-weight: 400; }

  .path polyline { fill: none; stroke: var(--text-faint); stroke-width: 1.5; stroke-linejoin: round; }
  .path polygon { fill: var(--text-faint); }
  .path.error polyline { stroke: var(--danger); stroke-dasharray: 4 3; }
  .path.error polygon { fill: var(--danger); }
  .path.side polyline { stroke: var(--moss-fill); stroke-dasharray: 2 3; stroke-width: 2; }
  .path.ghost polyline { stroke: var(--border-strong); stroke-dasharray: 4 3; }
  .path.ghost polygon { fill: var(--border-strong); }
  .dot { fill: var(--text-faint); }
`;

/** `<yerd-diagram name="lifecycle" data-alt="...">`: a named diagram; data-alt is its text alternative. */
@component("yerd-diagram")
@styles(sheet)
export class YerdDiagram extends LoomElement {
  update() {
    const name = this.getAttribute("name") ?? "";
    const make = DIAGRAMS[name];
    const alt = this.dataset.alt || this.textContent?.trim() || `${name} diagram`;
    if (!make) return <pre>{alt}</pre>;
    const { wide, tall } = make();
    return (
      <figure role="img" aria-label={alt}>
        <Drawing layout={wide} class="wide" />
        <Drawing layout={tall} class="tall" />
      </figure>
    );
  }
}
