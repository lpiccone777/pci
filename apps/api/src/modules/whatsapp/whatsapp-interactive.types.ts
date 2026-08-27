/** Payload de un mensaje interactivo de WhatsApp (botones, lista o CTA de link), independiente de cómo se genera. */
export type WhatsAppInteractive =
  | { type: 'button'; body: string; buttons: Array<{ id: string; title: string }> }
  | {
      type: 'list';
      body: string;
      buttonText: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }
  | {
      /**
       * Botón que abre una URL en vez de mandar una respuesta al webhook (nodo
       * `notification` en modo link). A diferencia de `button`/`list`, tocarlo NO genera
       * un mensaje entrante — WhatsApp no notifica el tap de un botón de link — así que
       * el flujo no puede esperar una confirmación: `ConversationsService` lo manda y
       * sigue de una, no lo deja "esperando" como al de tipo `button`.
       */
      type: 'cta_url';
      body: string;
      buttonText: string;
      url: string;
    };
