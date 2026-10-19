/**
 * <fx-greeting name="...">: a lazy custom element (see registry.ts). It owns
 * its children once defined; a morph only changes its attributes, which it
 * follows.
 */
class FxGreeting extends HTMLElement {
  static observedAttributes = ["name"];

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  render() {
    const strong = document.createElement("strong");
    strong.textContent = `Hello, ${this.getAttribute("name") ?? "stranger"}`;
    this.replaceChildren(strong);
  }
}

customElements.define("fx-greeting", FxGreeting);
