'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  Panel,
  Node,
  Edge,
  Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { apiFetch } from '@/lib/api';
import {
  StartNode,
  MessageNode,
  MenuNode,
  InputNode,
  ConditionNode,
  TicketCreateNode,
  TicketQueryNode,
  TransferAgentNode,
  LlmQueryNode,
  DelayNode,
  VariableNode,
  WebhookNode,
  SubflowNode,
  EndNode,
  DeviceValidationNode,
} from '@/components/flow-nodes';
import { DeletableEdge } from '@/components/flow-edges';

interface TenantOption {
  id: string;
  name: string;
  slug: string;
}

interface UserOption {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}

const customNodeTypes = {
  start: StartNode,
  message: MessageNode,
  menu: MenuNode,
  input: InputNode,
  condition: ConditionNode,
  ticket_create: TicketCreateNode,
  ticket_query: TicketQueryNode,
  transfer_agent: TransferAgentNode,
  llm_query: LlmQueryNode,
  delay: DelayNode,
  variable: VariableNode,
  webhook: WebhookNode,
  subflow: SubflowNode,
  end: EndNode,
  device_validation: DeviceValidationNode,
};

const customEdgeTypes = {
  default: DeletableEdge,
};

// Misma lista que apps/api/src/modules/flow/flow-context.ts (FLOW_CONTEXT_OPTIONS).
// Son 4 valores fijos, así que se duplica acá en vez de exponer un endpoint solo
// para esto — igual que nodeTypeList, más abajo, no viene del backend.
const contextOptions = [
  { value: 'none', label: 'Ninguna / genérico' },
  { value: 'invgate', label: 'Invgate (tickets)' },
  { value: 'internal_kb', label: 'Base de conocimiento interna' },
  { value: 'other', label: 'Otro' },
];

const nodeTypeList = [
  { type: 'start', label: 'Inicio', color: '#10b981' },
  { type: 'message', label: 'Mensaje', color: '#3b82f6' },
  { type: 'menu', label: 'Menú', color: '#8b5cf6' },
  { type: 'input', label: 'Input', color: '#f59e0b' },
  { type: 'condition', label: 'Condición', color: '#ef4444' },
  { type: 'ticket_create', label: 'Crear Ticket', color: '#ec4899' },
  { type: 'ticket_query', label: 'Consultar Ticket', color: '#ec4899' },
  { type: 'transfer_agent', label: 'Transferir Agente', color: '#6366f1' },
  { type: 'llm_query', label: 'Consultar LLM', color: '#14b8a6' },
  { type: 'delay', label: 'Delay', color: '#6b7280' },
  { type: 'variable', label: 'Variable', color: '#84cc16' },
  { type: 'webhook', label: 'Webhook', color: '#f97316' },
  { type: 'subflow', label: 'Sub-flujo', color: '#06b6d4' },
  { type: 'end', label: 'Fin', color: '#991b1b' },
  { type: 'device_validation', label: 'Validar Dispositivo', color: '#0ea5e9' },
];

