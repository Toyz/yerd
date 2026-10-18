import type { AttributeSetup } from "@toyz/yerd/client";

const COLORS = ["#d6452b", "#f2b134", "#3a9d5d", "#3d7bd9", "#a257c9"];

/** One burst of paper from the element's middle, on a canvas laid over the page for a second. */
function burst(from: HTMLElement): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const box = from.getBoundingClientRect();
  const canvas = document.createElement("canvas");
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  canvas.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:1000";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;
  const bits = Array.from({ length: 60 }, (_, i) => ({
    x: box.left + box.width / 2,
    y: box.top + box.height / 2,
    vx: (Math.random() - 0.5) * 9,
    vy: -Math.random() * 9 - 3,
    color: COLORS[i % COLORS.length]!,
  }));
  const started = performance.now();
  const frame = (now: number) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const bit of bits) {
      bit.x += bit.vx;
      bit.y += bit.vy;
      bit.vy += 0.35;
      ctx.fillStyle = bit.color;
      ctx.fillRect(bit.x, bit.y, 6, 4);
    }
    if (now - started < 1200) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

/**
 * The client half of the `confetti` attribute, as a module (see
 * attributes.tsx): imported when a visitor first points at, presses or
 * focuses an element that has it, so it's in before the click.
 */
const confetti: AttributeSetup = (el) => {
  const onClick = () => burst(el);
  el.addEventListener("click", onClick);
  el.setAttribute("data-confetti-ready", "");
  return () => el.removeEventListener("click", onClick);
};

export default confetti;
