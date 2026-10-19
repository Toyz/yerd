import { Region, action, get, query, route, setMeta } from "@toyz/yerd";

let served = 0;

/**
 * Prefetching: boosted links warmed on intent (hover, focus, touch), when
 * they scroll into view, or right away. The runtime keeps the response and
 * answers the click with it.
 */
@route("/prefetch")
export class PrefetchPage {
  @get page() {
    setMeta({ title: "Prefetch" });
    return (
      <div data-yx-boost>
        <h1>Prefetch</h1>
        <p>
          <a href="/prefetch/target?via=intent" prefetch>
            Prefetched on intent
          </a>
        </p>
        <p>
          <a href="/prefetch/target?via=load" prefetch="load">
            Prefetched on load
          </a>
        </p>
        <button action={this.change}>Change something</button>
        <Region id="changed" as="p" />
        <div class="spacer"></div>
        <p>
          <a href="/prefetch/target?via=visible" prefetch="visible">
            Prefetched when visible
          </a>
        </p>
      </div>
    );
  }

  /** Any action empties the prefetch cache. */
  @action change() {
    return (
      <Region id="changed" as="p">
        Changed
      </Region>
    );
  }
}

@route("/prefetch/target")
export class PrefetchTarget {
  @query("via") accessor via = "";

  @get page() {
    served++;
    setMeta({ title: "Prefetch target" });
    return (
      <>
        <h1>Target via {this.via}</h1>
        <p id="served">Served {served}</p>
        <p data-yx-boost>
          <a href="/prefetch">Back to prefetch</a>
        </p>
      </>
    );
  }
}
