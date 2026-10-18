/// <reference types="vite/client" />
import { createApp } from "./app.js";

// Vite entry: the plugin mounts this app on the dev server.
export default createApp().discover(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
