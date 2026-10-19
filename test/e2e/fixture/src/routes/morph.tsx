import { Region, action, get, route } from "@toyz/yerd";

// Bumped on every render, so a test can tell the panel was morphed.
let renders = 0;

/**
 * Morphing: a refresh re-renders the panel on the server and patches it into
 * the page. What the visitor did to it (focus, caret, typed text, an open
 * <details>) has to survive; what only the server changed has to show.
 */
@route("/morph", { meta: { title: "Morph" } })
export class MorphPage {
  @get page() {
    return (
      <>
        <h1>Morph</h1>
        {this.panel()}
        <button action={this.refresh}>Refresh the panel</button>
      </>
    );
  }

  panel() {
    renders++;
    return (
      <Region id="panel" as="section" aria-label="Panel">
        <p id="renders">Render {renders}</p>
        <p>
          <label for="typed">Typed</label> <input id="typed" name="typed" value="server text" />
        </p>
        <p>
          <label for="notes">Notes</label> <textarea id="notes" name="notes">server notes</textarea>
        </p>
        <p>
          <label for="mirror">Mirror</label> <input id="mirror" name="mirror" value={`server ${renders}`} />
        </p>
        <details id="more">
          <summary>More</summary>
          <p>Hidden until opened.</p>
        </details>
        <div id="kept" data-yx-keep>
          Server content
        </div>
      </Region>
    );
  }

  /** Returns the panel again: it morphs in over the old one. */
  @action refresh() {
    return this.panel();
  }
}
