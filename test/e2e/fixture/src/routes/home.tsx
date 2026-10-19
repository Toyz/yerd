import { get, route } from "@toyz/yerd";

@route("/")
export class Home {
  @get page() {
    return (
      <>
        <h1>yerd runtime fixture</h1>
        <p>One page per client runtime feature, for the end-to-end tests. The links above lead to each.</p>
      </>
    );
  }
}
