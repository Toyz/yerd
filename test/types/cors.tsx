// @cors option types: known header names and methods autocomplete, any other string is still accepted.
import { cors, type CorsMethod, type CorsRequestHeader, type CorsResponseHeader } from "@toyz/yerd";

cors({ origins: ["https://app.example"], headers: ["content-type", "authorization", "x-my-own"], expose: ["etag", "x-total-count", "x-custom"], methods: ["GET", "POST", "PROPFIND"] });

const header: CorsRequestHeader = "authorization";
const exposed: CorsResponseHeader = "location";
const method: CorsMethod = "PATCH";
void [header, exposed, method];

// @ts-expect-error a list of names, not one string
cors({ origins: ["https://app.example"], headers: "content-type" });
// @ts-expect-error header names are strings
cors({ origins: ["https://app.example"], expose: [42] });
