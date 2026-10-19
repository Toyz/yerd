import { NotFound, get, param, route, setMeta } from "@toyz/yerd";

const TITLES: Record<string, string> = { one: "Page one", two: "Page two", three: "Page three" };
// How often each page has been served: a fresh fetch shows a higher number.
const served = new Map<string, number>();

/**
 * Boosted navigation: tall pages linked from a data-yx-boost nav, so tests
 * can check history, scroll restoration and fragments. One link opts out.
 */
@route("/nav/:page")
export class NavPage {
  @param("page") accessor page!: string;

  @get show() {
    const title = TITLES[this.page];
    if (!title) throw new NotFound(`No page ${this.page}`);
    const count = (served.get(this.page) ?? 0) + 1;
    served.set(this.page, count);
    setMeta({ title });
    return (
      <>
        <h1>{title}</h1>
        <p id="served">Served {count}</p>
        <nav aria-label="Pages" data-yx-boost>
          <a href="/nav/one">To page one</a> <a href="/nav/two">To page two</a> <a href="/nav/three#target">To the target on page three</a>{" "}
          <a href="/nav/two" data-yx-boost="false">
            Page two, without boosting
          </a>
        </nav>
        <div class="spacer"></div>
        <h2 id="target">Target</h2>
        <p>
          <a href="/nav/one" data-yx-boost>
            Back to page one, from the bottom
          </a>{" "}
          <a href="/nav/two" data-yx-boost>
            On to page two, from the bottom
          </a>
        </p>
        <div class="spacer"></div>
      </>
    );
  }
}
