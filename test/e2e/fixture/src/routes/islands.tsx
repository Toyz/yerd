import { Region, action, get, island, route, type Action } from "@toyz/yerd";
import type { ProbeProps } from "../probe.client.js";

const PROBE = "src/probe.client.ts";
const Probe = island<ProbeProps>(PROBE, { when: "load" });

/** An island inside a Region, with buttons that send it back with the same props or new ones. */
function Boxed({ n, same, next }: { n: number; same: Action<{ n: number }>; next: Action<{ n: number }> }) {
  return (
    <Region id="boxed">
      <Probe id="island-boxed" props={{ name: "boxed", n }} />
      <button action={() => same({ n })}>Same props</button> <button action={() => next({ n: n + 1 })}>New props</button>
    </Region>
  );
}

/**
 * Islands with each trigger, and one in a Region: morphs keep a mounted
 * island while its props stay the same and remount it (cleanup first) when
 * they change.
 */
@route("/islands", { meta: { title: "Islands" } })
export class IslandsPage {
  @get page() {
    return (
      <>
        <h1>Islands</h1>
        <Probe id="island-load" props={{ name: "load" }}>
          <span>Waiting for load</span>
        </Probe>
        <p>
          <Probe id="island-idle" when="idle" props={{ name: "idle" }}>
            <span>Waiting for idle</span>
          </Probe>
        </p>
        <p>
          <Probe id="island-interaction" when="interaction" props={{ name: "interaction" }} tabindex="0">
            <span>Point at me</span>
          </Probe>
        </p>
        <p>
          <Probe id="island-media" when="media:(min-width: 1400px)" props={{ name: "media" }}>
            <span>Waiting for a wide screen</span>
          </Probe>
        </p>
        <Boxed n={1} same={this.same} next={this.next} />
        <div class="spacer"></div>
        <Probe id="island-visible" when="visible" props={{ name: "visible" }}>
          <span>Waiting to be seen</span>
        </Probe>
      </>
    );
  }

  @action same({ n }: { n: number }) {
    return <Boxed n={n} same={this.same} next={this.next} />;
  }

  @action next({ n }: { n: number }) {
    return <Boxed n={n} same={this.same} next={this.next} />;
  }
}
