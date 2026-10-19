import { defineConfig } from "vite";
import yerd from "@toyz/yerd/vite";

export default defineConfig({
  // `client`: files `vite build` hashes; <Stylesheet> links them through the manifest.
  plugins: [yerd({ entry: "/src/main.ts", client: ["src/styles.css"] })],
});
