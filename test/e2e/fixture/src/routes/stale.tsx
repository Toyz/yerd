import { Region, action, get, route, type Action } from "@toyz/yerd";

function Counter({ n, bump }: { n: number; bump: Action<{ n: number }> }) {
  return (
    <Region id="counter">
      <form action={() => bump({ n: n + 1 })}>
        <button>Count up</button>
      </form>
      <button id="count-element" action={() => bump({ n: n + 1 })}>
        Count up from a button
      </button>
      <p id="count">Count {n}</p>
    </Region>
  );
}

/**
 * Stale pages and an unreachable server: the tests restart or stop the
 * server behind this page (see serve.ts) and click again.
 */
@route("/stale", { meta: { title: "Stale pages" } })
export class StalePage {
  @get page() {
    return (
      <>
        <h1>Stale pages</h1>
        <Counter n={0} bump={this.bump} />
      </>
    );
  }

  @action bump({ n }: { n: number }) {
    return <Counter n={n} bump={this.bump} />;
  }
}
