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

  const { setEdges } = useReactFlow();
  const [hovered, setHovered] = useState(false);

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const handleDelete = useCallback(() => {
    setEdges((eds) => eds.filter((edge) => edge.id !== id));
  }, [id, setEdges]);

  return (
    <>
      {/* Invisible wider path for easier hover / click */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        className="react-flow__edge-interaction"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={(e) => {
          e.stopPropagation();
          handleDelete();
        }}
        style={{ cursor: 'pointer' }}
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
