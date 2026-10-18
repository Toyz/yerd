/// <reference types="vite/client" />
import { createApp } from "./app.js";

// Vite entry: the plugin serves this app, so no listen() here.
export default createApp().discover(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
