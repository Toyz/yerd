/**
 * yerd docs: built with @toyz/loom. The API reference is generated from the
 * repository's source (scripts/generate.mjs), so the site always matches main.
 */
import "./styles.css";
import { app } from "@toyz/loom";
import { LoomRouter } from "@toyz/loom/router";

import "./app";
import "./pages/home";
import "./pages/guide";
import "./pages/api-index";
import "./pages/api-entry";
import "./pages/not-found";

app.use(new LoomRouter({ mode: "hash" }));
app.start();
