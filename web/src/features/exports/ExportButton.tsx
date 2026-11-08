import { FileSpreadsheet, Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { ApiError, apiBaseUrl } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export type ExportReport =
  | 'expenses'
  | 'categories'
  | 'suppliers'
  | 'supplier-payments'
  | 'supplier-ledger'
  | 'customer-dues'
  | 'customer-advances'
  | 'customer-ledger'
  | 'transactions'
  | 'monthly';

const toQuery = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();

function fileNameFrom(disposition: string | null, fallback: string): string {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? '');
  if (star?.[1]) return decodeURIComponent(star[1]);
  const plain = /filename="([^"]+)"/i.exec(disposition ?? '');
  return plain?.[1] ?? fallback;
}

/**
 * Downloads a server-generated Excel workbook for the CURRENT filters (GET /api/v1/exports/…).
 * The workbook is built by the server from the same report functions as the screen. One request
 * at a time: the button is disabled (and re-entry guarded) until the download finishes.
 */
export function ExportButton({
  report,
  params,
  label = 'Excel',
  disabled = false,
  className,
}: {
  report: ExportReport;
  params: Record<string, string | number | undefined>;
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const toast = useToast();

  async function download() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${apiBaseUrl()}/exports/${report}?${toQuery(params)}`, {
        credentials: 'include',
        headers: { Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/json' },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        throw new ApiError(response.status, body?.error?.code ?? 'HTTP_ERROR', body?.error?.message ?? `Export failed (${response.status}).`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileNameFrom(response.headers.get('Content-Disposition'), `shop-books-${report}.xlsx`);
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast({ title: 'Excel file ready', description: a.download, tone: 'success' });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not download the file. Check your connection and try again.';
      setError(message);
      toast({ title: 'Export failed', description: message, tone: 'error' });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <span className={cn('inline-flex flex-col items-start gap-1', className)}>
      <Button variant="outline" size="sm" disabled={disabled || busy} onClick={() => void download()} aria-busy={busy}>
        {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <FileSpreadsheet aria-hidden="true" />}
        {busy ? 'Preparing…' : label}
      </Button>
      {error && (
        <span role="alert" className="max-w-64 text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
