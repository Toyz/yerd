import type { AttributeSetup } from "@toyz/yerd/client";

/** Disconnects, counted on window for the tests. */
function disconnected(): void {
  const w = window as unknown as { __badgeDisconnects?: number };
  w.__badgeDisconnects = (w.__badgeDisconnects ?? 0) + 1;
}

/** The fx-badge attribute's client half, as a module: shows the value in data-badge and follows changes. */
const badge: AttributeSetup = (el, value) => {
  el.setAttribute("data-badge", value);
  return {
    update(next) {
      el.setAttribute("data-badge", next);
    },
    disconnect() {
      el.removeAttribute("data-badge");
      disconnected();
    },
  };
};

export default badge;
