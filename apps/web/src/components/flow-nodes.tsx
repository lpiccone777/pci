'use client';

import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';

const nodeColors: Record<string, string> = {
  start: '#10b981',
  message: '#3b82f6',
  menu: '#8b5cf6',
  input: '#f59e0b',
  condition: '#ef4444',
  ticket_create: '#ec4899',
  ticket_query: '#ec4899',
  transfer_agent: '#6366f1',
  llm_query: '#14b8a6',
  delay: '#6b7280',
  variable: '#84cc16',
  webhook: '#f97316',
};

const nodeLabels: Record<string, string> = {
  start: 'Inicio',
  message: 'Mensaje',
  menu: 'Menú',
  input: 'Input',
  condition: 'Condición',
  ticket_create: 'Crear Ticket',
  ticket_query: 'Consultar Ticket',
  transfer_agent: 'Transferir',
  llm_query: 'Consultar LLM',
  delay: 'Delay',
  variable: 'Variable',
  webhook: 'Webhook',
};

function BaseNode({ id, data, type, children }: any) {
  const color = nodeColors[type] || '#6b7280';
  const label = nodeLabels[type] || type;
  const text = data?.text || '';

  return (
    <div
      className="rounded-lg shadow-md border-2 bg-white"
      style={{ borderColor: color, minWidth: 180, maxWidth: 240 }}
    >
      {/* Header */}
      <div
        className="text-white text-xs font-semibold px-2 py-1 rounded-t-md flex items-center gap-1"
        style={{ backgroundColor: color }}
      >
        <div className="w-2 h-2 rounded-full bg-white/80" />
        {label}
      </div>

      {/* Content */}
      <div className="p-2 text-sm text-gray-700">
        {text ? (
          <p className="line-clamp-3 text-xs">{text}</p>
        ) : (
          <p className="text-gray-400 text-xs italic">Sin texto</p>
        )}
        {children}
      </div>

      {/* Handles */}
      <Handle type="target" position={Position.Top} style={{ background: color }} />
      <Handle type="source" position={Position.Bottom} style={{ background: color }} />
    </div>
  );
}

export const StartNode = memo(({ id, data }: any) => (
  <div
    className="rounded-lg shadow-md border-2 bg-white"
    style={{ borderColor: '#10b981', minWidth: 200, maxWidth: 260 }}
  >
    {/* Header */}
    <div
      className="text-white text-xs font-semibold px-2 py-1 rounded-t-md flex items-center gap-1"
      style={{ backgroundColor: '#10b981' }}
    >
      <div className="w-2 h-2 rounded-full bg-white/80" />
      Inicio / Identificación
    </div>

    {/* Content */}
    <div className="p-2 text-sm text-gray-700">
      <div className="text-xs text-gray-500 mb-1">Identifica usuario por teléfono</div>
      {data?.text && <p className="text-xs line-clamp-2 text-gray-700">{data.text}</p>}
      <div className="mt-1 text-[10px] text-gray-400">
        Guarda: isKnownUser, userName, userPhone
      </div>
      {/* Show targets if configured */}
      <div className="mt-1 space-y-0.5">
        {data?.knownTargetNodeId && (
          <div className="text-[10px] text-green-600 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            Conocido → {data.knownTargetNodeId.substring(0, 12)}...
          </div>
        )}
        {data?.unknownTargetNodeId && (
          <div className="text-[10px] text-orange-600 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-orange-500" />
            Desconocido → {data.unknownTargetNodeId.substring(0, 12)}...
          </div>
        )}
      </div>
    </div>

    {/* Target handle (top) */}
    <Handle type="target" position={Position.Top} style={{ background: '#10b981' }} />

    {/* Source handles (bottom) - two exits */}
    <div className="relative h-3">
      <Handle
        type="source"
        id="known"
        position={Position.Bottom}
        style={{ background: '#22c55e', left: '25%' }}
      />
      <div
        className="absolute text-[9px] text-green-600 font-semibold"
        style={{ bottom: 4, left: '25%', transform: 'translateX(-50%)' }}
      >
        conocido
      </div>

      <Handle
        type="source"
        id="unknown"
        position={Position.Bottom}
        style={{ background: '#f97316', left: '75%' }}
      />
      <div
        className="absolute text-[9px] text-orange-600 font-semibold"
        style={{ bottom: 4, left: '75%', transform: 'translateX(-50%)' }}
      >
        desconocido
      </div>
    </div>
  </div>
));

export const MessageNode = memo(({ id, data }: any) => (
  <BaseNode id={id} data={data} type="message" />
));

