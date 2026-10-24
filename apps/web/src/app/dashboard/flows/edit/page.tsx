'use client';

import FlowEditor from '@/components/flows/flow-editor';

/** Editor de un flujo IVR: la pantalla vive en `components/flows/`, compartida por los dos canales. */
export default function Page() {
  return <FlowEditor channel="text" />;
}
