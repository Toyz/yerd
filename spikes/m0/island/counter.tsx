// M0 spike: one tsc-emitted file, imported by Node (exports "node" condition ->
// server twin) and by a browser (import map -> browser twin).

(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

import { island, side, registeredIslands } from "@toyz/yerd/client";
import type { YerdNode } from "@toyz/yerd/jsx-runtime";

@island
export class Counter {
  render(): YerdNode {
    return <button>rendered on the {side}</button>;
  }
}

export const report = {
  side,
  registered: [...registeredIslands().keys()],
  child: (new Counter().render().props.children as string[]).join(""),
};
