import { Region, action, get, route, type Action } from "@toyz/yerd";

function Item({ n, edited = false }: { n: number; edited?: boolean }) {
  return <li key={n}>{edited ? `Item ${n} (edited)` : `Item ${n}`}</li>;
}

function Older({ from, load }: { from: number; load: Action<{ from: number }> }) {
  return (
    <Region id="older" as="p">
      <button action={() => load({ from })}>Load older</button>
    </Region>
  );
}

function Newer({ before, load }: { before: number; load: Action<{ before: number }> }) {
  return (
    <Region id="newer" as="p">
      <button action={() => load({ before })}>Add newer</button>
    </Region>
  );
}

/**
 * Appending and prepending Regions: a response adds to the list instead of
 * replacing it, and an item that's already there (same key) is updated in place.
 */
@route("/regions", { meta: { title: "Regions" } })
export class RegionsPage {
  @get page() {
    return (
      <>
        <h1>Regions</h1>
        <Newer before={10} load={this.newer} />
        <Region id="feed" as="ul">
          <Item n={10} />
          <Item n={11} />
          <Item n={12} />
        </Region>
        <Older from={13} load={this.older} />
        <button action={this.edit}>Edit item 11</button>
      </>
    );
  }

  @action older({ from }: { from: number }) {
    return (
      <>
        <Region id="feed" as="ul" append>
          <Item n={from} />
          <Item n={from + 1} />
        </Region>
        <Older from={from + 2} load={this.older} />
      </>
    );
  }

  @action newer({ before }: { before: number }) {
    return (
      <>
        <Region id="feed" as="ul" prepend>
          <Item n={before - 1} />
        </Region>
        <Newer before={before - 1} load={this.newer} />
      </>
    );
  }

  /** An appending Region whose item is already on the page: morphed where it is, not added twice. */
  @action edit() {
    return (
      <Region id="feed" as="ul" append>
        <Item n={11} edited />
      </Region>
    );
  }
}
