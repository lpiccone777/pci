'use client';

import { memo, useCallback, useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  EdgeProps,
  getBezierPath,
  useReactFlow,
} from '@xyflow/react';

function DeleteButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center hover:bg-red-600 shadow cursor-pointer"
      style={{ pointerEvents: 'all' }}
    >
      ×
    </button>
  );
}

export const DeletableEdge = memo((props: EdgeProps) => {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    label,
    markerEnd,
    markerStart,
    selected,
  } = props;

  const { deleteElements } = useReactFlow();
  const [hovered, setHovered] = useState(false);

  // Bézier en vez de smoothstep: con varios nodos alineados vertical u
  // horizontalmente (ej. varias opciones de un menú convergiendo al mismo nodo
  // siguiente), los tramos en ángulo recto de smoothstep comparten carril y se
  // pisan — la curva se separa visualmente incluso cuando origen/destino son
  // parecidos, así se distingue a qué opción pertenece cada trazo.
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  /**
   * Usa `deleteElements` y NO `setEdges` de useReactFlow.
   *
   * El editor maneja las aristas de forma controlada (`useEdgesState` en la página y
   * `edges={edges}` como prop). `setEdges` escribe solo en el store interno de
   * ReactFlow: el estado del padre queda intacto y en el siguiente render la prop
   * vuelve a pisar el store, así que la arista "borrada" reaparece.
   *
   * `deleteElements` genera un change de tipo remove que viaja por `onEdgesChange`,
   * que es lo que actualiza el estado del padre de verdad.
   */
  const handleDelete = useCallback(() => {
    void deleteElements({ edges: [{ id }] });
  }, [id, deleteElements]);

  return (
    <>
      {/* Zona invisible más ancha, para que sea fácil pasar el mouse por encima.
          No borra al hacer click: un click accidental sobre la flecha borrándola
          sin aviso es un mal default. Para borrar, el botón × o la tecla Supr. */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        className="react-flow__edge-interaction"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      {/* Visible edge — seleccionada: punteada + azul fuerte, para distinguirla de
          las demás cuando hay varios trazos cruzándose cerca uno del otro. */}
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        markerStart={markerStart}
        style={{
          strokeWidth: selected ? 3 : hovered ? 3 : 2,
          stroke: selected ? '#2563eb' : hovered ? '#3b82f6' : '#94a3b8',
          strokeDasharray: selected ? '6 4' : undefined,
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
          }}
          className="nodrag nopan"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          {label && (
            <div className="bg-white px-2 py-0.5 rounded border text-xs text-gray-600 mb-1 text-center">
              {label}
            </div>
          )}
          {hovered && <DeleteButton onClick={handleDelete} />}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

DeletableEdge.displayName = 'DeletableEdge';
