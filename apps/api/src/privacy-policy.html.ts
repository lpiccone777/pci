/** Borrador para pasar la verificación de app de Meta en testing. No es un documento legal final. */
export const PRIVACY_POLICY_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Política de Privacidad (borrador de testing) — Plataforma Conversacional Inteligente Chatbot</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #1f2937; }
  h1 { font-size: 1.4rem; }
  .warning { background: #fef3c7; border: 1px solid #f59e0b; border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 1.5rem; font-size: 0.9rem; }
  section { margin-bottom: 1.25rem; }
</style>
</head>
<body>
  <div class="warning">
    ⚠️ Este documento es un <strong>borrador para pruebas de integración con Meta (WhatsApp Business API)</strong>,
    no la política de privacidad legal definitiva de la empresa. Reemplazar antes de producción.
  </div>

  <h1>Política de Privacidad — Plataforma Conversacional Inteligente Chatbot</h1>

  <section>
    <h2>Qué datos procesamos</h2>
    <p>
      Cuando escribís por WhatsApp a este chatbot de soporte técnico, procesamos tu número de teléfono
      y el contenido de los mensajes que enviás, para poder responderte y, si corresponde, generar o
      consultar un ticket de soporte.
    </p>
  </section>

  <section>
    <h2>Con qué fin</h2>
    <p>
      Los datos se usan exclusivamente para brindar soporte técnico IT a usuarios de las empresas
      atendidas por Plataforma Conversacional Inteligente Soporte: identificarte, entender tu consulta y darte una respuesta o derivarte
      con un agente humano.
    </p>
  </section>

  <section>
    <h2>Con quién se comparten</h2>
    <p>
      No se venden ni se comparten con terceros ajenos al servicio. Para poder responderte, tu consulta
      puede procesarse a través del proveedor de modelo de lenguaje (LLM) configurado por Plataforma Conversacional Inteligente Soporte, y
      un ticket generado a partir de tu consulta puede quedar registrado en el sistema de gestión de
      tickets (Invgate) usado internamente.
    </p>
  </section>

  <section>
    <h2>Contacto</h2>
    <p>Para consultas sobre esta política, contactate con el área de sistemas de Plataforma Conversacional Inteligente Soporte.</p>
  </section>
</body>
</html>
`;
