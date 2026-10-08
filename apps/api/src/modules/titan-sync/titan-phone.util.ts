/**
 * Convierte un teléfono de TitanHR (texto libre: "11 2233-4455", "011 15 2233-4455",
 * "+54 9 11 2233 4455"...) al formato con el que WhatsApp identifica al remitente en PCI:
 * `+549` + código de área + número, sin espacios. Es lo que compara exacto
 * `UsersService.findMembershipByPhone` — un número mal normalizado deja al usuario afuera
 * del bot ("no hablamos con desconocidos") aunque esté importado.
 *
 * Asume Argentina cuando el número no trae código de país, que es el caso de Titan hoy.
 * Ante algo que no se puede interpretar sin adivinar devuelve `null`: mejor importar al
 * usuario sin teléfono (y reportarlo) que con uno que matchee a otra persona.
 */
export function toWhatsappPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  // Prefijo internacional "00" (0054...) equivale a "+".
  const international = trimmed.startsWith('+') || digits.startsWith('00');
  if (digits.startsWith('00')) digits = digits.slice(2);

  if (international || (digits.startsWith('54') && digits.length >= 12)) {
    if (!digits.startsWith('54')) {
      // Otro país: se respeta tal cual, con un largo E.164 razonable.
      return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
    }
    digits = digits.slice(2);
    if (digits.startsWith('9')) digits = digits.slice(1);
  }

  // Formato nacional: 0 de larga distancia adelante.
  if (digits.startsWith('0')) digits = digits.slice(1);

  // "15" de celular después del código de área (área de 2 a 4 dígitos): 11 15 2233-4455.
  // Con área + 15 + número el total queda en 12 dígitos.
  if (digits.length === 12) {
    for (const areaLen of [2, 3, 4]) {
      if (digits.slice(areaLen, areaLen + 2) === '15') {
        digits = digits.slice(0, areaLen) + digits.slice(areaLen + 2);
        break;
      }
    }
  }

  // Área + número siempre suman 10 dígitos en Argentina.
  return digits.length === 10 ? `+549${digits}` : null;
}
