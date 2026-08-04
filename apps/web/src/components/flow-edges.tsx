'use client';

import { memo, useCallback, useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  EdgeProps,
  getSmoothStepPath,
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
  } = props;

  const { deleteElements } = useReactFlow();
  const [hovered, setHovered] = useState(false);

  const [edgePath, labelX, labelY] = getSmoothStepPath({
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
      {/* Visible edge */}
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        markerStart={markerStart}
        style={{
          strokeWidth: hovered ? 3 : 2,
          stroke: hovered ? '#3b82f6' : '#94a3b8',
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
