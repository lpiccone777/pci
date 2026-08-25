'use client';

import { useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { apiFetch } from '@/lib/api';
import {
  ModalShell,
  fetchRolesForTenant,
  fetchAreasForTenant,
  type RoleOption,
  type AreaOption,
  type Feedback,
} from './page';

/* ------------------------------------------------------------------ */
/* Campos de persona que se pueden mapear a una columna del Excel      */
/* ------------------------------------------------------------------ */

type FieldKey = 'firstName' | 'lastName' | 'email' | 'phone' | 'internalPhone' | 'invgateUserId';

interface FieldMeta {
  key: FieldKey;
  label: string;
  required: boolean;
}

const ALL_FIELDS: FieldMeta[] = [
  { key: 'firstName', label: 'Nombre', required: true },
  { key: 'lastName', label: 'Apellido', required: true },
  { key: 'email', label: 'Email', required: true },
  { key: 'phone', label: 'Teléfono', required: false },
  { key: 'internalPhone', label: 'Interno', required: false },
  { key: 'invgateUserId', label: 'ID de Invgate', required: false },
];
const REQUIRED_FIELDS = ALL_FIELDS.filter((f) => f.required);

interface BulkImportResultRow {
  email: string;
  firstName: string;
  lastName: string;
  tempPassword: string;
}
interface BulkImportFailedRow {
  row: number;
  email: string | null;
  reason: string;
}
interface BulkImportResult {
  summary: { total: number; created: number; failed: number };
  created: BulkImportResultRow[];
  failed: BulkImportFailedRow[];
}

/** Mismo tope que `BulkImportUsersDto.rows` en el backend — se valida acá para avisar antes
 *  de armar el mapeo, en vez de dejar que el POST vuelva con un 400 genérico. */
const MAX_ROWS = 10000;

function isSupportedFile(file: File) {
  return /\.(xlsx|xls|csv)$/i.test(file.name);
}

/** Primera hoja del archivo: primera fila = headers, el resto = datos (filas vacías afuera). */
async function parseSpreadsheet(file: File): Promise<{ headers: string[]; rows: string[][] }> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('El archivo no tiene hojas.');
  const sheet = workbook.Sheets[sheetName];
  const raw: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  if (raw.length === 0) throw new Error('El archivo está vacío.');

  const [headerRow, ...dataRows] = raw;
  const headers = headerRow.map((h, i) =>
    h === null || h === undefined || String(h).trim() === ''
      ? `Columna ${i + 1}`
      : String(h).trim(),
  );
  const rows = dataRows
    .filter((r) => r.some((cell) => String(cell ?? '').trim() !== ''))
    .map((r) => headers.map((_, i) => String(r[i] ?? '').trim()));

  if (rows.length === 0) throw new Error('El archivo no tiene filas de datos.');
  return { headers, rows };
}

