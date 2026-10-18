import { describe, expect, it } from "vitest";
import { renderToString } from "@toyz/yerd";

describe("images and media", () => {
  it("render lazy, responsive images with every loading hint", async () => {
    const html = await renderToString(
      <img src="/cat.jpg" alt="A cat" width={640} height={480} loading="lazy" decoding="async" fetchpriority="low"
        srcset="/cat-640.jpg 640w, /cat-1280.jpg 1280w" sizes="(max-width: 700px) 100vw, 640px" />,
    );
    expect(html).toBe(
      '<img src="/cat.jpg" alt="A cat" width="640" height="480" loading="lazy" decoding="async" fetchpriority="low" srcset="/cat-640.jpg 640w, /cat-1280.jpg 1280w" sizes="(max-width: 700px) 100vw, 640px">',
    );
  });

  it("render <picture> sources, lazy iframes and video", async () => {
    const html = await renderToString(
      <>
        <picture>
          <source type="image/avif" srcset="/cat.avif" />
          <source media="(min-width: 800px)" srcset="/cat-wide.jpg" />
          <img src="/cat.jpg" alt="" loading="lazy" />
        </picture>
        <iframe src="https://example.com/embed" title="Embed" loading="lazy" />
        <video src="/clip.mp4" poster="/clip.jpg" preload="none" controls muted playsinline />
      </>,
    );
    expect(html).toBe(
      '<picture><source type="image/avif" srcset="/cat.avif"><source media="(min-width: 800px)" srcset="/cat-wide.jpg"><img src="/cat.jpg" alt="" loading="lazy"></picture>' +
        '<iframe src="https://example.com/embed" title="Embed" loading="lazy"></iframe>' +
        '<video src="/clip.mp4" poster="/clip.jpg" preload="none" controls muted playsinline></video>',
    );
  });

  it("escape image URLs and alt text", async () => {
    expect(await renderToString(<img src={'/x.jpg?a=1&b="2"'} alt={"<b>"} />)).toBe('<img src="/x.jpg?a=1&amp;b=&quot;2&quot;" alt="&lt;b&gt;">');
  });

  it("refuse children on <img>", async () => {
    // @ts-expect-error img is a void element
    await expect(renderToString(<img src="/x.jpg">caption</img>)).rejects.toThrow(/void element/);
  });
});
