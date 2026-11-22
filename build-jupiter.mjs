// Bundles the Jupiter Mobile adapter for the browser. Runs on Vercel at deploy time (nothing to run by hand).
import { build } from 'esbuild';
await build({
  entryPoints: ['jupiter-src/entry.jsx'],
  outfile: 'public/jupiter-bundle.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2020', minify: true, sourcemap: false,
  inject: ['jupiter-src/shim.js'],
  loader: { '.js': 'jsx' },
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  logLevel: 'info',
});
