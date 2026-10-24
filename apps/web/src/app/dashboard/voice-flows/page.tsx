'use client';

import FlowsList from '@/components/flows/flows-list';

/** Flujos de voz (llamadas del voicebot): la pantalla vive en `components/flows/`, compartida por los dos canales. */
export default function Page() {
  return <FlowsList channel="voice" />;
}
