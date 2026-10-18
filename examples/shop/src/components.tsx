import { island } from "@toyz/yerd";
import { formatPrice, type Product } from "./catalog.js";
import type { RecentProps } from "./recent.client.js";

export function Price({ cents }: { cents: number }) {
  return <span class="price">{formatPrice(cents)}</span>;
}

export function ProductCard({ product }: { product: Product }) {
  return (
    <li class="card">
      <a href={`/products/${product.id}`}>{product.name}</a>
      <Price cents={product.price} />
      {product.stock === 0 ? <span class="sold-out">Sold out</span> : null}
    </li>
  );
}

/**
 * A labelled input with its error box. The runtime writes a failed field's
 * message into [data-yx-error="<name>"]; a plain form post gets the same
 * message from the server, via `error`.
 */
export function Field(props: { name: string; label: string; type?: string; value?: string | undefined; error?: string | undefined; autocomplete?: string }) {
  const { name, label, type = "text", value, error, autocomplete } = props;
  return (
    <p class="field">
      <label for={name}>{label}</label>
      <input id={name} name={name} type={type} value={value} autocomplete={autocomplete} aria-invalid={error ? true : undefined} />
      <span class="field-error" data-yx-error={name}>{error}</span>
    </p>
  );
}

/**
 * "Recently viewed" on the product page: an island, mounted by
 * src/recent.client.ts once the browser is idle. The type-only import keeps
 * the client module out of the server.
 */
export const RecentlyViewed = island<RecentProps>("src/recent.client.ts", { when: "idle" });
