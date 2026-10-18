import { Local, Region, eq, island, not, type Action, type ActionValue, type Child } from "@toyz/yerd";
import { Price } from "./attributes.js";
import { CATEGORIES, imageUrl, slideCount, slideLabel, type Product } from "./catalog.js";
import type { SparklineProps } from "./widgets/sparkline.client.js";

/**
 * An island: the dashboard's sales sparkline, drawn on a canvas by
 * widgets/sparkline.client.ts once it scrolls into view. The props type is
 * the module's own, so what the server passes is checked.
 */
export const Sparkline = island<SparklineProps>("src/widgets/sparkline.client.ts", { when: "visible" });

/**
 * Product art: lazy, async-decoded, with a srcset so small screens fetch the
 * small one. width/height keep the grid from jumping while images arrive.
 */
export function ProductImage({ product, width = 320, eager = false }: { product: Product; width?: number; eager?: boolean }) {
  return (
    <img
      class="product-img"
      src={imageUrl(product, width)}
      srcset={`${imageUrl(product, width)} 1x, ${imageUrl(product, width * 2)} 2x`}
      alt={product.name}
      width={width}
      height={Math.round(width * 0.75)}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      fetchpriority={eager ? "high" : undefined}
    />
  );
}

/**
 * A favourite toggle that never talks to the server: <Local> state, saved in
 * localStorage per product (`persist`). The class flag and aria-pressed are
 * bound to the state, so they follow it in the browser.
 */
export function Heart({ product }: { product: Product }) {
  return (
    <Local state={{ fav: false }} persist={`fav:${product.id}`}>
      {(s) => (
        <button type="button" class={["heart", { on: s.fav }]} aria-pressed={s.fav} aria-label={`Favourite ${product.name}`} onClick={() => (s.fav = !s.fav)}>
          <span aria-hidden="true">&#9829;</span>
        </button>
      )}
    </Local>
  );
}

export function Stock({ stock }: { stock: number }) {
  if (stock === 0) return <span class="stock out">Sold out</span>;
  if (stock < 3) return <span class="stock low">Only {stock} left</span>;
  return <span class="stock">{stock} in stock</span>;
}

/** One product in the grid. `key` lets appended pages update rows already on the page in place. */
export function ProductCard({ product, addToCart }: { product: Product; addToCart: Action<{ id: string }> }) {
  return (
    <li key={product.id} class="product">
      <a class="product-link" href={`/products/${product.slug}`} prefetch>
        <ProductImage product={product} />
        <span class="product-name">{product.name}</span>
      </a>
      <Heart product={product} />
      <div class="product-meta">
        <Price cents={product.priceCents} />
        <span class="category">{CATEGORIES[product.category].name}</span>
        <Stock stock={product.stock} />
      </div>
      {/* An action lambda: the call is recorded and signed into the form, not run while rendering. */}
      <form class="add-form" action={() => addToCart({ id: product.id })}>
        <button class="btn btn-small" disabled={product.stock === 0}>Add to cart</button>
      </form>
    </li>
  );
}

/** The grid. A Region: the typeahead replaces it, infinite scroll appends to it (`append`). */
export function ProductGrid({ products, addToCart, append = false }: { products: Product[]; addToCart: Action<{ id: string }>; append?: boolean }) {
  return (
    <Region id="products" as="ul" class="grid" append={append} aria-label="Products">
      {products.map((product) => <ProductCard product={product} addToCart={addToCart} />)}
    </Region>
  );
}

/**
 * The infinite-scroll sentinel: a form whose action fires when it scrolls into
 * view (`trigger="visible"`). Each response sends a new sentinel with the next
 * page's action, which arms it again. Without JavaScript it's a button.
 */
export function More({ next, left }: { next: ActionValue | undefined; left: number }) {
  return (
    <Region id="more" class="more">
      {next ? (
        <form action={next} trigger="visible">
          <button class="btn btn-ghost">Show more ({left} left)</button>
        </form>
      ) : (
        <p class="end">That's the whole shelf.</p>
      )}
    </Region>
  );
}

export function ResultCount({ total, q }: { total: number; q: string }) {
  return (
    <Region id="result-count" as="p" class="meta-line" aria-live="polite">
      {total === 0 ? `Nothing matches "${q}". Try "gnome".` : `${total} item${total === 1 ? "" : "s"}${q ? ` matching "${q}"` : ""}`}
    </Region>
  );
}

