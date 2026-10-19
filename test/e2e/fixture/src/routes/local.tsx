import { Local, get, not, route } from "@toyz/yerd";

/**
 * <Local> state: handlers run in the browser against the scope's state and
 * the bindings follow. One scope persists to localStorage, and a second scope
 * shares its key.
 */
@route("/local", { meta: { title: "Local" } })
export class LocalPage {
  @get page() {
    return (
      <>
        <h1>Local</h1>
        <Local state={{ count: 0, open: false }}>
          {(s) => (
            <section aria-label="Counter">
              <button id="add" onClick={() => s.count++}>
                Add one
              </button>
              <p>
                Count: <output id="count">{s.count}</output>
              </p>
              <button id="toggle" onClick={() => (s.open = !s.open)} aria-expanded={s.open}>
                Toggle the secret
              </button>
              <p id="secret" hidden={not(s.open)}>
                The secret
              </p>
            </section>
          )}
        </Local>

        <Local state={{ likes: 0 }} persist="fx-likes">
          {(s) => (
            <p>
              <button id="like" onClick={() => s.likes++}>
                Like
              </button>{" "}
              Likes: <output id="likes">{s.likes}</output>
            </p>
          )}
        </Local>
        <Local state={{ likes: 0 }} persist="fx-likes">
          {(s) => (
            <p>
              Mirror: <output id="likes-mirror">{s.likes}</output>
            </p>
          )}
        </Local>

        <Local state={{ visited: false }} persist={{ key: "fx-visited", storage: "session" }}>
          {(s) => (
            <p>
              <a id="onward" href="/local/onward" onClick={() => (s.visited = true)}>
                Onward
              </a>
            </p>
          )}
        </Local>
      </>
    );
  }
}

@route("/local/onward", { meta: { title: "Onward" } })
export class LocalOnward {
  @get page() {
    return <h1>Onward</h1>;
  }
}
