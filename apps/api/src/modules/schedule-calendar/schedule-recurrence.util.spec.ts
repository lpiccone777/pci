import { occursOn, RecurringEntry } from './schedule-recurrence.util';

function entry(overrides: Partial<RecurringEntry>): RecurringEntry {
  return {
    startAt: new Date('2026-01-05T20:00:00.000Z'),
    endAt: new Date('2026-01-05T22:00:00.000Z'),
    recurrenceFreq: null,
    recurrenceUntil: null,
    ...overrides,
  };
}

describe('occursOn — sin repetición', () => {
  it('matchea dentro del rango original', () => {
    expect(occursOn(entry({}), new Date('2026-01-05T21:00:00.000Z'))).toBe(true);
  });

  it('los límites startAt/endAt son inclusivos', () => {
    const e = entry({});
    expect(occursOn(e, e.startAt)).toBe(true);
    expect(occursOn(e, e.endAt)).toBe(true);
  });

  it('no matchea fuera del rango', () => {
    expect(occursOn(entry({}), new Date('2026-01-05T19:59:59.000Z'))).toBe(false);
    expect(occursOn(entry({}), new Date('2026-01-05T22:00:01.000Z'))).toBe(false);
  });

  it('un rango que cruza medianoche matchea la madrugada siguiente', () => {
    // Guardia 20:00 -> 08:00(+1): startAt/endAt son DateTime literales, así que un rango
    // que cruza medianoche ya es continuo, sin lógica especial.
    const e = entry({ endAt: new Date('2026-01-06T08:00:00.000Z') });
    expect(occursOn(e, new Date('2026-01-06T02:00:00.000Z'))).toBe(true);
  });
});

describe('occursOn — repetición diaria', () => {
  const e = entry({ recurrenceFreq: 'daily' });

  it('matchea 5 días después, mismo horario', () => {
    expect(occursOn(e, new Date('2026-01-10T21:00:00.000Z'))).toBe(true);
  });

  it('no matchea fuera del horario de un día que sí repite', () => {
    expect(occursOn(e, new Date('2026-01-10T23:00:00.000Z'))).toBe(false);
  });

  it('no matchea antes de la primera ocurrencia (anchor)', () => {
    expect(occursOn(e, new Date('2026-01-04T21:00:00.000Z'))).toBe(false);
  });

  it('sin recurrenceUntil (null) repite indefinidamente', () => {
    expect(occursOn(e, new Date('2027-06-15T21:00:00.000Z'))).toBe(true);
  });

  it('deja de matchear después de recurrenceUntil', () => {
    const withUntil = entry({ recurrenceFreq: 'daily', recurrenceUntil: new Date('2026-01-08T00:00:00.000Z') });
    expect(occursOn(withUntil, new Date('2026-01-07T21:00:00.000Z'))).toBe(true);
    expect(occursOn(withUntil, new Date('2026-01-09T21:00:00.000Z'))).toBe(false);
  });
});

describe('occursOn — repetición semanal', () => {
  const e = entry({ recurrenceFreq: 'weekly' }); // ancla: lunes 2026-01-05

  it('matchea el mismo día de la semana, una semana después', () => {
    expect(occursOn(e, new Date('2026-01-12T21:00:00.000Z'))).toBe(true);
  });

  it('no matchea un día distinto de esa misma semana', () => {
    expect(occursOn(e, new Date('2026-01-13T21:00:00.000Z'))).toBe(false);
  });
});

describe('occursOn — repetición mensual', () => {
  const e = entry({ recurrenceFreq: 'monthly' }); // ancla: 5 de enero

  it('matchea el mismo día del mes, el mes siguiente', () => {
    expect(occursOn(e, new Date('2026-02-05T21:00:00.000Z'))).toBe(true);
  });

  it('matchea varios meses después', () => {
    expect(occursOn(e, new Date('2026-11-05T21:00:00.000Z'))).toBe(true);
  });

  it('no matchea un día distinto del mes', () => {
    expect(occursOn(e, new Date('2026-02-06T21:00:00.000Z'))).toBe(false);
  });
});

describe('occursOn — repetición anual', () => {
  const e = entry({ recurrenceFreq: 'yearly' }); // ancla: 5 de enero de 2026

  it('matchea la misma fecha, el año siguiente', () => {
    expect(occursOn(e, new Date('2027-01-05T21:00:00.000Z'))).toBe(true);
  });

  it('no matchea la misma fecha de un mes distinto', () => {
    expect(occursOn(e, new Date('2027-02-05T21:00:00.000Z'))).toBe(false);
  });

  it('deja de matchear después de recurrenceUntil, incluso en años previos válidos', () => {
    const withUntil = entry({ recurrenceFreq: 'yearly', recurrenceUntil: new Date('2027-06-01T00:00:00.000Z') });
    expect(occursOn(withUntil, new Date('2027-01-05T21:00:00.000Z'))).toBe(true);
    expect(occursOn(withUntil, new Date('2028-01-05T21:00:00.000Z'))).toBe(false);
  });
});