/** A note after an action ("Added to cart"). A Region, so actions can fill it. */
export function Toast({ message }: { message?: string }) {
  return (
    <Region id="toast" class="toast" role="status" hidden={!message}>
      {message}
    </Region>
  );
}

/** A collapsible panel whose open state lives in the browser only, remembered per tab (sessionStorage). */
export function Collapsible({ id, title, children }: { id: string; title: string; children?: Child }) {
  return (
    <Local state={{ open: true }} persist={{ key: `panel:${id}`, storage: "session" }}>
      {(s) => (
        <section class={{ collapsible: true, closed: not(s.open) }}>
          <button type="button" class="collapsible-head" aria-expanded={s.open} onClick={() => (s.open = !s.open)}>
            {title}
          </button>
          <div class="collapsible-body" hidden={not(s.open)}>
            {children}
          </div>
        </section>
      )}
    </Local>
  );
}

/** One slide: the image at display size (and twice that for sharp screens), its full size, and a thumbnail. */
export interface Slide {
  src: string;
  src2x?: string;
  full: string;
  thumb: string;
  alt: string;
}

/**
 * An image slider, all in the browser: <Local> state holds the current
 * slide and the count (handlers are sent as text, so they can't see
 * `slides` from here), and `eq(s.i, n)` keeps each slide's `hidden` and each
 * thumbnail's `active` flag in step with it. Previous and next wrap;
 * thumbnails carry their index in data-n; the arrow keys work once the
 * slider has focus. Without JavaScript the first slide shows, and the
 * thumbnails are links to the full-size images.
 */
export function PhotoSlider({ slides, label, width = 480, eager = false }: { slides: Slide[]; label: string; width?: number; eager?: boolean }) {
  const height = Math.round(width * 0.75);
  return (
    <Local state={{ i: 0, n: slides.length }}>
      {(s) => (
        <div
          class="slider"
          tabindex={0}
          aria-roledescription="carousel"
          aria-label={label}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "ArrowRight") s.i = (s.i + 1) % s.n;
            else if (e.key === "ArrowLeft") s.i = (s.i + s.n - 1) % s.n;
          }}
        >
          <div class="slides">
            {slides.map((slide, n) => (
              <img
                class="product-img slide"
                src={slide.src}
                srcset={slide.src2x ? `${slide.src} 1x, ${slide.src2x} 2x` : undefined}
                alt={slide.alt}
                width={width}
                height={height}
                // On a product page the first slide is what the page is about: fetch it first. The rest wait until shown.
                loading={eager && n === 0 ? "eager" : "lazy"}
                fetchpriority={eager && n === 0 ? "high" : undefined}
                decoding="async"
                hidden={not(eq(s.i, n))}
              />
            ))}
            {slides.length > 1 ? (
              <>
                <button type="button" class="slide-nav prev" aria-label="Previous photo" onClick={() => (s.i = (s.i + s.n - 1) % s.n)}>&#8249;</button>
                <button type="button" class="slide-nav next" aria-label="Next photo" onClick={() => (s.i = (s.i + 1) % s.n)}>&#8250;</button>
              </>
            ) : null}
          </div>
          {slides.length > 1 ? (
            <div class="thumbs">
              {slides.map((slide, n) => (
                <a
                  href={slide.full}
                  class={["thumb", { active: eq(s.i, n) }]}
                  aria-current={eq(s.i, n)}
                  aria-label={`Show ${slide.alt}`}
                  data-n={n}
                  onClick={(e: Event) => {
                    e.preventDefault();
                    s.i = Number((e.currentTarget as HTMLElement).dataset.n);
                  }}
                >
                  <img src={slide.thumb} alt="" width={96} height={72} loading="lazy" decoding="async" />
                </a>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </Local>
  );
}

/** The product page's gallery: three views of the drawing, or the uploaded photos. */
export function ProductSlider({ product }: { product: Product }) {
  const slides = Array.from({ length: slideCount(product) }, (_, n) => ({
    src: imageUrl(product, 480, n),
    src2x: imageUrl(product, 960, n),
    full: imageUrl(product, 960, n),
    thumb: imageUrl(product, 160, n),
    alt: `${product.name}, ${slideLabel(product, n)}`,
  }));
  return <PhotoSlider slides={slides} label={`Photos of ${product.name}`} eager />;
}
