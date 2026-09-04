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
       * un mensaje entrante — WhatsApp no notifica el tap de un botón de link. Igual hay
       * que frenar el flujo acá (`waitForInput`, como cualquier nodo con `interactive`):
       * sin eso, `executeFlow` sigue encadenando nodos en el mismo turno y el próximo pisa
       * este `interactive` antes de que llegue a mandarse. `ConversationsService` no
       * matchea nada contra un botón de link — el próximo mensaje que sea, cualquiera,
       * avanza el flujo.
       */
      type: 'cta_url';
      body: string;
      buttonText: string;
      url: string;
    };
