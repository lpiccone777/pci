/** Borrador para pasar la validación de "sitio web de la empresa" de Meta en testing. No es la web real de la empresa. */
export const COMPANY_SITE_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Plataforma Conversacional Inteligente Soporte — Soporte IT (borrador de testing)</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #1f2937; }
  h1 { font-size: 1.6rem; }
  .warning { background: #fef3c7; border: 1px solid #f59e0b; border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 1.5rem; font-size: 0.9rem; }
  a { color: #2563eb; }
</style>
</head>
<body>
  <div class="warning">
    ⚠️ Página placeholder para pruebas de integración con Meta (WhatsApp Business API), no el sitio
    web oficial de la empresa. Reemplazar por el dominio real antes de producción.
  </div>

  <h1>Plataforma Conversacional Inteligente Soporte</h1>
  <p>
    Plataforma Conversacional Inteligente Soporte brinda soporte técnico IT a sus empresas cliente. Este chatbot de WhatsApp es parte
    de ese servicio de soporte: permite reportar problemas, generar y consultar tickets, y
    resolver consultas frecuentes.
  </p>
  <p>Ver también la <a href="/privacy-policy">política de privacidad</a> de este chatbot.</p>
</body>
</html>
`;
