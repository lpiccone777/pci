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
};

export default nextConfig;
