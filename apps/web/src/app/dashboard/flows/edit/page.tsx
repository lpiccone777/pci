'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
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
import { SYSTEM_TENANT_ID_KEY } from '@/lib/system-tenant';
import {
  StartNode,
  MessageNode,
  MenuNode,
  InputNode,
  ConditionNode,
  TicketCreateNode,
  TicketQueryNode,
  TransferAgentNode,
  SmsNode,
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

interface ContextSourceOption {
  id: string;
  name: string;
  type: string;
}

interface SkillOption {
  id: string;
  name: string;
}

/** Entrada de catálogo de InvGate (categoría/prioridad/tipo) — ver GET /invgate/catalog/*. */
interface InvgateCatalogOption {
  id: number;
  name: string;
}

interface FlowOption {
  id: string;
  name: string;
}

interface RoleOption {
  id: string;
  name: string;
}

/** En qué empresa está disponible el flujo y qué roles lo reciben ahí. */
interface Assignment {
  tenantId: string;
  roleIds: string[];
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
  sms: SmsNode,
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

const nodeTypeList = [
  { type: 'start', label: 'Inicio', color: '#10b981' },
  { type: 'message', label: 'Mensaje', color: '#3b82f6' },
  { type: 'menu', label: 'Menú', color: '#8b5cf6' },
  { type: 'input', label: 'Input', color: '#f59e0b' },
  { type: 'condition', label: 'Condición', color: '#ef4444' },
  { type: 'ticket_create', label: 'Crear Ticket', color: '#ec4899' },
  { type: 'ticket_query', label: 'Consultar Ticket', color: '#ec4899' },
  { type: 'transfer_agent', label: 'Transferir Agente', color: '#6366f1' },
  { type: 'sms', label: 'SMS', color: '#22c55e' },
  { type: 'llm_query', label: 'Consultar LLM', color: '#14b8a6' },
  { type: 'delay', label: 'Delay', color: '#6b7280' },
  { type: 'variable', label: 'Variable', color: '#84cc16' },
  { type: 'webhook', label: 'Webhook', color: '#f97316' },
  { type: 'subflow', label: 'Sub-flujo', color: '#06b6d4' },
  { type: 'end', label: 'Fin', color: '#991b1b' },
  { type: 'device_validation', label: 'Validar Dispositivo', color: '#0ea5e9' },
];

function FlowEditorInner() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id');
  const router = useRouter();
  const isNew = id === 'new';
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [flowName, setFlowName] = useState('Nuevo Flujo');
  const [flowDescription, setFlowDescription] = useState('');
  const [contextSourceId, setContextSourceId] = useState<string>('');
  const [contextSources, setContextSources] = useState<ContextSourceOption[]>([]);
  const [skillId, setSkillId] = useState<string>('');
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [allTenants, setAllTenants] = useState<TenantOption[]>([]);
  const [allUsers, setAllUsers] = useState<UserOption[]>([]);
  const [flowOptions, setFlowOptions] = useState<FlowOption[]>([]);
  // Catálogo real de InvGate para el nodo "Generar ticket" — categorías acotadas a
  // INVGATE_CATEGORY_PARENT_ID (ver /settings), prioridades y tipos completos (son pocos).
  // Vacío si InvGate no está configurado o el usuario no tiene permiso `flows:read`: el
  // campo cae a un input de texto libre, no bloquea la edición del flujo.
  const [invgateCategories, setInvgateCategories] = useState<InvgateCatalogOption[]>([]);
  const [invgatePriorities, setInvgatePriorities] = useState<InvgateCatalogOption[]>([]);
  const [invgateTypes, setInvgateTypes] = useState<InvgateCatalogOption[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  // Cache de roles por empresa: se traen de GET /roles con el header de esa empresa (así
  // el superadmin los lee parado en cualquier otra, igual que el alta de usuarios). Se
  // precargan los de las empresas ya asignadas al abrir un flujo existente, y se suman los
  // de una empresa nueva al agregarla en el modal.
  const [rolesByTenant, setRolesByTenant] = useState<Record<string, RoleOption[]>>({});
  const [modalOpen, setModalOpen] = useState(false);
  const [expandedTenants, setExpandedTenants] = useState<string[]>([]);
  // Copia de `assignments` al abrir el modal, para poder descartar con "Cancelar".
  const [assignmentsSnapshot, setAssignmentsSnapshot] = useState<Assignment[] | null>(null);
  const [isStartFlow, setIsStartFlow] = useState(false);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const { screenToFlowPosition } = useReactFlow();

  // El id de la empresa de sistema. Con él, los endpoints globales (lista de empresas) se
  // piden con el header de sistema explícito, así el superadmin administra flujos parado en
  // CUALQUIER empresa —igual que el alta de usuarios—, no solo en el tenant de sistema.
  // null para el usuario común (no es miembro del sistema): cae a su empresa activa.
  const systemTenantId =
    typeof window !== 'undefined' ? localStorage.getItem(SYSTEM_TENANT_ID_KEY) : null;

  useEffect(() => {
    // Lista completa de empresas para los checkboxes de asignación. El superadmin la pide
    // con el header de sistema explícito (ver loadTenants), así aparece parado en cualquier
    // empresa. Para el usuario común queda vacía y los checkboxes no se muestran.
    loadTenants();
    loadUsers();
    loadContextSources();
    loadSkills();
    loadFlowOptions();
    loadInvgateCatalog();

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
      // Con el header de sistema explícito, `/tenants/all` responde parado en cualquier
      // empresa: el superadmin es miembro del sistema, así que TenantGuard lo deja pasar
      // (mismo patrón que el alta de usuarios). Sin ese id (usuario común), va con el header
      // activo y solo responde en el tenant de sistema.
      const data = await apiFetch(
        '/tenants/all',
        systemTenantId ? { headers: { 'X-Tenant-Id': systemTenantId } } : undefined,
      );
      setAllTenants(data);
    } catch {
      // Sin acceso o sin permiso: los checkboxes simplemente no se muestran, no es un
      // error que deba interrumpir la carga del editor.
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

  async function loadContextSources() {
    try {
      const data = await apiFetch('/context-sources');
      setContextSources(data.filter((s: any) => s.isActive));
    } catch {
      // Sin permiso `context-sources:read` en el tenant actual: el selector queda
      // vacío, igual que allTenants/allUsers cuando falta el permiso equivalente.
      setContextSources([]);
    }
  }

  /** Skills del tenant activo, para el dropdown que reemplaza al viejo "context". */
  async function loadSkills() {
    try {
      const data = await apiFetch('/skills');
      setSkills(data.filter((s: any) => s.isActive));
    } catch {
      // Sin permiso `skills:read` en el tenant actual: el selector queda vacío.
      setSkills([]);
    }
  }

  /** Flujos del tenant activo, para el dropdown "ID del flujo" del nodo `subflow`. */
  async function loadFlowOptions() {
    try {
      const data = await apiFetch('/flows');
      setFlowOptions(data.map((f: any) => ({ id: f.id, name: f.name })));
    } catch {
      setFlowOptions([]);
    }
  }

  /** Catálogo de InvGate para el nodo `ticket_create` — ver comentario de los `useState`. */
  async function loadInvgateCatalog() {
    try {
      const [categories, priorities, types] = await Promise.all([
        apiFetch('/invgate/catalog/categories'),
        apiFetch('/invgate/catalog/priorities'),
        apiFetch('/invgate/catalog/types'),
      ]);
      setInvgateCategories(categories);
      setInvgatePriorities(priorities);
      setInvgateTypes(types);
    } catch {
      setInvgateCategories([]);
      setInvgatePriorities([]);
      setInvgateTypes([]);
    }
  }

  async function loadFlow() {
    try {
      const flow = await apiFetch(`/flows/${id}`);
      setFlowName(flow.name);
      setFlowDescription(flow.description || '');
      setContextSourceId(flow.contextSourceId || flow.contextSource?.id || '');
      setSkillId(flow.skillId || flow.skill?.id || '');
      const tenantFlows = flow.tenantFlows || [];
      const loaded: Assignment[] = tenantFlows.map((tf: any) => ({
        tenantId: tf.tenant.id,
        roleIds: (tf.roles || []).map((r: any) => r.roleId),
      }));
      setAssignments(loaded);
      setIsStartFlow(tenantFlows.some((tf: any) => tf.isStart));
      // Precargar los roles de las empresas ya asignadas: así el contador "X/Y" y
      // los chips del modal quedan completos apenas se abre.
      loadRolesForTenants(loaded.map((a) => a.tenantId));
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

  // Roles quedan sin flujo de inicio cuando no hay empresas: mantener el toggle
  // coherente (igual que el mock, que apaga "Inicio" al quedar sin empresas).
  useEffect(() => {
    if (assignments.length === 0 && isStartFlow) setIsStartFlow(false);
  }, [assignments, isStartFlow]);

  async function loadRolesForTenant(tenantId: string) {
    // Cache: si ya se cargaron, no repetir el request.
    if (rolesByTenant[tenantId]) return;
    try {
      // GET /roles con el header de la empresa objetivo (no /roles/by-tenant, que exige estar
      // parado en el sistema). TenantGuard deja al superadmin operar sobre cualquier empresa,
      // así que los roles se leen parado donde sea. Mismo mecanismo que el alta de usuarios.
      const data = await apiFetch('/roles', { headers: { 'X-Tenant-Id': tenantId } });
      setRolesByTenant((prev) => ({
        ...prev,
        [tenantId]: (data || []).map((r: any) => ({ id: r.id, name: r.name })),
      }));
    } catch {
      // Sin acceso o error: dejo la lista vacía para esa empresa. El modal muestra
      // "sin roles" en vez de romperse.
      setRolesByTenant((prev) => ({ ...prev, [tenantId]: prev[tenantId] || [] }));
    }
  }

  function loadRolesForTenants(tenantIds: string[]) {
    tenantIds.forEach((id) => loadRolesForTenant(id));
  }

  // ---- Helpers de lectura sobre el estado del modal ----
  const rolesFor = (tenantId: string): RoleOption[] => rolesByTenant[tenantId] || [];
  const getAssignment = (tenantId: string) => assignments.find((a) => a.tenantId === tenantId);
  const isRoleOn = (tenantId: string, roleId: string) =>
    !!getAssignment(tenantId)?.roleIds.includes(roleId);
  const totalRoles = () => assignments.reduce((sum, a) => sum + a.roleIds.length, 0);
  const availableTenants = () =>
    allTenants.filter((t) => !assignments.some((a) => a.tenantId === t.id));
  const tenantName = (tenantId: string) =>
    allTenants.find((t) => t.id === tenantId)?.name || tenantId;

  // ---- Mutaciones del modal (operan sobre `assignments`) ----
  function addTenant(tenantId: string) {
    if (getAssignment(tenantId)) return;
    setAssignments((prev) => [...prev, { tenantId, roleIds: [] }]);
    setExpandedTenants((prev) => (prev.includes(tenantId) ? prev : [...prev, tenantId]));
    loadRolesForTenant(tenantId);
  }
  function removeTenant(tenantId: string) {
    setAssignments((prev) => prev.filter((a) => a.tenantId !== tenantId));
    setExpandedTenants((prev) => prev.filter((x) => x !== tenantId));
  }
  function toggleRole(tenantId: string, roleId: string, on: boolean) {
    setAssignments((prev) =>
      prev.map((a) =>
        a.tenantId !== tenantId
          ? a
          : {
              ...a,
              roleIds: on
                ? a.roleIds.includes(roleId)
                  ? a.roleIds
                  : [...a.roleIds, roleId]
                : a.roleIds.filter((x) => x !== roleId),
            },
      ),
    );
  }
  function selectAllRoles(tenantId: string) {
    // Snapshot de los roles existentes al momento de marcar, no comodín: si después
    // se crea un rol nuevo en la empresa, no queda incluido solo.
    const all = rolesFor(tenantId).map((r) => r.id);
    setAssignments((prev) => prev.map((a) => (a.tenantId === tenantId ? { ...a, roleIds: all } : a)));
  }
  function clearAllRoles(tenantId: string) {
    setAssignments((prev) => prev.map((a) => (a.tenantId === tenantId ? { ...a, roleIds: [] } : a)));
  }
  function toggleExpand(tenantId: string) {
    setExpandedTenants((prev) =>
      prev.includes(tenantId) ? prev.filter((x) => x !== tenantId) : [...prev, tenantId],
    );
  }

  // ---- Abrir / cerrar el modal ----
  function openModal() {
    // Snapshot para poder descartar con "Cancelar". La persistencia real recién
    // ocurre con el "Guardar" del header del editor (saveFlow).
    setAssignmentsSnapshot(JSON.parse(JSON.stringify(assignments)));
    setModalOpen(true);
  }
  function closeModal(save: boolean) {
    if (!save && assignmentsSnapshot) setAssignments(assignmentsSnapshot);
    setAssignmentsSnapshot(null);
    setModalOpen(false);
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
        // Vacío a propósito (no 'medium' como antes): category/priority/ticketType van por
        // nombre real de InvGate — un valor en inglés inventado no matchea nada y termina
        // cayendo al default de /settings igual, pero mostraba "Prioridad: medium" en el
        // nodo como si fuera un valor real elegido.
        return { subject: '', description: '', category: '', priority: '', ticketType: '' };
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
      case 'sms':
        return { message: '', recipients: [] };
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
    // Aviso al vaciar: dejar el flujo sin empresas no lo borra, pero no lo recibe
    // nadie y queda "sin asignar". Confirmamos antes de persistir para que sea
    // intencional (aplica tanto a quitar la última empresa como a no asignar ninguna).
    if (assignments.length === 0) {
      const ok = confirm(
        'Este flujo va a quedar sin empresas asignadas: no lo va a recibir ningún usuario ' +
          'y aparecerá como "sin asignar" en la lista. ¿Guardar igual?',
      );
      if (!ok) return;
    }
    setSaving(true);
    try {
      const payload = {
        name: flowName,
        description: flowDescription,
        contextSourceId: contextSourceId || null,
        skillId: skillId || null,
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
            assignments,
            isStart: isStartFlow,
          }),
        });
        router.replace(`/dashboard/flows/edit?id=${created.id}`);
      } else {
        await apiFetch(`/flows/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        // La asignación de empresas y roles es un endpoint aparte del resto de los
        // campos del flujo (igual que ya era antes de agregar los checkboxes).
        await apiFetch(`/flows/${id}/assign-tenants`, {
          method: 'POST',
          body: JSON.stringify({ assignments, isStart: isStartFlow }),
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
    // `-m-6` cancela el padding de 24px que el layout del dashboard (main con p-6)
    // pone alrededor: así el editor va borde a borde y ocupa exactamente el alto de
    // la ventana. Sin esto, h-screen (100vh) + ese padding se pasan del viewport y
    // aparece scroll, que además cortaba los controles de zoom de abajo del canvas.
    // overflow-hidden asegura que nada del propio editor genere scroll de página.
    <div className="-m-6 h-screen flex flex-col overflow-hidden">
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
          <div className="flex flex-col gap-0.5">
            <label htmlFor="flow-skill" className="text-[11px] text-gray-400">
              Skill
            </label>
            <select
              id="flow-skill"
              value={skillId}
              onChange={(e) => setSkillId(e.target.value)}
              className="text-gray-600 border rounded px-2 py-1 text-sm"
              title="Skill: texto de contexto que se agrega al system prompt base de este flujo"
            >
              <option value="">Sin skill</option>
              {skills.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-0.5">
            <label htmlFor="flow-context-source" className="text-[11px] text-gray-400">
              Fuente de verdad
            </label>
            <select
              id="flow-context-source"
              value={contextSourceId}
              onChange={(e) => setContextSourceId(e.target.value)}
              className="text-gray-600 border rounded px-2 py-1 text-sm"
              title="Fuente de verdad (MCP/RAG/n8n/broker) que este flujo puede consultar"
            >
              <option value="">Sin fuente de verdad</option>
              {contextSources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.type})
                </option>
              ))}
            </select>
          </div>
        </div>
        <button
          onClick={saveFlow}
          disabled={saving}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? 'Guardando...' : 'Guardar'}
        </button>
      </div>

      {/* Asignación a empresas y roles: en qué empresas está disponible este flujo,
          qué roles lo reciben en cada una, y si es el flujo de inicio para esos
          pares (empresa + rol). Solo se muestra si se pudo cargar la lista de empresas
          (el superadmin, parado en cualquier empresa; ver loadTenants). */}
      {allTenants.length > 0 && (
        <div className="bg-gray-50 border-b px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span className="text-gray-500 font-medium">Disponible en:</span>

          <button
            type="button"
            onClick={openModal}
            className="inline-flex items-center gap-2 bg-white border border-gray-300 text-gray-700 px-3 py-1.5 rounded-lg font-medium hover:bg-gray-50 hover:border-gray-400"
          >
            <svg
              className="w-4 h-4 text-blue-600"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 21h18" />
              <path d="M5 21V7l7-4 7 4v14" />
              <path d="M9 9h.01M9 13h.01M9 17h.01M15 9h.01M15 13h.01M15 17h.01" />
            </svg>
            Empresas y roles
            <span className="bg-blue-100 text-blue-700 text-xs font-semibold rounded-full px-1.5 py-0.5">
              {assignments.length}
            </span>
          </button>

          <div className="flex items-center gap-2 text-gray-600">
            {assignments.length === 0 ? (
              <span className="text-gray-400 italic">Sin empresas asignadas</span>
            ) : (
              <span className="text-gray-700 font-semibold">
                {assignments.length} {assignments.length === 1 ? 'empresa' : 'empresas'} ·{' '}
                {totalRoles()} {totalRoles() === 1 ? 'rol' : 'roles'}
              </span>
            )}
          </div>

          <label
            className="flex items-center gap-1.5 cursor-pointer border-l pl-4 select-none"
            title="Un flujo de inicio por (empresa + rol). Si otro flujo ya era el inicio para alguno de esos pares, se lo reemplaza al guardar."
          >
            <input
              type="checkbox"
              checked={isStartFlow}
              disabled={assignments.length === 0}
              onChange={(e) => setIsStartFlow(e.target.checked)}
            />
            <span className={assignments.length === 0 ? 'text-gray-400' : ''}>
              Inicio{' '}
              {assignments.length === 0 && (
                <span className="text-gray-400 text-xs">(elegí una empresa primero)</span>
              )}
            </span>
          </label>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* Sidebar - Node Types */}
        <div className="w-48 bg-gray-50 border-r p-4 overflow-y-auto min-h-0">
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
          <div className="w-72 bg-white border-l p-4 overflow-y-auto min-h-0">
            <h3 className="font-semibold mb-4">Propiedades</h3>
            <p className="text-xs text-gray-500 mb-4">{selectedNode.type}</p>
            <NodeProperties
              node={selectedNode}
              onUpdate={updateNodeData}
              users={allUsers}
              flows={flowOptions.filter((f) => f.id !== id)}
              invgateCategories={invgateCategories}
              invgatePriorities={invgatePriorities}
              invgateTypes={invgateTypes}
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

      {/* Modal "Empresas y roles": acordeón por empresa con sus roles. Escribe sobre
          `assignments`; la persistencia real recae en el "Guardar" del header. */}
      {modalOpen && (
        <div
          className="fixed inset-0 bg-slate-900/55 flex items-center justify-center p-6 z-50"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal(false);
          }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden">
            {/* Header del modal */}
            <div className="px-5 py-4 border-b flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Empresas y roles</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  Elegí en qué empresas está disponible el flujo y, dentro de cada una, qué roles lo
                  reciben.
                </p>
              </div>
              <button
                onClick={() => closeModal(false)}
                className="text-gray-400 hover:text-gray-700 text-2xl leading-none"
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>

            {/* Body: acordeón + agregar empresa */}
            <div className="px-5 py-4 overflow-auto">
              {assignments.length === 0 && (
                <div className="text-center text-gray-400 py-6 text-sm">
                  No hay empresas asignadas todavía.
                </div>
              )}

              {assignments.map((a) => {
                const roles = rolesFor(a.tenantId);
                const open = expandedTenants.includes(a.tenantId);
                return (
                  <div key={a.tenantId} className="border rounded-xl mb-2.5 overflow-hidden">
                    <div
                      className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer bg-gray-50 hover:bg-gray-100"
                      onClick={() => toggleExpand(a.tenantId)}
                    >
                      <span className="text-gray-400 w-3">{open ? '▾' : '▸'}</span>
                      <span className="font-semibold">{tenantName(a.tenantId)}</span>
                      <span className="text-gray-500 text-xs">
                        {a.roleIds.length}/{roles.length} roles
                      </span>
                      <span className="ml-auto" />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeTenant(a.tenantId);
                        }}
                        className="text-red-600 text-xs px-1.5 py-0.5 rounded hover:bg-red-50"
                      >
                        Quitar
                      </button>
                    </div>

                    {open && (
                      <div className="p-3 border-t">
                        {roles.length === 0 ? (
                          <p className="text-gray-400 text-xs">Sin roles en esta empresa.</p>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {roles.map((r) => {
                              const on = isRoleOn(a.tenantId, r.id);
                              return (
                                <label
                                  key={r.id}
                                  className={`inline-flex items-center gap-1.5 border px-2.5 py-1 rounded-full text-sm cursor-pointer ${
                                    on
                                      ? 'bg-blue-50 border-blue-200 text-blue-700 font-medium'
                                      : 'bg-white border-gray-300 text-gray-700 hover:border-gray-400'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    className="m-0"
                                    checked={on}
                                    onChange={(e) => toggleRole(a.tenantId, r.id, e.target.checked)}
                                  />
                                  <span>{r.name}</span>
                                </label>
                              );
                            })}
                          </div>
                        )}

                        {roles.length > 0 && (
                          <div className="flex gap-2 mt-2.5">
                            <button
                              onClick={() => selectAllRoles(a.tenantId)}
                              className="text-blue-600 text-xs px-1 py-0.5 rounded hover:bg-blue-50"
                            >
                              Seleccionar todos
                            </button>
                            <button
                              onClick={() => clearAllRoles(a.tenantId)}
                              className="text-blue-600 text-xs px-1 py-0.5 rounded hover:bg-blue-50"
                            >
                              Limpiar
                            </button>
                          </div>
                        )}

                        {a.roleIds.length === 0 && (
                          <div className="mt-2.5 inline-block text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 text-xs">
                            Sin roles: ningún usuario de {tenantName(a.tenantId)} recibe este flujo.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {availableTenants().length > 0 ? (
                <div className="mt-3">
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) addTenant(e.target.value);
                    }}
                    className="border border-dashed border-gray-400 bg-white text-gray-600 rounded-lg px-2.5 py-1.5 text-sm min-w-[210px]"
                  >
                    <option value="">+ Agregar empresa…</option>
                    {availableTenants().map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <p className="text-gray-400 text-xs mt-3">Todas las empresas ya están agregadas.</p>
              )}
            </div>

            {/* Footer del modal */}
            <div className="px-5 py-3.5 border-t flex justify-between items-center gap-3">
              <span className="text-xs text-gray-400 max-w-[60%]">
                Sin roles marcados en una empresa = ningún usuario de esa empresa recibe el flujo.
              </span>
              <div className="flex gap-2.5">
                <button
                  onClick={() => closeModal(false)}
                  className="bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded hover:bg-gray-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => closeModal(true)}
                  className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
                >
                  Guardar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NodeProperties({
  node,
  onUpdate,
  users,
  flows,
  invgateCategories,
  invgatePriorities,
  invgateTypes,
}: {
  node: Node;
  onUpdate: (key: string, value: any) => void;
  users: UserOption[];
  flows: FlowOption[];
  invgateCategories: InvgateCatalogOption[];
  invgatePriorities: InvgateCatalogOption[];
  invgateTypes: InvgateCatalogOption[];
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
            <p className="text-xs text-gray-400 mt-1">
              Vacío: usa <code>{'{{subject}}'}</code> de la charla o los primeros 100 caracteres del mensaje.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Descripción</label>
            <textarea
              value={data.description || ''}
              onChange={(e) => onUpdate('description', e.target.value)}
              className="w-full border rounded p-2 text-sm"
              rows={3}
            />
            <p className="text-xs text-gray-400 mt-1">
              Vacío: usa <code>{'{{description}}'}</code> de la charla o el mensaje del usuario.
            </p>
          </div>
          {/* Categoría/prioridad/tipo van por NOMBRE real de InvGate (no un id) — el bot
              los resuelve contra el catálogo al crear el ticket (InvgateService.resolveCategoryId/
              resolvePriorityId/resolveTypeId). Vacío en cualquiera de los tres: usa el default
              de /settings > "Integración: InvGate". Si el catálogo no cargó (InvGate sin
              configurar, o sin permiso), cae a un campo de texto libre para no bloquear la edición. */}
          <div>
            <label className="block text-sm font-medium mb-1">Categoría (InvGate)</label>
            {invgateCategories.length > 0 ? (
              <select
                value={data.category || ''}
                onChange={(e) => onUpdate('category', e.target.value)}
                className="w-full border rounded p-2 text-sm"
              >
                <option value="">(usar default de /settings)</option>
                {invgateCategories.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={data.category || ''}
                onChange={(e) => onUpdate('category', e.target.value)}
                placeholder="Nombre exacto de la categoría en InvGate"
                className="w-full border rounded p-2 text-sm"
              />
            )}
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Prioridad (InvGate)</label>
            {invgatePriorities.length > 0 ? (
              <select
                value={data.priority || ''}
                onChange={(e) => onUpdate('priority', e.target.value)}
                className="w-full border rounded p-2 text-sm"
              >
                <option value="">(usar default de /settings)</option>
                {invgatePriorities.map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={data.priority || ''}
                onChange={(e) => onUpdate('priority', e.target.value)}
                placeholder="Nombre exacto de la prioridad en InvGate"
                className="w-full border rounded p-2 text-sm"
              />
            )}
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Tipo de incidente (InvGate)</label>
            {invgateTypes.length > 0 ? (
              <select
                value={data.ticketType || ''}
                onChange={(e) => onUpdate('ticketType', e.target.value)}
                className="w-full border rounded p-2 text-sm"
              >
                <option value="">(usar default de /settings)</option>
                {invgateTypes.map((t) => (
                  <option key={t.id} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={data.ticketType || ''}
                onChange={(e) => onUpdate('ticketType', e.target.value)}
                placeholder="Nombre exacto del tipo en InvGate"
                className="w-full border rounded p-2 text-sm"
              />
            )}
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
          {data.systemPrompt && (
            <div>
              <label className="block text-sm font-medium mb-1">Prompt base</label>
              <div className="flex gap-4 text-sm text-gray-600">
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    name={`systemPromptMode-${node.id}`}
                    checked={(data.systemPromptMode || 'replace') === 'replace'}
                    onChange={() => onUpdate('systemPromptMode', 'replace')}
                  />
                  Reemplaza
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    name={`systemPromptMode-${node.id}`}
                    checked={data.systemPromptMode === 'append'}
                    onChange={() => onUpdate('systemPromptMode', 'append')}
                  />
                  Agrega
                </label>
              </div>
              <p className="text-[11px] text-gray-400 mt-1">
                Cómo combina este System Prompt con el prompt base (settings + Skill del
                flujo): lo reemplaza entero, o se agrega a continuación.
              </p>
            </div>
          )}
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
            <label className="block text-sm font-medium mb-1">Flujo</label>
            <select
              value={data.flowId || ''}
              onChange={(e) => {
                const target = flows.find((f) => f.id === e.target.value);
                onUpdate('flowId', e.target.value);
                // El nombre viaja aparte (`flowName`, solo visual en el nodo) —
                // se completa solo al elegir, pero sigue siendo editable a mano.
                onUpdate('flowName', target?.name || '');
              }}
              className="w-full border rounded p-2 text-sm"
            >
              <option value="">Elegí un flujo…</option>
              {flows.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            {flows.length === 0 && (
              <p className="text-xs text-gray-400 mt-1">
                No hay otros flujos disponibles en la empresa activa.
              </p>
            )}
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

      {type === 'sms' && (
        <>
          <div>
            <label className="block text-sm font-medium mb-1">Mensaje</label>
            <p className="text-xs text-gray-400 mb-1">
              Admite variables del flujo, ej. {'{{userName}}'}.
            </p>
            <textarea
              value={data.message || ''}
              onChange={(e) => onUpdate('message', e.target.value)}
              className="w-full border rounded p-2 text-sm"
              rows={3}
              placeholder="Ej: Hola {{userName}}, tu ticket #{{lastTicketId}} fue actualizado."
            />
          </div>

          <UserPickerList
            label="Destinatarios"
            values={data.recipients || []}
            users={users}
            onChange={(next) => onUpdate('recipients', next)}
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
    // useSearchParams() opts the tree below it into client-side rendering — Next
    // requires a Suspense boundary around it (matters for `output: 'export'`, ver
    // apps/web/next.config.ts).
    <Suspense fallback={null}>
      <ReactFlowProvider>
        <FlowEditorInner />
      </ReactFlowProvider>
    </Suspense>
  );
}
