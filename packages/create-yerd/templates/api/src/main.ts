/// <reference types="vite/client" />
import { createApp } from "./app.js";

// The Vite entry. The plugin serves it in dev and the build's server.js listens: no listen() here.
export default createApp().discover(import.meta.glob("./routes/**/*.ts", { eager: true }));
