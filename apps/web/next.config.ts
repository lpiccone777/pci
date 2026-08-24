import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
  // Permite un directorio de build alternativo (default `.next`). Lo usan los tests e2e para
  // compilar un web aislado sin pisar el `.next` del dev server que corre en paralelo. Sin la
  // env var, el comportamiento es el de siempre.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Solo en modo e2e (NEXT_DIST_DIR seteada): Next reescribe el tsconfig al compilar (le agrega
  // sus tipos generados). Para que NO toque el `tsconfig.json` versionado de la app, el build e2e
  // apunta a un tsconfig propio y descartable (`tsconfig.e2e.json`, gitignoreado). En uso normal
  // no se define y Next usa el tsconfig de siempre.
  ...(process.env.NEXT_DIST_DIR
    ? { typescript: { tsconfigPath: "tsconfig.e2e.json" } }
    : {}),
};

export default nextConfig;
