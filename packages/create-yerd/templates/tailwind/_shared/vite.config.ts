import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import yerd from "@toyz/yerd/vite";

export default defineConfig({
  // Tailwind builds src/styles.css; `client` makes `vite build` hash it for <Stylesheet>.
  plugins: [tailwindcss(), yerd({ entry: "/src/main.ts", client: ["src/styles.css"] })],
});
