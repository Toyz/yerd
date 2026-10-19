import { Region, Unauthorized, action, get, route, session, type Session } from "@toyz/yerd";

class Visit {
  name = "";
}

let visitors = 0;

/**
 * Token rebinding: the page is rendered for a visitor with no session, so
 * its action tokens are unbound. Starting the session (an action) makes them
 * stale; the runtime fetches the page quietly and swaps in bound tokens, so
 * the next click just works.
 */
@route("/session", { meta: { title: "Session" } })
export class SessionPage {
  @session(Visit) accessor visit!: Session<Visit>;

  @get page() {
    return (
      <>
        <h1>Session</h1>
        <form action={this.start}>
          <button>Start a session</button>
        </form>
        <Region id="who" as="p">
          {this.visit.name ? `Signed in as ${this.visit.name}` : "No session yet"}
        </Region>
        <form action={this.greet} id="greet-form">
          <button>Greet me</button>
        </form>
        <button id="greet-element" action={this.greet}>
          Greet me from a button
        </button>
        <Region id="greeting" as="p" />
      </>
    );
  }

  @action start() {
    this.visit.name = `visitor ${++visitors}`;
    return (
      <Region id="who" as="p">
        Signed in as {this.visit.name}
      </Region>
    );
  }

  @action greet() {
    if (!this.visit.name) throw new Unauthorized("Start a session first");
    return (
      <Region id="greeting" as="p">
        Hello, {this.visit.name}
      </Region>
    );
  }
}
