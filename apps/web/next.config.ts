import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Build estático (out/) servible por nginx sin Node corriendo — todas las
  // páginas ya son 'use client' (sin Server Components/API routes/middleware),
  // ver /dashboard/flows/edit para el único caso que necesitó ajuste (ruta
  // dinámica [id] -> query param, export no soporta rutas dinámicas sin
  // generateStaticParams). `trailingSlash` hace que cada ruta se emita como
  // carpeta/index.html (ej. dashboard/flows/index.html) para que nginx la
  // sirva por su index por defecto, sin reglas de rewrite para quitar el
  // ".html" de la URL.
  output: "export",
  trailingSlash: true,
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
