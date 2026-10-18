import { LoomElement, component } from "@toyz/loom";
import { route } from "@toyz/loom/router";

@route("*")
@component("page-not-found")
export class PageNotFound extends LoomElement {
  update() {
    return (
      <div>
        <h1>Not found</h1>
        <p>
          Nothing lives here. Try the <a href="#/">overview</a> or the <a href="#/api">API reference</a>.
        </p>
      </div>
    );
  }
}
