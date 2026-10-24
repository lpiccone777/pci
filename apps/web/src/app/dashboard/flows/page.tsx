'use client';

import FlowsList from '@/components/flows/flows-list';

/** Flujos IVR (WhatsApp/SMS): la pantalla vive en `components/flows/`, compartida por los dos canales. */
export default function Page() {
  return <FlowsList channel="text" />;
}
