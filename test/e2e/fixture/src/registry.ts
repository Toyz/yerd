import { attribute, lazyElement } from "@toyz/yerd";

declare module "@toyz/yerd" {
  interface CustomAttributes {
    /** A label the fx-badge module shows next to the element. */
    "fx-badge"?: string;
  }
}

/** <fx-greeting>: defined by its module once the tag scrolls into view. */
export const greeting = lazyElement("fx-greeting", "src/fx-greeting.client.ts", { when: "visible" });

/** fx-badge="text": the client half is a module, imported on the first interaction with any element carrying it. */
export const badge = attribute<string>("fx-badge", {
  client: "src/fx-badge.client.ts",
  when: "interaction",
});
