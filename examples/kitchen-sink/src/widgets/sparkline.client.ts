import type { IslandMount } from "@toyz/yerd/client";

/** What the dashboard passes: sale totals in cents, oldest first. */
export interface SparklineProps {
  points: number[];
  label: string;
}

/**
 * An island: a canvas sparkline of recent sales, drawn in the browser. The
 * server renders the same numbers as text inside the island, shown until
 * this mounts (and to anyone without JavaScript).
 */
const mount: IslandMount<SparklineProps> = (el, { points, label }) => {
  const canvas = document.createElement("canvas");
  canvas.className = "sparkline";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", label);

  const draw = () => {
    const width = el.clientWidth || 320;
    const height = 64;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx || points.length < 2) return;
    ctx.scale(ratio, ratio);
    const max = Math.max(...points);
    const min = Math.min(...points);
    const x = (i: number) => (i / (points.length - 1)) * (width - 4) + 2;
    const y = (v: number) => height - 4 - ((v - min) / (max - min || 1)) * (height - 8);
    ctx.strokeStyle = getComputedStyle(el).getPropertyValue("--accent").trim() || "#d6452b";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    points.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
    ctx.stroke();
  };

  el.replaceChildren(canvas);
  draw();
  const resized = new ResizeObserver(draw);
  resized.observe(el);
  return () => resized.disconnect();
};

export default mount;