export const MenuNode = memo(({ id, data }: any) => {
  const options = data?.options || [];
  const color = nodeColors.menu;

  return (
    <div
      className="rounded-lg shadow-md border-2 bg-white"
      style={{ borderColor: color, minWidth: 200, maxWidth: 280 }}
    >
      {/* Header */}
      <div
        className="text-white text-xs font-semibold px-2 py-1 rounded-t-md flex items-center gap-1"
        style={{ backgroundColor: color }}
      >
        <div className="w-2 h-2 rounded-full bg-white/80" />
        {nodeLabels.menu}
      </div>

      {/* Content */}
      <div className="p-2 text-sm text-gray-700">
        {data?.text && <p className="text-xs line-clamp-2">{data.text}</p>}
        {options.length > 0 && (
          <div className="mt-1 space-y-0.5">
            {options.map((opt: any, i: number) => (
              <div key={i} className="text-xs text-gray-500 flex items-center gap-1">
                <span className="w-4 h-4 rounded bg-gray-100 flex items-center justify-center text-[10px]">
                  {i + 1}
                </span>
                {opt.label}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Target handle (top) */}
      <Handle type="target" position={Position.Top} style={{ background: color }} />

      {/* Source handles: one per option, distributed horizontally */}
      {options.length === 0 && (
        <Handle type="source" position={Position.Bottom} style={{ background: color }} />
      )}
      {options.map((opt: any, i: number) => {
        const total = options.length;
        const leftPercent = total === 1 ? 50 : ((i / (total - 1)) * 80 + 10);
        return (
          <div key={opt.value || i} className="relative" style={{ height: 12 }}>
            <Handle
              type="source"
              id={String(opt.value)}
              position={Position.Bottom}
              style={{
                background: color,
                left: `${leftPercent}%`,
              }}
            />
            <div
              className="absolute text-[9px] text-gray-500 font-medium whitespace-nowrap"
              style={{
                bottom: 0,
                left: `${leftPercent}%`,
                transform: 'translateX(-50%)',
              }}
            >
              {opt.value}
            </div>
          </div>
        );
      })}
    </div>
  );
});

export const InputNode = memo(({ id, data }: any) => (
  <BaseNode id={id} data={data} type="input">
    {data?.variableName && (
      <div className="mt-1 text-xs text-gray-500">
        Var: <span className="font-mono bg-gray-100 px-1 rounded">{data.variableName}</span>
      </div>
    )}
  </BaseNode>
));

export const ConditionNode = memo(({ id, data }: any) => (
  <BaseNode id={id} data={data} type="condition">
    {data?.conditions && (
      <div className="mt-1 text-xs text-gray-500">
        {data.conditions.length} condición(es)
      </div>
    )}
  </BaseNode>
));

export const TicketCreateNode = memo(({ id, data }: any) => (
  <BaseNode id={id} data={data} type="ticket_create">
    {data?.subject && (
      <div className="mt-1 text-xs text-gray-500">Asunto: {data.subject}</div>
    )}
    {data?.priority && (
      <div className="text-xs text-gray-500">Prioridad: {data.priority}</div>
    )}
  </BaseNode>
));

export const TicketQueryNode = memo(({ id, data }: any) => (
  <BaseNode id={id} data={data} type="ticket_query">
    {data?.ticketIdVariable && (
      <div className="mt-1 text-xs text-gray-500">Var: {data.ticketIdVariable}</div>
    )}
  </BaseNode>
));

export const TransferAgentNode = memo(({ id, data }: any) => (
  <BaseNode id={id} data={data} type="transfer_agent" />
));

export const LlmQueryNode = memo(({ id, data }: any) => (
  <BaseNode id={id} data={data} type="llm_query">
    {data?.systemPrompt && (
      <div className="mt-1 text-xs text-gray-500 line-clamp-1">Prompt configurado</div>
    )}
  </BaseNode>
));

export const DelayNode = memo(({ id, data }: any) => (
  <BaseNode id={id} data={data} type="delay">
    {data?.seconds && (
      <div className="mt-1 text-xs text-gray-500">{data.seconds}s</div>
    )}
  </BaseNode>
));

export const VariableNode = memo(({ id, data }: any) => (
  <BaseNode id={id} data={data} type="variable">
    {data?.name && (
      <div className="mt-1 text-xs text-gray-500">
        {data.action === 'set' ? 'Set' : 'Get'} {data.name}
      </div>
    )}
  </BaseNode>
));

export const WebhookNode = memo(({ id, data }: any) => (
  <BaseNode id={id} data={data} type="webhook">
    {data?.url && (
      <div className="mt-1 text-xs text-gray-500 line-clamp-1">{data.url}</div>
    )}
    {data?.method && (
      <div className="text-xs text-gray-500">{data.method}</div>
    )}
  </BaseNode>
));

export const SubflowNode = memo(({ id, data }: any) => (
  <div
    className="rounded-lg shadow-md border-2 bg-white"
    style={{ borderColor: '#06b6d4', minWidth: 180, maxWidth: 240 }}
  >
    <div
      className="text-white text-xs font-semibold px-2 py-1 rounded-t-md flex items-center gap-1"
      style={{ backgroundColor: '#06b6d4' }}
    >
      <div className="w-2 h-2 rounded-full bg-white/80" />
      Sub-flujo
    </div>
    <div className="p-2 text-sm text-gray-700">
      {data?.flowName ? (
        <p className="text-xs font-medium text-cyan-700">{data.flowName}</p>
      ) : data?.flowId ? (
        <p className="text-xs font-mono text-gray-500">{data.flowId.substring(0, 12)}...</p>
      ) : (
        <p className="text-xs text-gray-400 italic">Sin flujo asignado</p>
      )}
      {data?.entryNodeId && (
        <p className="text-[10px] text-gray-400 mt-1">Entrada: {data.entryNodeId.substring(0, 12)}...</p>
      )}
    </div>
    <Handle type="target" position={Position.Top} style={{ background: '#06b6d4' }} />
    <Handle type="source" position={Position.Bottom} style={{ background: '#06b6d4' }} />
  </div>
));
