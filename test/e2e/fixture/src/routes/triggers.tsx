import { Region, action, get, route, type Action, type ActionForm } from "@toyz/yerd";

const FRUIT = ["apple", "apricot", "banana", "blackberry", "blueberry", "cherry", "grape", "lemon", "lime", "mango", "melon", "peach", "pear", "plum"];

/** Each counter carries its next value in its action's arguments, so the server keeps no state. */
function Clicks({ n, click }: { n: number; click: Action<{ n: number }> }) {
  return (
    <Region id="clicks" as="p">
      <button action={() => click({ n: n + 1 })}>Clicked {n} times</button>
    </Region>
  );
}

function Ticks({ n, tick }: { n: number; tick: Action<{ n: number }> }) {
  // Three ticks, then the response drops the trigger and the poll stops itself.
  return n < 3 ? (
    <Region id="ticks" as="p" action={() => tick({ n: n + 1 })} trigger="every 300ms">
      Ticks {n}
    </Region>
  ) : (
    <Region id="ticks" as="p">
      Ticks {n}, done
    </Region>
  );
}

/**
 * Element actions and their triggers: click, a filtered key, a debounced
 * input (typeahead), visible, every, load and change, plus nesting.
 */
@route("/triggers", { meta: { title: "Triggers" } })
export class TriggersPage {
  @get page() {
    return (
      <>
        <h1>Triggers</h1>
        <Clicks n={0} click={this.click} />

        <p>
          <label for="note">Note</label>{" "}
          <input id="note" name="note" autocomplete="off" action={({ el }) => this.note({ text: el.value })} trigger="keydown:Enter" />
        </p>
        <Region id="notes" as="ul" />

        <p>
          <label for="search">Search fruit</label>{" "}
          <input id="search" type="search" autocomplete="off" action={({ el }) => this.search({ q: el.value })} trigger="input 300ms" />
        </p>
        {this.results("")}

        <p>
          <label for="size">Size</label>{" "}
          <select id="size" name="size" action={this.size} trigger="change">
            <option value="s">Small</option>
            <option value="m">Medium</option>
            <option value="l">Large</option>
          </select>
        </p>
        <Region id="picked" as="p">
          Picked nothing yet
        </Region>

        <div class="card" action={() => this.nested({ which: "card" })}>
          <p>A card that has its own action.</p>
          <button action={() => this.nested({ which: "button" })}>Inner button</button>
        </div>
        <Region id="nested" as="p" />

        <Ticks n={0} tick={this.tick} />

        <Region id="panel" action={this.panel} trigger="load">
          <p>Loading the panel...</p>
        </Region>

        <div class="spacer"></div>
        <Region id="seen" action={this.seen} trigger="visible">
          <p>Not seen yet</p>
        </Region>
      </>
    );
  }

  results(q: string) {
    const found = q ? FRUIT.filter((f) => f.startsWith(q.toLowerCase())) : [];
    return (
      <Region id="results" as="ul" aria-live="polite" data-q={q}>
        {found.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </Region>
    );
  }

  @action click({ n }: { n: number }) {
    return <Clicks n={n} click={this.click} />;
  }

  @action note({ text }: { text: string }) {
    return (
      <Region id="notes" as="ul" append>
        <li>{text}</li>
      </Region>
    );
  }

  @action search({ q }: { q: string }) {
    return this.results(q);
  }

  @action size(_: {}, form: ActionForm) {
    return (
      <Region id="picked" as="p">
        Picked {form.string("size")}
      </Region>
    );
  }

  @action nested({ which }: { which: string }) {
    return (
      <Region id="nested" as="p">
        Fired by the {which}
      </Region>
    );
  }

  @action tick({ n }: { n: number }) {
    return <Ticks n={n} tick={this.tick} />;
  }

  @action panel() {
    return (
      <Region id="panel">
        <p>The panel loaded</p>
      </Region>
    );
  }

  @action seen() {
    return (
      <Region id="seen">
        <p>Seen</p>
      </Region>
    );
  }
}
