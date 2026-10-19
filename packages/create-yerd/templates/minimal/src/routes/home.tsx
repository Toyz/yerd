import { Region, action, get, route, session, type Session } from "@toyz/yerd";

/** What this page keeps in the visitor's session. No cookie until it changes. */
class Visit {
  clicks = 0;
}

/** The count, as a Region: the action sends back just this. */
function Clicks({ count }: { count: number }) {
  return (
    <Region id="clicks" as="p">
      Clicked {count} {count === 1 ? "time" : "times"}
    </Region>
  );
}

@route("/", { meta: { title: "Home" } })
export class Home {
  @session(Visit) accessor visit!: Session<Visit>;

  @get page() {
    return (
      <>
        <h1>Hello from yerd</h1>
        <p>
          Edit <code>src/routes/home.tsx</code> and save to see it change.
        </p>
        <Clicks count={this.visit.clicks} />
        {/* Posts without a reload when the runtime is loaded, as a plain form when it isn't. */}
        <form action={this.click}>
          <button>Click</button>
        </form>
        <p>
          <a href="https://toyz.github.io/yerd/">Read the guides</a>
        </p>
      </>
    );
  }

  @action click() {
    this.visit.clicks++;
    return <Clicks count={this.visit.clicks} />;
  }
}
