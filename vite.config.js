import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
    root: "./src",
    build: {
        outDir: "../dist",
        emptyOutDir: true,
    },
    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
        host: host || false,
        hmr: host
            ? {
                protocol: "ws",
                host,
                port: 1421,
            }
            : undefined,
        watch: {
            ignored: ["**/src-tauri/**"],
        },
    },
    test: {
        root: ".",
        include: ["tests/**/*.test.{js,ts}"],
        environment: "jsdom",
        globals: true,
    },
}));
