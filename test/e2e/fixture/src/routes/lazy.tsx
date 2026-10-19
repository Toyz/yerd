import { Region, action, get, route, type Action } from "@toyz/yerd";

function Greeting({ name, rename }: { name: string; rename: Action<{ name: string }> }) {
  return (
    <Region id="greeting-box">
      <fx-greeting id="greeting" name={name}>
        <span>Greeting loads when it scrolls into view</span>
      </fx-greeting>
      <button action={() => rename({ name: name === "Ada" ? "Grace" : "Ada" })}>Swap the name</button>
    </Region>
  );
}

function Badges({ label, show, set }: { label: string; show: boolean; set: Action<{ label: string; show: boolean }> }) {
  return (
    <Region id="badges">
      {show ? (
        <>
          <button id="badge-one" fx-badge={label}>
            First badged button
          </button>{" "}
          <span id="badge-two" fx-badge={label}>
            Second badged element
          </span>
        </>
      ) : (
        <p>No badges</p>
      )}
      <p>
        <button action={() => set({ label: "Updated", show: true })}>Update the badges</button>{" "}
        <button action={() => set({ label, show: false })}>Remove the badges</button>
      </p>
    </Region>
  );
}

/**
 * Lazy client modules other than islands: a custom element defined when its
 * tag scrolls into view, and an attribute whose client half is a module.
 */
@route("/lazy", { meta: { title: "Lazy modules" } })
export class LazyPage {
  @get page() {
    return (
      <>
        <h1>Lazy modules</h1>
        <Badges label="New" show set={this.badges} />
        <div class="spacer"></div>
        <Greeting name="Ada" rename={this.rename} />
      </>
    );
  }

  @action rename({ name }: { name: string }) {
    return <Greeting name={name} rename={this.rename} />;
  }

  @action badges({ label, show }: { label: string; show: boolean }) {
    return <Badges label={label} show={show} set={this.badges} />;
  }
}
