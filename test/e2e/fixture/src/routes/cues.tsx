import { BadRequest, Cues, action, css, get, inject, keyframes, query, route } from "@toyz/yerd";

const spin = keyframes`to { transform: rotate(360deg); }`;
const spinner = css`
  display: inline-block;
  width: 2rem;
  height: 2rem;
  background: #0b57d0;
  animation: ${spin} 1s linear infinite;
`;

/** fx-<anything>: public rooms (see main.ts). Each test picks its own. */
function checkRoom(room: string): string {
  if (!/^fx-[\w-]{1,40}$/.test(room)) throw new BadRequest("room must look like fx-<name>");
  return room;
}

/**
 * Cues and sync: a `sync` animation on the server's clock, and a cue that
 * plays on every page listening to the room at the same moment.
 */
@route("/cues", { meta: { title: "Cues" } })
export class CuesPage {
  @inject(Cues) accessor cues!: Cues;
  @query("room") accessor room = "fx-main";

  @get page() {
    const room = checkRoom(this.room);
    return (
      <>
        <h1>Cues</h1>
        <div id="spinner" class={spinner} sync aria-hidden="true"></div>
        <p id="beacon" cue="ping" cueRoom={room}>
          Beacon
        </p>
        <button action={this.ping}>Ping every page</button>
      </>
    );
  }

  @action async ping() {
    await this.cues.play("ping", { room: checkRoom(this.room), lasts: 1500, data: { from: "fixture" } });
  }
}

/** How many pages listen to a room: the tests wait for every page to be connected before playing. */
@route("/cues/watching", { session: false })
export class CuesWatching {
  @inject(Cues) accessor cues!: Cues;
  @query("room") accessor room = "fx-main";

  @get count() {
    return { watching: this.cues.watching(checkRoom(this.room)) };
  }
}
