/**
 * Constructores de nodos y aristas de flujo para las fixtures del CHATBOT (CHAT-*).
 *
 * El motor (`ConversationsService.executeNode`) espera nodos con la forma de ReactFlow:
 * `{ id, type, data, position }`, y aristas `{ id, source, target, sourceHandle? }`. Estos
 * helpers arman esa forma con los campos `data` que cada tipo de nodo realmente lee (verificado
 * en `executeNode`).
 *
 * Ruteo (ver `resolveNextNode`): prioridad 1) `nextNodeId` que devuelve el nodo (menu/condition
 * apuntan por `targetNodeId`/edge por `sourceHandle`=valor de opción); 2) arista del
 * `sourceHandle` que devolvió el nodo (start: 'known'/'unknown'); 3) primera arista saliente.
 *
 * ## Hazard de aislamiento (LEER)
 * `Flow.isDefault` es GLOBAL (no por tenant). `findActiveFlowForTenant` cae a
 * `flow.findFirst({ isDefault:true })`. Como todos los specs comparten la base, si tu test
 * depende de "el flujo default", en el `beforeAll` desmarcá cualquier otro default primero:
 *   `await prisma.flow.updateMany({ where:{ isDefault:true }, data:{ isDefault:false } });`
 * y recién después creá el tuyo. Los flujos de inicio por `TenantFlow(isStart)` sí quedan
 * scopeados a tu tenant (creá un tenant propio con `uniqueSlug`), así que no chocan.
 */

export interface FlowNode {
  id: string;
  type: string;
  data: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
}

let posX = 0;
export function node(id: string, type: string, data: Record<string, unknown> = {}): FlowNode {
  posX += 120;
  return { id, type, data, position: { x: posX, y: 0 } };
}

// --- Constructores por tipo (los campos son los que executeNode realmente lee) ---

/** start: data.text (saludo para desconocidos), knownTargetNodeId/unknownTargetNodeId (fallback). Rutea por handle 'known'/'unknown'. */
export const startNode = (id = 'start', data: Record<string, unknown> = {}): FlowNode => node(id, 'start', data);

/** message: data.text → responseText, avanza a la primera arista. */
export const messageNode = (id: string, text?: string): FlowNode => node(id, 'message', text != null ? { text } : {});

/** end: data.text (despedida opcional), cierra la charla (retomable 12h). */
export const endNode = (id: string, text?: string): FlowNode => node(id, 'end', text != null ? { text } : {});

/** menu: data.text (header) + data.options=[{value,label,targetNodeId?}]. Aristas con sourceHandle = String(value). */
export const menuNode = (
  id: string,
  opts: { text?: string; options: { value: string | number; label: string; targetNodeId?: string }[] },
): FlowNode => node(id, 'menu', { text: opts.text, options: opts.options });

/** input: data.text (pregunta) + data.variableName (dónde guardar). */
export const inputNode = (id: string, opts: { text?: string; variableName?: string }): FlowNode =>
  node(id, 'input', { text: opts.text, variableName: opts.variableName });

/** condition: data.conditions=[{type:'keyword'|'regex'|'variable', value, targetNodeId}] + data.defaultTargetNodeId. */
export const conditionNode = (
  id: string,
  opts: {
    conditions: { type: 'keyword' | 'regex' | 'variable'; value?: string; targetNodeId?: string }[];
    defaultTargetNodeId?: string;
  },
): FlowNode => node(id, 'condition', { conditions: opts.conditions, defaultTargetNodeId: opts.defaultTargetNodeId });

/** ticket_create: data.subject/description/priority/category/ticketType (todos opcionales; caen a flowState o al body). */
export const ticketCreateNode = (id: string, data: Record<string, unknown> = {}): FlowNode =>
  node(id, 'ticket_create', data);

/** ticket_query: data.ticketIdVariable (o usa flowState.lastTicketId). */
export const ticketQueryNode = (id: string, data: Record<string, unknown> = {}): FlowNode =>
  node(id, 'ticket_query', data);

/** llm_query: data.contextMessages/systemPrompt/systemPromptMode. Terminal si no tiene arista saliente. */
export const llmQueryNode = (id: string, data: Record<string, unknown> = {}): FlowNode => node(id, 'llm_query', data);

/** delay: data.seconds (máx 10). */
export const delayNode = (id: string, seconds: number): FlowNode => node(id, 'delay', { seconds });

/** variable: data.action='set' + data.name + data.value (o el body). */
export const variableNode = (id: string, data: Record<string, unknown> = {}): FlowNode => node(id, 'variable', data);

/** subflow: data.flowId + data.entryNodeId. */
export const subflowNode = (id: string, data: Record<string, unknown> = {}): FlowNode => node(id, 'subflow', data);

/** transfer_agent: data.methods=['ticket'|'email'|'phone'] + data.assignees/watchers/collaborators + data.message. */
export const transferAgentNode = (id: string, data: Record<string, unknown> = {}): FlowNode =>
  node(id, 'transfer_agent', data);

/** sms: data.recipients (userIds) + data.message. */
export const smsNode = (id: string, data: Record<string, unknown> = {}): FlowNode => node(id, 'sms', data);

/** device_validation: data.text (mensaje). */
export const deviceValidationNode = (id: string, data: Record<string, unknown> = {}): FlowNode =>
  node(id, 'device_validation', data);

/** webhook: stub → "Acción webhook ejecutada (stub)." */
export const webhookNode = (id: string, data: Record<string, unknown> = {}): FlowNode => node(id, 'webhook', data);

/** Arista source→target; `sourceHandle` para el ruteo por handle (start 'known'/'unknown', menu = valor de opción). */
export function edge(source: string, target: string, sourceHandle?: string): FlowEdge {
  return {
    id: `e-${source}-${target}-${sourceHandle ?? 'x'}`,
    source,
    target,
    ...(sourceHandle != null ? { sourceHandle } : {}),
  };
}