function FlowEditorInner() {
  const { id } = useParams();
  const router = useRouter();
  const isNew = id === 'new';
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [flowName, setFlowName] = useState('Nuevo Flujo');
  const [flowDescription, setFlowDescription] = useState('');
  const [flowContext, setFlowContext] = useState('none');
  const [allTenants, setAllTenants] = useState<TenantOption[]>([]);
  const [allUsers, setAllUsers] = useState<UserOption[]>([]);
  const [selectedTenantIds, setSelectedTenantIds] = useState<string[]>([]);
  const [isStartFlow, setIsStartFlow] = useState(false);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const { screenToFlowPosition } = useReactFlow();

  useEffect(() => {
    // Lista completa de tenants para los checkboxes. Requiere estar en el tenant
    // de sistema (SystemTenantGuard) — si no, queda vacía y los checkboxes no
    // aparecen: no tiene sentido asignar un flujo a tenants que no se pueden ver.
    loadTenants();
    loadUsers();

    if (!isNew) {
      loadFlow();
    } else {
      // Create default start node
      setNodes([
        {
          id: 'start_1',
          type: 'start',
          position: { x: 250, y: 50 },
          data: { text: 'Bienvenido al soporte técnico' },
        },
      ]);
      setLoading(false);
    }
  }, []);

  async function loadTenants() {
    try {
      const data = await apiFetch('/tenants/all');
      setAllTenants(data);
    } catch {
      // Sin acceso (no es el tenant de sistema) o sin permiso: los checkboxes
      // simplemente no se muestran, no es un error que deba interrumpir la carga
      // del editor.
      setAllTenants([]);
    }
  }

  async function loadUsers() {
    try {
      const data = await apiFetch('/users');
      setAllUsers(data);
    } catch {
      // Sin permiso `users:read` en el tenant actual: los selectores de
      // colaboradores/observadores del nodo transfer_agent quedan vacíos.
      setAllUsers([]);
    }
  }

  async function loadFlow() {
    try {
      const flow = await apiFetch(`/flows/${id}`);
      setFlowName(flow.name);
      setFlowDescription(flow.description || '');
      setFlowContext(flow.context || 'none');
      const tenantFlows = flow.tenantFlows || [];
      setSelectedTenantIds(tenantFlows.map((tf: any) => tf.tenant.id));
      setIsStartFlow(tenantFlows.some((tf: any) => tf.isStart));
      setNodes(flow.nodes || []);
      setEdges(
        (flow.edges || []).map((e: any) => ({
          ...e,
          type: e.type || 'default',
        })),
      );
    } catch (err) {
      console.error('Error loading flow:', err);
      alert('Error al cargar el flujo');
    } finally {
      setLoading(false);
    }
  }

  function toggleTenant(tenantId: string) {
    setSelectedTenantIds((prev) =>
      prev.includes(tenantId) ? prev.filter((id) => id !== tenantId) : [...prev, tenantId],
    );
  }

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge(connection, eds)),
    [setEdges],
  );

  const onNodeClick = useCallback((_: any, node: Node) => {
    setSelectedNode(node);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/reactflow');
      if (!type) return;

      const position = screenToFlowPosition({
        x: event.clientX - 250,
        y: event.clientY - 100,
      });

      const newNode: Node = {
        id: `${type}_${Date.now()}`,
        type,
        position,
        data: getDefaultData(type),
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [screenToFlowPosition, setNodes],
  );

  function getDefaultData(type: string) {
    switch (type) {
      case 'start':
      case 'message':
        return { text: '' };
      case 'menu':
        return { text: 'Seleccione una opción:', options: [] };
      case 'input':
        return { text: 'Ingrese su respuesta:', variableName: '' };
      case 'condition':
        return { conditions: [], defaultTargetNodeId: '' };
      case 'ticket_create':
        return { subject: '', priority: 'medium' };
      case 'ticket_query':
        return { ticketIdVariable: '' };
      case 'transfer_agent':
        return {
          message: '',
          methods: [],
          assignees: [],
          watchers: [],
          collaborators: [],
        };
      case 'llm_query':
        return { systemPrompt: '', contextMessages: 10 };
      case 'delay':
        return { seconds: 1 };
      case 'variable':
        return { action: 'set', name: '', value: '' };
      case 'webhook':
        return { url: '', method: 'POST' };
      case 'end':
      case 'device_validation':
        return { text: '' };
      default:
        return {};
    }
  }

  function updateNodeData(key: string, value: any) {
    if (!selectedNode) return;
    setNodes((nds) =>
      nds.map((n) =>
        n.id === selectedNode.id ? { ...n, data: { ...n.data, [key]: value } } : n,
      ),
    );
    setSelectedNode((prev) => (prev ? { ...prev, data: { ...prev.data, [key]: value } } : null));
  }

  async function saveFlow() {
    setSaving(true);
    try {
      const payload = {
        name: flowName,
        description: flowDescription,
        context: flowContext,
        // Solo lo que define el flujo. ReactFlow agrega estado de runtime a nodos y
        // aristas (`measured` con el tamaño calculado, `selected`, `dragging`) que no
        // es parte del flujo y que el ValidationPipe del backend rechaza.
        nodes: nodes.map((n) => ({
          id: n.id,
          type: n.type,
          position: n.position,
          data: n.data,
        })),
        edges: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          // `type` sí se persiste: elige el renderer de la arista (DeletableEdge).
          ...(e.type ? { type: e.type } : {}),
          ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
          ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
          ...(e.label ? { label: e.label } : {}),
        })),
      };

      if (isNew) {
        const created = await apiFetch('/flows', {
          method: 'POST',
          body: JSON.stringify({
            ...payload,
            tenantIds: selectedTenantIds,
            isStart: isStartFlow,
          }),
        });
        router.replace(`/dashboard/flows/${created.id}`);
      } else {
        await apiFetch(`/flows/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        // La asignación a tenants es un endpoint aparte del resto de los campos
        // del flujo (igual que ya era antes de agregar los checkboxes).
        await apiFetch(`/flows/${id}/assign-tenants`, {
          method: 'POST',
          body: JSON.stringify({ tenantIds: selectedTenantIds, isStart: isStartFlow }),
        });
        alert('Flujo guardado');
      }
    } catch (err: any) {
      console.error('Error saving flow:', err);
      // Mostrar el motivo real: el backend explica qué campo rechazó.
      alert(`Error al guardar: ${err?.message ?? 'error desconocido'}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="p-6">Cargando...</div>;

  return (
    <div className="h-screen flex flex-col">
      {/* Header */}
      <div className="bg-white border-b p-4 flex justify-between items-center">
        <div className="flex gap-4 items-center">
          <button
            onClick={() => router.push('/dashboard/flows')}
            className="text-gray-600 hover:text-gray-900"
          >
            ← Volver
          </button>
          <input
            type="text"
            value={flowName}
            onChange={(e) => setFlowName(e.target.value)}
            className="font-semibold text-lg border rounded px-2 py-1"
            placeholder="Nombre del flujo"
          />
          <input
            type="text"
            value={flowDescription}
            onChange={(e) => setFlowDescription(e.target.value)}
            className="text-gray-600 border rounded px-2 py-1 text-sm"
            placeholder="Descripción"
          />
          <select
            value={flowContext}
            onChange={(e) => setFlowContext(e.target.value)}
            className="text-gray-600 border rounded px-2 py-1 text-sm"
            title="Fuente de datos que respalda las respuestas de este flujo"
          >
            {contextOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={saveFlow}
          disabled={saving}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? 'Guardando...' : 'Guardar'}
        </button>
      </div>

      {/* Asignación a tenants: en qué empresas está disponible este flujo, y si
          es el flujo de inicio para ellas. Solo se muestra si se pudo cargar la
          lista completa de tenants (requiere tenant de sistema, ver loadTenants). */}
      {allTenants.length > 0 && (
        <div className="bg-gray-50 border-b px-4 py-2 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-gray-500 font-medium">Disponible en:</span>
            {allTenants.map((t) => (
              <label key={t.id} className="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedTenantIds.includes(t.id)}
                  onChange={() => toggleTenant(t.id)}
                />
                {t.name}
              </label>
            ))}
          </div>

          <label
            className="flex items-center gap-1 cursor-pointer border-l pl-4"
            title="Cada tenant tiene como máximo un flujo de inicio. Si otro flujo ya lo era para alguno de los tenants marcados arriba, se lo desmarca al guardar."
          >
            <input
              type="checkbox"
              checked={isStartFlow}
              disabled={selectedTenantIds.length === 0}
              onChange={(e) => setIsStartFlow(e.target.checked)}
            />
            <span className={selectedTenantIds.length === 0 ? 'text-gray-400' : ''}>
              Inicio {selectedTenantIds.length === 0 && '(elegí un tenant primero)'}
            </span>
          </label>
        </div>
      )}

      <div className="flex-1 flex">
        {/* Sidebar - Node Types */}
        <div className="w-48 bg-gray-50 border-r p-4 overflow-y-auto">
          <h3 className="font-semibold mb-4 text-sm">Nodos</h3>
          <div className="space-y-2">
            {nodeTypeList.map((nt) => (
              <div
                key={nt.type}
                draggable
                onDragStart={(e) =>
                  e.dataTransfer.setData('application/reactflow', nt.type)
                }
                className="p-2 rounded cursor-move text-sm flex items-center gap-2 hover:shadow"
                style={{ backgroundColor: nt.color + '20', borderLeft: `3px solid ${nt.color}` }}
              >
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: nt.color }} />
                {nt.label}
              </div>
            ))}
          </div>
        </div>

        {/* Canvas */}
        <div className="flex-1 relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onDrop={onDrop}
            onDragOver={onDragOver}
            nodeTypes={customNodeTypes}
            edgeTypes={customEdgeTypes}
            defaultEdgeOptions={{ type: 'default' }}
            // Además del botón × al pasar el mouse: seleccionar y borrar con teclado.
            deleteKeyCode={['Backspace', 'Delete']}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap />
          </ReactFlow>
        </div>

        {/* Properties Panel */}
        {selectedNode && (
          <div className="w-72 bg-white border-l p-4 overflow-y-auto">
            <h3 className="font-semibold mb-4">Propiedades</h3>
            <p className="text-xs text-gray-500 mb-4">{selectedNode.type}</p>
            <NodeProperties
              node={selectedNode}
              onUpdate={updateNodeData}
              users={allUsers}
            />
            <button
              onClick={() => {
                setNodes((nds) => nds.filter((n) => n.id !== selectedNode.id));
                setEdges((eds) =>
                  eds.filter((e) => e.source !== selectedNode.id && e.target !== selectedNode.id),
                );
                setSelectedNode(null);
              }}
              className="mt-4 w-full text-red-600 border border-red-600 rounded py-1 hover:bg-red-50"
            >
              Eliminar nodo
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function NodeProperties({
  node,
  onUpdate,
  users,
}: {
  node: Node;
  onUpdate: (key: string, value: any) => void;
  users: UserOption[];
}) {
  const { type } = node;
  const data = (node.data || {}) as Record<string, any>;

  return (
    <div className="space-y-4">
      {type === 'start' && (
        <>
          <div>
            <label className="block text-sm font-medium mb-1">Texto de bienvenida (usuarios nuevos)</label>
            <textarea
              value={data.text || ''}
              onChange={(e) => onUpdate('text', e.target.value)}
              className="w-full border rounded p-2 text-sm"
              rows={2}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Salida: Usuario Conocido</label>
            <input
              type="text"
              value={data.knownTargetNodeId || ''}
              onChange={(e) => onUpdate('knownTargetNodeId', e.target.value)}
              className="w-full border rounded p-2 text-sm"
              placeholder="ID del nodo destino"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Salida: Usuario Desconocido</label>
            <input
              type="text"
              value={data.unknownTargetNodeId || ''}
              onChange={(e) => onUpdate('unknownTargetNodeId', e.target.value)}
              className="w-full border rounded p-2 text-sm"
              placeholder="ID del nodo destino"
            />
          </div>
        </>
      )}

      {type === 'message' && (
        <div>
          <label className="block text-sm font-medium mb-1">Texto</label>
          <textarea
            value={data.text || ''}
            onChange={(e) => onUpdate('text', e.target.value)}
            className="w-full border rounded p-2 text-sm"
            rows={3}
          />
        </div>
      )}

      {type === 'end' && (
        <div>
          <label className="block text-sm font-medium mb-1">Mensaje de cierre</label>
          <textarea
            value={data.text || ''}
            onChange={(e) => onUpdate('text', e.target.value)}
            className="w-full border rounded p-2 text-sm"
            rows={3}
            placeholder="Listo, ¡gracias por contactarnos!"
          />
          <p className="mt-1 text-xs text-gray-400">
            Cierra la charla. Se puede retomar dentro de 12hs; después de eso, el próximo mensaje
            abre una charla nueva.
          </p>
        </div>
      )}

      {type === 'device_validation' && (
        <div>
          <label className="block text-sm font-medium mb-1">
            Mensaje al pedir el código (opcional)
          </label>
          <textarea
            value={data.text || ''}
            onChange={(e) => onUpdate('text', e.target.value)}
            className="w-full border rounded p-2 text-sm"
            rows={3}
            placeholder="Te mandamos un código de validación a tu email. Escribime el código para continuar."
          />
          <p className="mt-1 text-xs text-gray-400">
            Valida el dispositivo (teléfono + email del usuario) con un código por mail. Si ya
            está validado y vigente (según DEVICE_FINGERPRINT_TTL_DAYS), el nodo no interrumpe la
            charla — sigue directo al siguiente nodo.
          </p>
        </div>
      )}

      {type === 'menu' && (
        <>
          <div>
            <label className="block text-sm font-medium mb-1">Texto del menú</label>
            <textarea
              value={data.text || ''}
              onChange={(e) => onUpdate('text', e.target.value)}
              className="w-full border rounded p-2 text-sm"
              rows={2}
              placeholder="Ej: Seleccione una opción:"
            />
          </div>
          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="block text-sm font-medium">Opciones</label>
              <button
                type="button"
                onClick={() => {
                  const current = data.options || [];
                  onUpdate('options', [
                    ...current,
                    { label: `Opción ${current.length + 1}`, value: String(current.length + 1), targetNodeId: '' },
                  ]);
                }}
                className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded hover:bg-blue-200"
              >
                + Agregar
              </button>
            </div>
            <div className="space-y-2">
              {(data.options || []).map((opt: any, idx: number) => (
                <div key={idx} className="border rounded p-2 bg-gray-50">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-xs font-medium text-gray-500">Opción {idx + 1}</span>
                    <button
                      type="button"
                      onClick={() => {
                        const current = data.options || [];
                        onUpdate('options', current.filter((_: any, i: number) => i !== idx));
                      }}
                      className="text-xs text-red-500 hover:text-red-700"
                    >
                      × Quitar
                    </button>
                  </div>
                  <div className="space-y-1">
                    <input
                      type="text"
                      value={opt.label || ''}
                      onChange={(e) => {
                        const current = [...(data.options || [])];
                        current[idx] = { ...current[idx], label: e.target.value };
                        onUpdate('options', current);
                      }}
                      className="w-full border rounded px-2 py-1 text-sm"
                      placeholder="Etiqueta (ej: Soporte Técnico)"
                    />
                    <input
                      type="text"
                      value={opt.value || ''}
                      onChange={(e) => {
                        const current = [...(data.options || [])];
                        current[idx] = { ...current[idx], value: e.target.value };
                        onUpdate('options', current);
                      }}
                      className="w-full border rounded px-2 py-1 text-sm"
                      placeholder="Valor (ej: 1)"
                    />
                    <input
                      type="text"
                      value={opt.targetNodeId || ''}
                      onChange={(e) => {
                        const current = [...(data.options || [])];
                        current[idx] = { ...current[idx], targetNodeId: e.target.value };
                        onUpdate('options', current);
                      }}
                      className="w-full border rounded px-2 py-1 text-sm font-mono"
                      placeholder="ID nodo destino"
                    />
                  </div>
                </div>
              ))}
              {(data.options || []).length === 0 && (
                <p className="text-xs text-gray-400 italic text-center py-2">
                  Sin opciones. Hacé clic en "+ Agregar".
                </p>
              )}
            </div>
          </div>
        </>
      )}

      {type === 'input' && (
        <>
          <div>
            <label className="block text-sm font-medium mb-1">Texto</label>
            <textarea
              value={data.text || ''}
              onChange={(e) => onUpdate('text', e.target.value)}
              className="w-full border rounded p-2 text-sm"
              rows={2}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Nombre de variable</label>
            <input
              type="text"
              value={data.variableName || ''}
              onChange={(e) => onUpdate('variableName', e.target.value)}
              className="w-full border rounded p-2 text-sm"
            />
          </div>
        </>
      )}

      {type === 'condition' && (
        <>
          <div>
            <label className="block text-sm font-medium mb-1">Condiciones (JSON)</label>
            <textarea
              value={JSON.stringify(data.conditions || [], null, 2)}
              onChange={(e) => {
                try {
                  onUpdate('conditions', JSON.parse(e.target.value));
                } catch {}
              }}
              className="w-full border rounded p-2 text-sm font-mono"
              rows={6}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Nodo por defecto</label>
            <input
              type="text"
              value={data.defaultTargetNodeId || ''}
              onChange={(e) => onUpdate('defaultTargetNodeId', e.target.value)}
              className="w-full border rounded p-2 text-sm"
            />
          </div>
        </>
      )}

      {type === 'ticket_create' && (
        <>
          <div>
            <label className="block text-sm font-medium mb-1">Asunto</label>
            <input
              type="text"
              value={data.subject || ''}
              onChange={(e) => onUpdate('subject', e.target.value)}
              className="w-full border rounded p-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Prioridad</label>
            <select
              value={data.priority || 'medium'}
              onChange={(e) => onUpdate('priority', e.target.value)}
              className="w-full border rounded p-2 text-sm"
            >
              <option value="low">Baja</option>
              <option value="medium">Media</option>
              <option value="high">Alta</option>
            </select>
          </div>
        </>
      )}

      {type === 'llm_query' && (
        <>
          <div>
            <label className="block text-sm font-medium mb-1">System Prompt</label>
            <textarea
              value={data.systemPrompt || ''}
              onChange={(e) => onUpdate('systemPrompt', e.target.value)}
              className="w-full border rounded p-2 text-sm"
              rows={3}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Mensajes de contexto</label>
            <input
              type="number"
              value={data.contextMessages || 10}
              onChange={(e) => onUpdate('contextMessages', parseInt(e.target.value))}
              className="w-full border rounded p-2 text-sm"
            />
          </div>
        </>
      )}

      {type === 'delay' && (
        <div>
          <label className="block text-sm font-medium mb-1">Segundos</label>
          <input
            type="number"
            value={data.seconds || 1}
            onChange={(e) => onUpdate('seconds', parseInt(e.target.value))}
            className="w-full border rounded p-2 text-sm"
          />
        </div>
      )}

      {type === 'variable' && (
        <>
          <div>
            <label className="block text-sm font-medium mb-1">Acción</label>
            <select
              value={data.action || 'set'}
              onChange={(e) => onUpdate('action', e.target.value)}
              className="w-full border rounded p-2 text-sm"
            >
              <option value="set">Set</option>
              <option value="get">Get</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Nombre</label>
            <input
              type="text"
              value={data.name || ''}
              onChange={(e) => onUpdate('name', e.target.value)}
              className="w-full border rounded p-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Valor</label>
            <input
              type="text"
              value={data.value || ''}
              onChange={(e) => onUpdate('value', e.target.value)}
              className="w-full border rounded p-2 text-sm"
            />
          </div>
        </>
      )}

      {type === 'webhook' && (
        <>
          <div>
            <label className="block text-sm font-medium mb-1">URL</label>
            <input
              type="text"
              value={data.url || ''}
              onChange={(e) => onUpdate('url', e.target.value)}
              className="w-full border rounded p-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Método</label>
            <select
              value={data.method || 'POST'}
              onChange={(e) => onUpdate('method', e.target.value)}
              className="w-full border rounded p-2 text-sm"
            >
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
            </select>
          </div>
        </>
      )}

      {type === 'subflow' && (
        <>
          <div>
            <label className="block text-sm font-medium mb-1">Texto de transición</label>
            <textarea
              value={data.text || ''}
              onChange={(e) => onUpdate('text', e.target.value)}
              className="w-full border rounded p-2 text-sm"
              rows={2}
              placeholder="Entrando a sub-flujo..."
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">ID del flujo</label>
            <input
              type="text"
              value={data.flowId || ''}
              onChange={(e) => onUpdate('flowId', e.target.value)}
              className="w-full border rounded p-2 text-sm font-mono"
              placeholder="cmsb..."
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">ID nodo de entrada (opcional)</label>
            <input
              type="text"
              value={data.entryNodeId || ''}
              onChange={(e) => onUpdate('entryNodeId', e.target.value)}
              className="w-full border rounded p-2 text-sm font-mono"
              placeholder="start_1"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Nombre del flujo (solo visual)</label>
            <input
              type="text"
              value={data.flowName || ''}
              onChange={(e) => onUpdate('flowName', e.target.value)}
              className="w-full border rounded p-2 text-sm"
              placeholder="Soporte Técnico"
            />
          </div>
        </>
      )}

      {type === 'transfer_agent' && (
        <>
          <div>
            <label className="block text-sm font-medium mb-1">Nota interna (mail / ticket)</label>
            <p className="text-xs text-gray-400 mb-1">
              No se muestra en el chat — se agrega al mail y a la descripción del ticket para el agente.
            </p>
            <textarea
              value={data.message || ''}
              onChange={(e) => onUpdate('message', e.target.value)}
              className="w-full border rounded p-2 text-sm"
              rows={2}
              placeholder="Ej: usuario reincidente, ya intentó restablecer la contraseña dos veces"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Método de transferencia</label>
            <div className="space-y-1">
              {[
                { value: 'email', label: 'Mail' },
                { value: 'ticket', label: 'Ticket' },
                { value: 'phone', label: 'Teléfono (próximamente)', disabled: true },
              ].map((m) => (
                <label
                  key={m.value}
                  className={`flex items-center gap-2 text-sm ${m.disabled ? 'text-gray-400' : ''}`}
                >
                  <input
                    type="checkbox"
                    disabled={m.disabled}
                    checked={(data.methods || []).includes(m.value)}
                    onChange={(e) => {
                      const current: string[] = data.methods || [];
                      onUpdate(
                        'methods',
                        e.target.checked ? [...current, m.value] : current.filter((v) => v !== m.value),
                      );
                    }}
                  />
                  {m.label}
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="block text-sm font-medium">Asignados (orden = round robin)</label>
              <button
                type="button"
                onClick={() => onUpdate('assignees', [...(data.assignees || []), ''])}
                className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded hover:bg-blue-200"
              >
                + Agregar
              </button>
            </div>
            <div className="space-y-2">
              {(data.assignees || []).map((userId: string, idx: number) => (
                <div key={idx} className="border rounded p-2 bg-gray-50">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-xs font-medium text-gray-500">#{idx + 1}</span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => {
                          const current = [...(data.assignees || [])];
                          [current[idx - 1], current[idx]] = [current[idx], current[idx - 1]];
                          onUpdate('assignees', current);
                        }}
                        className="text-xs text-gray-500 hover:text-gray-800 disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        disabled={idx === (data.assignees || []).length - 1}
                        onClick={() => {
                          const current = [...(data.assignees || [])];
                          [current[idx + 1], current[idx]] = [current[idx], current[idx + 1]];
                          onUpdate('assignees', current);
                        }}
                        className="text-xs text-gray-500 hover:text-gray-800 disabled:opacity-30"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const current = data.assignees || [];
                          onUpdate('assignees', current.filter((_: any, i: number) => i !== idx));
                        }}
                        className="text-xs text-red-500 hover:text-red-700"
                      >
                        × Quitar
                      </button>
                    </div>
                  </div>
                  <select
                    value={userId}
                    onChange={(e) => {
                      const current = [...(data.assignees || [])];
                      current[idx] = e.target.value;
                      onUpdate('assignees', current);
                    }}
                    className="w-full border rounded px-2 py-1 text-sm"
                  >
                    <option value="">Seleccionar usuario...</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {userLabel(u)}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              {(data.assignees || []).length === 0 && (
                <p className="text-xs text-gray-400 italic text-center py-2">
                  Sin asignados. Hacé clic en "+ Agregar".
                </p>
              )}
            </div>
          </div>

          <UserPickerList
            label="Observadores"
            values={data.watchers || []}
            users={users}
            onChange={(next) => onUpdate('watchers', next)}
          />

          <UserPickerList
            label="Colaboradores de la tarea"
            values={data.collaborators || []}
            users={users}
            onChange={(next) => onUpdate('collaborators', next)}
          />
        </>
      )}
    </div>
  );
}

function userLabel(u: UserOption) {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ');
  return name ? `${name} (${u.email})` : u.email;
}

function UserPickerList({
  label,
  values,
  users,
  onChange,
}: {
  label: string;
  values: string[];
  users: UserOption[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div>
      <div className="flex justify-between items-center mb-1">
        <label className="block text-sm font-medium">{label}</label>
        <button
          type="button"
          onClick={() => onChange([...values, ''])}
          className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded hover:bg-blue-200"
        >
          + Agregar
        </button>
      </div>
      <div className="space-y-2">
        {values.map((userId, idx) => (
          <div key={idx} className="flex gap-1">
            <select
              value={userId}
              onChange={(e) => {
                const next = [...values];
                next[idx] = e.target.value;
                onChange(next);
              }}
              className="flex-1 border rounded px-2 py-1 text-sm"
            >
              <option value="">Seleccionar usuario...</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {userLabel(u)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => onChange(values.filter((_, i) => i !== idx))}
              className="text-xs text-red-500 hover:text-red-700 px-1"
            >
              ×
            </button>
          </div>
        ))}
        {values.length === 0 && (
          <p className="text-xs text-gray-400 italic text-center py-2">Sin elementos. Hacé clic en "+ Agregar".</p>
        )}
      </div>
    </div>
  );
}

export default function FlowEditorPage() {
  return (
    <ReactFlowProvider>
      <FlowEditorInner />
    </ReactFlowProvider>
  );
}
