/**
 * Saca el 9 de móvil argentino (`+54 9 11...`) que WhatsApp exige en el E.164 pero que otros
 * sistemas (SMS por red celular, InvGate) no usan — sin sacarlo, el número no matchea/entrega.
 */
export function stripArgentinaMobileNine(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '');
  return digits.startsWith('549') ? `+54${digits.slice(3)}` : `+${digits}`;
}
