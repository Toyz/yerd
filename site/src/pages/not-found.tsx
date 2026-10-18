import { LoomElement, component } from "@toyz/loom";
import { route } from "@toyz/loom/router";
import { PALETTE_HOTKEY } from "../palette";

@route("*")
@component("page-not-found")
export class PageNotFound extends LoomElement {
  update() {
    return (
      <div>
        <h1>Not found</h1>
        <p>
          Nothing grows at this address. Try the <a href="#/">home page</a>, the <a href="#/guide/getting-started">guides</a> or the <a href="#/api">API reference</a>, or search with {PALETTE_HOTKEY}.
        </p>
      </div>
    );
  }
}
