/**
 * yerd docs: built with @toyz/loom. The API reference is generated from the
 * repository's source (scripts/generate.mjs), so the site always matches main.
 */
import "./styles.css";
// Custom attributes register before any component connects, so loom watches
// every component's shadow root for them.
import "./api-tip";
import { app } from "@toyz/loom";
import { LoomRouter } from "@toyz/loom/router";

import "./palette";
import "./app";
import "./pages/home";
import "./pages/guide";
import "./pages/api-index";
import "./pages/api-entry";
import "./pages/benchmarks";
import "./pages/not-found";

app.use(new LoomRouter({ mode: "hash" }));
app.start();
