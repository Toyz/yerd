import { Cues, Region, action, css, get, inject, keyframes, route, type Action } from "@toyz/yerd";
import { auth, type User } from "../users.js";
import { Shop } from "./shop.js";

/** Every rave page listens to this room; cues for other rooms never reach it. */
const ROOM = "rave";

// ── the looks: scoped css``, all keyed off `sync` and `data-yx-cued` ──

const bob = keyframes`
  0%, 100% { transform: translateY(0) rotate(-8deg); }
  50% { transform: translateY(-14px) rotate(8deg); }
`;
const hue = keyframes`to { filter: hue-rotate(360deg); }`;
const jump = keyframes`
  0% { transform: scale(1); }
  25% { transform: scale(1.4) rotate(-14deg); }
  50% { transform: scale(0.85) rotate(10deg); }
  100% { transform: scale(1); }
`;
const flash = keyframes`from { opacity: 0.85; } to { opacity: 0; }`;
const strobe = keyframes`50% { opacity: 0.35; }`;
const spin = keyframes`to { transform: rotate(360deg); }`;
const count = keyframes`
  0% { content: "3"; }
  33% { content: "2"; }
  66%, 100% { content: "1"; }
`;

const floor = css`
  position: relative;
  overflow: hidden;
  border-radius: 16px;
  padding: 28px 20px;
  /* The lights, on a layer of their own so the hue shift leaves the gnomes their colours. */
  &::before {
    content: "";
    position: absolute;
    inset: 0;
    background: conic-gradient(from 45deg, #d6452b, #f2b134, #6fae5a, #3a7bd5, #9b59b6, #d6452b);
    animation: ${hue} 8s linear infinite;
  }
  /* The drop: a strobe over the floor while it lasts. Inside the sync'd floor, so it strobes in step too. */
  &::after {
    content: "";
    position: absolute;
    inset: 0;
    background: white;
    opacity: 0;
    pointer-events: none;
  }
  &[data-yx-cued="drop"]::after { animation: ${strobe} 240ms steps(1) infinite; }
`;
const crowd = css`
  position: relative;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
  gap: 14px;
  justify-items: center;
`;
const gnome = css`
  width: 56px;
  animation: ${bob} 700ms ease-in-out infinite;
  /* A stagger: with sync, the delay is an offset from everyone's shared beat. */
  &:nth-child(odd) { animation-delay: -350ms; }
  & svg { display: block; width: 100%; height: auto; }
  [data-yx-cued="airhorn"] & svg { animation: ${jump} 600ms ease-out; }
  [data-yx-cued="drop"] & svg { animation: ${spin} 500ms linear 8; }
`;
const flashLayer = css`
  position: absolute;
  inset: 0;
  background: #fff4d6;
  opacity: 0;
  pointer-events: none;
  &[data-yx-cued] { animation: ${flash} 500ms ease-out; }
`;
const countdown = css`
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
  font: 800 6rem/1 system-ui, sans-serif;
  color: white;
  text-shadow: 0 4px 20px #0008;
  &[data-yx-cued]::before { content: ""; animation: ${count} 2500ms steps(1) forwards; }
`;
const controls = css`
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin: 16px 0;
`;

/** A gnome, drawn inline (the hat takes the colour). */
function Gnome({ hat }: { hat: string }) {
  return (
    <div class={gnome}>
      <svg viewBox="0 0 40 60" aria-hidden="true">
        <path d="M20 0 36 30H4Z" fill={hat} />
        <circle cx="20" cy="33" r="8" fill="#f5c9a5" />
        <path d="M10 36q10 22 20 0q-4 8-10 8t-10-8Z" fill="#f4f1ea" />
        <rect x="9" y="46" width="22" height="12" rx="4" fill="#3a7bd5" />
      </svg>
    </div>
  );
}

const HATS = ["#d6452b", "#9b59b6", "#f2b134", "#3a7bd5", "#6fae5a", "#e84393"];

/** How many tabs are raving, polled: the Region carries its own action and trigger. */
function Ravers({ count, poll }: { count: number; poll: Action }) {
  return (
    <Region id="ravers" as="p" class="muted" action={poll} trigger="every 5s">
      {count} {count === 1 ? "tab" : "tabs"} raving on this server
    </Region>
  );
}

/**
 * Server-synced animation. Every tab's gnomes bob on the same beat (`sync`
 * lines looping animations up against the server's clock), and the buttons
 * play cues: the server picks a moment a little ahead and every open page
 * plays it then, together. Open it in two windows side by side.
 */
@route("/rave", { group: Shop, meta: { title: "Gnome rave", area: "rave" } })
export class Rave {
  @inject(Cues) accessor cues!: Cues;
  @auth.maybeUser accessor me: User | undefined;

  get #who() {
    return this.me?.name ?? "a guest";
  }

  @get page() {
    return (
      <>
        <h1 class="page-title">Gnome rave</h1>
        <p class="meta-line">
          Open this page in two windows. The gnomes dance on one beat everywhere, and the horn goes off on every screen at once. Sound starts once you've clicked anywhere on the page.
        </p>
        <div class={floor} sync cue="drop" cueRoom={ROOM}>
          <div class={crowd} cue={["airhorn", "drop"]} cueRoom={ROOM}>
            {Array.from({ length: 18 }, (_, i) => <Gnome hat={HATS[i % HATS.length]!} />)}
          </div>
          <div class={flashLayer} cue="airhorn" cueRoom={ROOM} aria-hidden="true" />
          <div class={countdown} cue="countdown" cueRoom={ROOM} aria-hidden="true" />
        </div>
        <div class={controls}>
          <button class="btn" action={this.airhorn}>Airhorn</button>
          <button class="btn btn-ghost" action={this.drop}>Drop the beat</button>
          <span class="muted small" horn cue={["airhorn", "drop"]} cueRoom={ROOM} aria-live="polite"></span>
        </div>
        <Ravers count={this.cues.watching(ROOM)} poll={this.ravers} />
      </>
    );
  }

  /** At most one horn per 700ms however hard the room mashes it; late joiners within 1.2s see it partway. */
  @action async airhorn() {
    await this.cues.play("airhorn", { room: ROOM, lasts: 1200, cooldown: 700, data: { who: this.#who } });
  }

  /** A countdown now, and the drop when it reaches zero: two cues, one timeline. */
  @action async drop() {
    const counting = await this.cues.play("countdown", { room: ROOM, lasts: 2500, cooldown: 7000 });
    if (counting) await this.cues.play("drop", { room: ROOM, in: 2750, lasts: 4000, data: { who: this.#who } });
  }

  @action ravers() {
    return <Ravers count={this.cues.watching(ROOM)} poll={this.ravers} />;
  }
}
