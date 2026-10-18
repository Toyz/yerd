// Compile-only: media types for @accepts and negotiate() are checked.
import { accepts, get, negotiate, route } from "@toyz/yerd";

@route("/typed-accepts")
export class TypedAccepts {
  @get page() {
    return negotiate({ html: () => "<p>hi</p>", "application/vnd.api+json": () => ({ ok: true }), csv: () => "a,b" });
  }

  @get @accepts("json", "application/ld+json", "application/vnd.yerd.v2+json") data() {
    return {};
  }

  // @ts-expect-error "jsno" is neither a shorthand nor type/subtype
  @get @accepts("jsno") typo() {
    return {};
  }

  // @ts-expect-error @accepts needs at least one type
  @get @accepts() empty() {
    return {};
  }

  wrongKey() {
    // @ts-expect-error "htm" isn't a media type
    return negotiate({ htm: () => "x" });
  }
}
