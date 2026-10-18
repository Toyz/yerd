/// <reference types="vite/client" />
import { yerd } from "@toyz/yerd";
import { RootLayout } from "./layouts.js";

// Under Vite the plugin mounts this app; no listen() here.
export default yerd()
  .layout(RootLayout)
  .discover(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
