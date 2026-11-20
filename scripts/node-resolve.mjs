// Lets plain Node run lib/ code that Next bundles: "./x" finds "./x.ts", and "next/server" finds "next/server.js".
// Use: node --import ./scripts/node-resolve.mjs --conditions=react-server --experimental-strip-types <script>
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (relative && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
      if (!relative && specifier.startsWith("next/") && !specifier.endsWith(".js")) return next(`${specifier}.js`, context);
      throw error;
    }
  },
});