export function ImportUsersModal({
  tenantId,
  onClose,
  onImported,
}: {
  /** Empresa donde se crean los usuarios importados (la empresa activa). */
  tenantId: string;
  onClose: () => void;
  /** Igual que en UserModal/UserEditModal: dispara el mensaje y recarga el listado. */
  onImported: (message: Feedback) => void;
}) {
  const [step, setStep] = useState<'upload' | 'map' | 'result'>('upload');
  const [error, setError] = useState('');
  const [dragOverZone, setDragOverZone] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Partial<Record<FieldKey, number>>>({});
  const [selectedField, setSelectedField] = useState<FieldKey | null>(null);

  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [areas, setAreas] = useState<AreaOption[]>([]);
  const [defaultRoleId, setDefaultRoleId] = useState('');
  const [defaultAreaId, setDefaultAreaId] = useState('');

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BulkImportResult | null>(null);

  useEffect(() => {
    fetchRolesForTenant(tenantId).then(setRoles);
    fetchAreasForTenant(tenantId).then(setAreas);
  }, [tenantId]);

  async function handleFile(file: File) {
    setError('');
    if (!isSupportedFile(file)) {
      setError('El archivo tiene que ser .xlsx, .xls o .csv.');
      return;
    }
    try {
      const { headers: h, rows: r } = await parseSpreadsheet(file);
      if (r.length > MAX_ROWS) {
        setError(
          `El archivo tiene ${r.length} filas y el máximo por importación es ${MAX_ROWS}. Dividilo en partes más chicas.`,
        );
        return;
      }
      setFileName(file.name);
      setHeaders(h);
      setRows(r);
      setMapping({});
      setSelectedField(null);
      setStep('map');
    } catch (err: any) {
      setError(err.message || 'No se pudo leer el archivo.');
    }
  }

  function assignField(key: FieldKey, colIndex: number) {
    setMapping((prev) => {
      const next: Partial<Record<FieldKey, number>> = {};
      for (const [k, v] of Object.entries(prev) as [FieldKey, number][]) {
        // Una columna, un campo: si otro campo ya apuntaba a esta columna, se libera.
        if (v !== colIndex) next[k] = v;
      }
      next[key] = colIndex;
      return next;
    });
    setSelectedField(null);
  }

  function unassignField(key: FieldKey) {
    setMapping((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function columnField(colIndex: number): FieldMeta | null {
    const key = (Object.keys(mapping) as FieldKey[]).find((k) => mapping[k] === colIndex);
    return key ? ALL_FIELDS.find((f) => f.key === key)! : null;
  }

  const missingRequired = REQUIRED_FIELDS.filter((f) => mapping[f.key] === undefined);
  const canImport = missingRequired.length === 0 && !!defaultRoleId && rows.length > 0 && !busy;

  async function doImport() {
    setBusy(true);
    setError('');
    try {
      const payloadRows = rows.map((r) => {
        const get = (key: FieldKey) => (mapping[key] !== undefined ? r[mapping[key]!] : '');
        const row: Record<string, string> = {
          email: get('email'),
          firstName: get('firstName'),
          lastName: get('lastName'),
        };
        for (const key of ['phone', 'internalPhone', 'invgateUserId'] as FieldKey[]) {
          const value = get(key);
          if (value) row[key] = value;
        }
        return row;
      });

      const res = await apiFetch('/users/bulk-import', {
        method: 'POST',
        headers: { 'X-Tenant-Id': tenantId },
        body: JSON.stringify({
          defaultRoleId,
          defaultAreaId: defaultAreaId || undefined,
          rows: payloadRows,
        }),
      });
      setResult(res);
      setStep('result');
    } catch (err: any) {
      setError(err.message || 'No se pudo importar el archivo.');
    } finally {
      setBusy(false);
    }
  }

  function downloadPasswordsCsv() {
    if (!result || result.created.length === 0) return;
    const lines = [
      'email,password',
      ...result.created.map((c) => `${c.email},${c.tempPassword}`),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'usuarios-importados.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function requestClose() {
    if (busy) return;
    if (step !== 'upload' && step !== 'result' && !confirm('¿Cerrar sin importar? Se perderá el mapeo.')) {
      return;
    }
    onClose();
  }

  function finish() {
    if (!result) return;
    onImported({
      kind: 'ok',
      text:
        `${result.summary.created} usuario${result.summary.created === 1 ? '' : 's'} importado${
          result.summary.created === 1 ? '' : 's'
        }` + (result.summary.failed > 0 ? `, ${result.summary.failed} con error.` : '.'),
    });
    onClose();
  }

  const titles: Record<typeof step, string> = {
    upload: 'Importar usuarios desde Excel',
    map: 'Importar usuarios desde Excel',
    result: 'Resultado de la importación',
  };

  return (
    <ModalShell
      title={titles[step]}
      subtitle={
        step === 'map'
          ? `${fileName} · ${rows.length} fila${rows.length === 1 ? '' : 's'} detectada${
              rows.length === 1 ? '' : 's'
            }`
          : undefined
      }
      onRequestClose={requestClose}
      error={error}
      footer={
        step === 'upload' ? (
          <button
            type="button"
            onClick={requestClose}
            className="text-gray-600 px-4 py-2 rounded hover:bg-gray-100"
          >
            Cancelar
          </button>
        ) : step === 'map' ? (
          <>
            <button
              type="button"
              onClick={() => setStep('upload')}
              disabled={busy}
              className="text-gray-600 px-4 py-2 rounded hover:bg-gray-100"
            >
              Volver
            </button>
            <button
              type="button"
              onClick={doImport}
              disabled={!canImport}
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:bg-gray-300"
            >
              {busy ? 'Importando...' : `Importar ${rows.length} usuario${rows.length === 1 ? '' : 's'}`}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={finish}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          >
            Listo
          </button>
        )
      }
    >
      {step === 'upload' && (
        <div>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverZone(true);
            }}
            onDragLeave={() => setDragOverZone(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverZone(false);
              const file = e.dataTransfer.files?.[0];
              if (file) handleFile(file);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-lg py-14 px-6 cursor-pointer text-center transition ${
              dragOverZone ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:bg-gray-50'
            }`}
          >
            <span className="text-4xl">📊</span>
            <p className="text-sm text-gray-700 font-medium">
              Arrastrá tu planilla acá, o hacé click para elegirla
            </p>
            <p className="text-xs text-gray-400">.xlsx, .xls o .csv — la primera fila debe tener los nombres de columna</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
          </div>
        </div>
      )}

      {step === 'map' && (
        <div>
          <p className="text-xs text-gray-500 mb-2">
            Arrastrá cada etiqueta sobre la columna del Excel que le corresponde (o hacé click en la
            etiqueta y después en la columna).
          </p>
          <div className="flex flex-wrap gap-2 mb-4">
            {ALL_FIELDS.map((f) => {
              const placed = mapping[f.key] !== undefined;
              return (
                <button
                  key={f.key}
                  type="button"
                  draggable={!placed}
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', f.key)}
                  onClick={() => !placed && setSelectedField(selectedField === f.key ? null : f.key)}
                  disabled={placed}
                  className={`text-xs font-medium px-3 py-1.5 rounded-full border transition ${
                    placed
                      ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-default'
                      : selectedField === f.key
                        ? 'bg-blue-600 text-white border-blue-600 cursor-grab'
                        : f.required
                          ? 'bg-orange-50 text-orange-800 border-orange-300 cursor-grab hover:bg-orange-100'
                          : 'bg-blue-50 text-blue-800 border-blue-300 cursor-grab hover:bg-blue-100'
                  }`}
                >
                  {placed ? `✓ ${f.label}` : f.required ? `${f.label} *` : f.label}
                </button>
              );
            })}
          </div>

          <div className="overflow-x-auto border border-gray-200 rounded">
            <table className="min-w-full text-sm">
              <thead>
                <tr>
                  {headers.map((h, colIndex) => {
                    const fieldMeta = columnField(colIndex);
                    return (
                      <th
                        key={colIndex}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          const key = e.dataTransfer.getData('text/plain') as FieldKey;
                          if (key) assignField(key, colIndex);
                        }}
                        onClick={() => {
                          if (selectedField) assignField(selectedField, colIndex);
                        }}
                        className={`align-top px-3 py-2 border-b border-gray-200 min-w-[160px] text-left ${
                          selectedField ? 'cursor-pointer bg-blue-50/60' : ''
                        }`}
                      >
                        <div className="flex flex-col gap-1">
                          {fieldMeta ? (
                            <span
                              className={`inline-flex items-center gap-1 self-start text-xs font-medium px-2 py-1 rounded-full ${
                                fieldMeta.required
                                  ? 'bg-orange-100 text-orange-800'
                                  : 'bg-blue-100 text-blue-800'
                              }`}
                            >
                              {fieldMeta.label}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  unassignField(fieldMeta.key);
                                }}
                                className="hover:opacity-70"
                                aria-label={`Quitar ${fieldMeta.label}`}
                              >
                                ×
                              </button>
                            </span>
                          ) : (
                            <span className="text-xs text-gray-400 border border-dashed border-gray-300 rounded-full px-2 py-1 self-start whitespace-nowrap">
                              Soltá un campo acá
                            </span>
                          )}
                          <span
                            className="text-xs font-normal text-gray-500 truncate max-w-[160px]"
                            title={h}
                          >
                            {h}
                          </span>
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 3).map((r, ri) => (
                  <tr key={ri} className={ri % 2 ? 'bg-gray-50' : ''}>
                    {r.map((cell, ci) => (
                      <td
                        key={ci}
                        className="px-3 py-1.5 text-gray-600 truncate max-w-[160px]"
                        title={cell}
                      >
                        {cell || '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
            <div>
              <label className="block text-xs text-gray-600 mb-1">
                Rol por defecto * <span className="text-gray-400">(se asigna a todos)</span>
              </label>
              <select
                value={defaultRoleId}
                onChange={(e) => setDefaultRoleId(e.target.value)}
                className="border border-gray-200 px-3 py-2 rounded w-full"
              >
                <option value="">Elegí un rol...</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Área (opcional)</label>
              <select
                value={defaultAreaId}
                onChange={(e) => setDefaultAreaId(e.target.value)}
                className="border border-gray-200 px-3 py-2 rounded w-full"
              >
                <option value="">Sin área</option>
                {areas.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {(missingRequired.length > 0 || !defaultRoleId) && (
            <p className="text-xs text-amber-700 mt-2">
              Falta{' '}
              {[...missingRequired.map((f) => f.label), !defaultRoleId ? 'Rol por defecto' : null]
                .filter(Boolean)
                .join(', ')}{' '}
              para poder importar.
            </p>
          )}

          <p className="text-xs text-gray-400 mt-3">
            La contraseña de cada usuario se genera automáticamente — se muestra al terminar la
            importación para que se la compartas.
          </p>
        </div>
      )}

      {step === 'result' && result && (
        <div>
          <p className="text-sm text-gray-700 mb-3">
            <span className="font-medium text-green-700">
              {result.summary.created} importado{result.summary.created === 1 ? '' : 's'}
            </span>
            {result.summary.failed > 0 && (
              <>
                {' '}
                ·{' '}
                <span className="font-medium text-red-600">
                  {result.summary.failed} con error
                </span>
              </>
            )}{' '}
            de {result.summary.total} fila{result.summary.total === 1 ? '' : 's'}.
          </p>

          {result.created.length > 0 && (
            <div className="mb-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-gray-600">
                  Contraseñas temporales generadas — comunicáselas a cada persona.
                </p>
                <button
                  type="button"
                  onClick={downloadPasswordsCsv}
                  className="text-xs text-blue-600 hover:underline whitespace-nowrap"
                >
                  Descargar CSV
                </button>
              </div>
              <div className="max-h-40 overflow-y-auto border border-gray-200 rounded text-xs">
                <table className="min-w-full">
                  <tbody>
                    {result.created.map((c) => (
                      <tr key={c.email} className="border-b border-gray-100 last:border-0">
                        <td className="px-2 py-1">{c.email}</td>
                        <td className="px-2 py-1 font-mono">{c.tempPassword}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {result.failed.length > 0 && (
            <div>
              <p className="text-xs text-gray-600 mb-1">Filas no importadas:</p>
              <div className="max-h-40 overflow-y-auto border border-red-200 rounded text-xs">
                <table className="min-w-full">
                  <tbody>
                    {result.failed.map((f, i) => (
                      <tr key={i} className="border-b border-red-100 last:border-0">
                        <td className="px-2 py-1 text-gray-500 whitespace-nowrap">Fila {f.row}</td>
                        <td className="px-2 py-1">{f.email || '—'}</td>
                        <td className="px-2 py-1 text-red-600">{f.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </ModalShell>
  );
}
