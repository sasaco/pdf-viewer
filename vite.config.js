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
        coverage: {
            provider: "v8",
            include: ["src/markdown/**/*.js"],
            thresholds: {
                // convert.js の defaultLoadPdf エラーマッピング (PasswordException 等) は
                // pdfjs 内部依存のため単体テストし難く branches が低めに張り付く。
                // フェーズ2 で defaultLoadPdf を export するか integration テストで補強する想定。
                lines: 80,
                functions: 80,
                branches: 74,
                statements: 80,
            },
        },
    },
}));
