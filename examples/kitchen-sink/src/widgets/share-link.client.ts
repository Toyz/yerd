/**
 * A lazy custom element (see lazyElement() in attributes.tsx): <share-link>
 * opens the system share sheet where there is one and copies the link
 * otherwise. The server renders a plain link inside it, which stays until
 * this module defines the element.
 */
class ShareLink extends HTMLElement {
  connectedCallback() {
    const url = this.getAttribute("url") ?? location.href;
    const title = this.getAttribute("name") ?? document.title;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-ghost btn-small";
    button.textContent = "Share";
    button.addEventListener("click", async () => {
      try {
        if (navigator.share) await navigator.share({ url, title });
        else {
          await navigator.clipboard.writeText(url);
          button.textContent = "Link copied";
          setTimeout(() => (button.textContent = "Share"), 2000);
        }
      } catch {
        // Cancelled the share sheet, or no clipboard access: nothing to do.
      }
    });
    this.replaceChildren(button);
  }
}

customElements.define("share-link", ShareLink);
