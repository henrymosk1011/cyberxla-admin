import { defineConfig, loadEnv, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

// Security headers for Cloudflare Pages, generated at build time so the
// Content-Security-Policy names the exact Supabase project and nothing else.
function securityHeaders(supabaseUrl: string): Plugin {
  const connect = ["'self'"];
  if (supabaseUrl) {
    const u = new URL(supabaseUrl);
    if (u.protocol !== "https:") throw new Error("VITE_SUPABASE_URL must be https");
    connect.push(`https://${u.host}`, `wss://${u.host}`);
  }
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
  const headers = `/*
  Content-Security-Policy: ${csp}
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
  Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()
  X-Robots-Tag: noindex, nofollow, noarchive
  Cache-Control: no-store

/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;
  return {
    name: "security-headers",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: headers });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const demo = mode === "demo";
  if (!demo && process.env.npm_lifecycle_event === "build" && (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_PUBLISHABLE_KEY)) {
    throw new Error("Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (see dashboard/.env.example)");
  }
  return {
    plugins: [svelte(), securityHeaders(demo ? "" : env.VITE_SUPABASE_URL ?? "")],
    resolve: {
      alias: {
        // Demo mode swaps the real Supabase layer for sample data. The demo
        // module is never part of a production build.
        $db: fileURLToPath(new URL(demo ? "./src/lib/db.demo.ts" : "./src/lib/db.ts", import.meta.url)),
      },
    },
    build: { sourcemap: false, target: "es2022", assetsInlineLimit: 0 },
    // The catalog lives with the quote function (../supabase/functions), one level up.
    server: { port: 5173, strictPort: true, fs: { allow: [".."] } },
  };
});
