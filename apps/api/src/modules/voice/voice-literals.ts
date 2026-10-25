/**
 * Textos fijos que el motor dice por voz en modo `literal`, y la lista de todos los que pueden
 * salir de los flujos de voz activos (`voiceLiterals` de la config del voicebot, contrato C60:
 * el voicebot los sintetiza de antemano). El motor (`ConversationsService`) arma sus respuestas
 * con estas mismas funciones: así la lista no se desfasa de lo que realmente se dice.
 */

export const VOICE_TEXTS = {
  /** `start` sin saludo configurado, con la persona todavía sin identificar (siempre, por voz). */
  unknownGreeting: '¡Hola! Bienvenido. ¿En qué puedo ayudarte?',
  inputDefault: 'Por favor, ingresá el dato solicitado.',
  needsIdentity: 'Para hacer ese trámite primero tengo que identificarte, y por teléfono todavía no puedo hacerlo.',
  transferFail: 'No pude transferirte en este momento.',
  identifyAskName: 'Gracias. Ahora decime tu nombre y apellido.',
  identifyAskNameOnly: 'Para identificarte, decime tu nombre y apellido.',
  identifyRetryNameOnly: 'No te encontré con ese nombre. Decime de nuevo tu nombre y apellido, por favor.',
} as const;

/** Contenido del mensaje del bot cuando respondió el LLM de voz: se reemplaza por lo oído. */
export const DELEGATED_PLACEHOLDER = '(respuesta libre del voicebot)';

export const identifyAskDocument = (label: string) => `Para identificarte, decime tu número de ${label}.`;
export const identifyRetryDocument = (label: string) =>
  `No pude encontrarte con esos datos. Probemos de nuevo: decime tu número de ${label}.`;

/** El menú como se dice (y como se escribe sin botones): encabezado y opciones numeradas. */
export function spokenMenuText(text: string | undefined, options: Array<{ label?: string }>): string {
  return ((text ?? '') + '\n' + options.map((opt, idx) => `${idx + 1}. ${opt.label}`).join('\n')).trim();
}

export const menuUnavailableNotice = (label: string) => `La opción "${label}" no está disponible.`;

/** Tecla marcada que no corresponde a ninguna opción del menú [C57]. */
export const menuMissingKeyNotice = (key: string) =>
  /^\d$/.test(key) ? `La opción ${key} no existe.` : 'Esa tecla no corresponde a ninguna opción.';

/** Teclas de un teléfono. */
const PHONE_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#'];

/** Opción sintética "Volver" del menú (ver `navigateMenuBack` en el motor). */
const BACK_LABEL = 'Volver';

/** Nodos que pueden hablar en modo `guided`: ahí no hay texto literal fijo. */
const GUIDABLE = new Set(['start', 'message', 'menu', 'input', 'end', 'ticket_create', 'voice_identify']);

type FlowGraph = { nodes: unknown; edges: unknown };

/**
 * Todos los `say literal` fijos de estos flujos, sin repetidos y sin los que tienen `{{variable}}`
 * (cambian por llamada). Incluye las variantes que puede decir un nodo: el menú con y sin
 * "Volver", su aviso de opción no disponible, y las preguntas y reintentos de identificación.
 */
export function collectVoiceLiterals(flows: FlowGraph[]): string[] {
  const out: string[] = [];
  const add = (text: string | undefined | null) => {
    if (!text || !text.trim() || text.includes('{{')) return;
    if (!out.includes(text)) out.push(text);
  };

  for (const flow of flows) {
    const nodes = Array.isArray(flow.nodes) ? (flow.nodes as any[]) : [];
    const edges = Array.isArray(flow.edges) ? (flow.edges as any[]) : [];
    for (const node of nodes) {
      const data = node?.data ?? {};
      if (GUIDABLE.has(node?.type) && data.speechMode === 'guided') continue;
      switch (node?.type) {
        case 'start':
          if (!data.noGreeting) add(data.text?.trim() ? data.text : VOICE_TEXTS.unknownGreeting);
          break;
        case 'message':
        case 'end':
          add(data.text);
          break;
        case 'input':
          add(data.text || VOICE_TEXTS.inputDefault);
          break;
        case 'menu': {
          const options: any[] = Array.isArray(data.options) ? data.options : [];
          for (const shown of [options, [...options, { label: BACK_LABEL, value: '__volver' }]]) {
            const menu = spokenMenuText(data.text, shown);
            add(menu);
            for (const opt of shown) {
              if (opt.value === '__volver') continue;
              const connected =
                edges.some((e) => e.source === node.id && e.sourceHandle === String(opt.value)) || !!opt.targetNodeId;
              if (!connected) add(`${menuUnavailableNotice(opt.label)}\n\n${menu}`);
            }
            // Una tecla sin opción: el aviso y el menú de nuevo, con cada tecla posible.
            for (const key of PHONE_KEYS) {
              if (/^\d$/.test(key) && Number(key) >= 1 && Number(key) <= shown.length) continue;
              add(`${menuMissingKeyNotice(key)}\n\n${menu}`);
            }
          }
          break;
        }
        case 'voice_identify': {
          const label = data.idLabel === 'legajo' ? 'legajo' : 'documento';
          add(data.text?.trim() || identifyAskDocument(label));
          add(data.namePrompt?.trim() || VOICE_TEXTS.identifyAskName);
          add(data.namePrompt?.trim() || VOICE_TEXTS.identifyAskNameOnly);
          add(data.retryText?.trim() || identifyRetryDocument(label));
          add(VOICE_TEXTS.identifyRetryNameOnly);
          break;
        }
        case 'ticket_create':
          add(VOICE_TEXTS.needsIdentity);
          add(data.text);
          break;
        case 'transfer_agent':
          add(VOICE_TEXTS.needsIdentity);
          break;
        case 'transfer_extension':
          add(data.text?.trim());
          add(data.failText?.trim() || VOICE_TEXTS.transferFail);
          break;
      }
    }
  }
  return out;
}
