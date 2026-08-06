/** Payload de un mensaje interactivo de WhatsApp (botones o lista), independiente de cómo se genera. */
export type WhatsAppInteractive =
  | { type: 'button'; body: string; buttons: Array<{ id: string; title: string }> }
  | {
      type: 'list';
      body: string;
      buttonText: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    };
