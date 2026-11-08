import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Eye, Mail, RotateCcw, Send, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, errorMessage, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Pager, ReportTabs } from '@/features/reports/ReportTabs';
import { apiRequest } from '@/lib/api-client';
import { formatDateTime, todayInKolkata } from '@/lib/dates';
import { cn } from '@/lib/utils';

interface Settings {
  enabled: boolean;
  deliveryDay: number;
  deliveryTime: string;
  includeExcel: boolean;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
  nextRunAt: string | null;
}
interface EmailInfo {
  provider: string;
  deliversForReal: boolean;
  from: string;
  schedulerEnabled: boolean;
}
interface Recipient {
  id: string;
  email: string;
  name: string | null;
  isActive: boolean;
  version: number;
}
type Status = 'pending' | 'processing' | 'sent' | 'simulated' | 'retry_scheduled' | 'failed';
interface Delivery {
  id: string;
  period: string;
  periodLabel: string;
  trigger: 'schedule' | 'manual';
  recipientEmail: string;
  scheduledFor: string;
  status: Status;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  sentAt: string | null;
  provider: string | null;
  providerMessageId: string | null;
  lastError: string | null;
}

const STATUS: Record<Status, { label: string; tone: 'neutral' | 'accent' | 'danger' | 'warning' }> = {
  pending: { label: 'Pending', tone: 'neutral' },
  processing: { label: 'Processing', tone: 'neutral' },
  sent: { label: 'Accepted by provider', tone: 'accent' },
  simulated: { label: 'Simulated (not sent)', tone: 'warning' },
  retry_scheduled: { label: 'Retry scheduled', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
};

const BASE = '/monthly-reports';

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ['monthly-reports'] });
}

function ProviderBanner({ email }: { email: EmailInfo }) {
  if (email.deliversForReal && email.schedulerEnabled) return null;
  const lines: string[] = [];
  if (email.provider === 'none') lines.push('E-mail is not configured on the server. Reports are generated but every delivery fails with "not configured" — nothing is sent.');
  if (email.provider === 'outbox') lines.push('Development outbox: e-mails are written to a folder on the server and marked "Simulated". Nothing is sent to anyone.');
  if (!email.schedulerEnabled) lines.push('The scheduler is switched off on this server (REPORT_SCHEDULER_ENABLED=false); scheduled and queued reports will not be processed.');
  return (
    <div role="status" className="flex gap-3 rounded-xl border border-warning/30 bg-warning-soft p-4 text-sm">
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
      <div className="space-y-1">
        {lines.map((l) => (
          <p key={l}>{l}</p>
        ))}
        <p className="text-xs text-muted-foreground">Sender address: {email.from}</p>
      </div>
    </div>
  );
}

function SettingsCard({ settings, email }: { settings: Settings; email: EmailInfo }) {
  const invalidate = useInvalidate();
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const save = useMutation({
    mutationFn: () =>
      apiRequest(`${BASE}/settings`, {
        method: 'PUT',
        json: { enabled: draft.enabled, deliveryDay: draft.deliveryDay, deliveryTime: draft.deliveryTime, includeExcel: draft.includeExcel, version: settings.version },
      }),
    onSettled: invalidate,
  });
  const dirty =
    draft.enabled !== settings.enabled ||
    draft.deliveryDay !== settings.deliveryDay ||
    draft.deliveryTime !== settings.deliveryTime ||
    draft.includeExcel !== settings.includeExcel;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Schedule</CardTitle>
        <p className="text-xs text-muted-foreground">The previous month's summary is e-mailed on this day and time (India Standard Time).</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <span>
            <span className="block text-sm font-medium">Send monthly reports</span>
            <span className="block text-xs text-muted-foreground">{draft.enabled ? 'On' : 'Off'}</span>
          </span>
          <input type="checkbox" className="size-5" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <Field id="delivery-day" label="Day of month">
            <Select id="delivery-day" value={draft.deliveryDay} onChange={(e) => setDraft({ ...draft, deliveryDay: Number(e.target.value) })}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="delivery-time" label="Time (IST)">
            <Input id="delivery-time" type="time" value={draft.deliveryTime} onChange={(e) => setDraft({ ...draft, deliveryTime: e.target.value })} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={draft.includeExcel} onChange={(e) => setDraft({ ...draft, includeExcel: e.target.checked })} />
          Attach the Excel workbook
        </label>
        {settings.nextRunAt && settings.enabled && <p className="text-xs text-muted-foreground">Next run: {formatDateTime(settings.nextRunAt)} IST</p>}
        {save.isError && <p role="alert" className="text-sm text-destructive">{errorMessage(save.error)}</p>}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{settings.updatedBy ? `Last changed by ${settings.updatedBy}, ${formatDateTime(settings.updatedAt)}` : 'Default settings'}</span>
          <Button size="sm" loading={save.isPending} disabled={!dirty || !/^\d{2}:\d{2}$/.test(draft.deliveryTime)} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {!email.deliversForReal && draft.enabled && <p className="text-xs text-warning">Reports will not reach anyone until a real e-mail provider is configured.</p>}
      </CardContent>
    </Card>
  );
}

function RecipientsCard({ recipients }: { recipients: Recipient[] }) {
  const invalidate = useInvalidate();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const add = useMutation({
    mutationFn: () => apiRequest(`${BASE}/recipients`, { method: 'POST', json: { email, name: name || null } }),
    onSuccess: () => {
      setEmail('');
      setName('');
    },
    onSettled: invalidate,
  });
  const toggle = useMutation({
    mutationFn: (r: Recipient) => apiRequest(`${BASE}/recipients/${r.id}`, { method: 'PATCH', json: { isActive: !r.isActive, version: r.version } }),
    onSettled: invalidate,
  });
  const active = recipients.filter((r) => r.isActive);
  const inactive = recipients.filter((r) => !r.isActive);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Recipients</CardTitle>
        <p className="text-xs text-muted-foreground">Each active address receives its own copy. Removing an address keeps its delivery history.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {active.length === 0 && <p className="text-sm text-muted-foreground">No recipients yet.</p>}
        <ul className="divide-y">
          {active.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{r.email}</span>
                {r.name && <span className="block text-xs text-muted-foreground">{r.name}</span>}
              </span>
              <Button size="icon" variant="ghost" aria-label={`Remove ${r.email}`} disabled={toggle.isPending} onClick={() => toggle.mutate(r)}>
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="grid gap-2 sm:grid-cols-[1fr_10rem_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) add.mutate();
          }}
        >
          <Input type="email" inputMode="email" aria-label="E-mail address" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input aria-label="Name (optional)" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" loading={add.isPending} disabled={!email.trim()}>
            <UserPlus aria-hidden="true" /> Add
          </Button>
        </form>
        {add.isError && <p role="alert" className="text-sm text-destructive">{errorMessage(add.error)}</p>}
        {inactive.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Removed recipients ({inactive.length})</summary>
            <ul className="mt-2 space-y-1">
              {inactive.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2">
                  <span className="truncate text-muted-foreground">{r.email}</span>
                  <Button size="sm" variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate(r)}>
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          </details>
        )}
        {toggle.isError && <p role="alert" className="text-sm text-destructive">{errorMessage(toggle.error)}</p>}
      </CardContent>
    </Card>
  );
}

function previousMonth(): string {
  const [y, m] = todayInKolkata().split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function SendNowCard() {
  const invalidate = useInvalidate();
  const [month, setMonth] = useState(previousMonth());
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const run = useMutation({
    mutationFn: () => apiRequest<{ deliveries: number }>(`${BASE}/jobs`, { method: 'POST', json: { year: y, month: m } }),
    onSettled: invalidate,
  });
  const show = useMutation({
    mutationFn: () => apiRequest<{ preview: { subject: string; html: string } }>(`${BASE}/preview?year=${y}&month=${m}`).then((r) => r.preview),
    onSuccess: setPreview,
  });
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Send a month now</CardTitle>
        <p className="text-xs text-muted-foreground">For a completed month that has not been sent yet. Each month is sent at most once per recipient.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input type="month" aria-label="Month" className="w-48" max={previousMonth()} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={show.isPending} onClick={() => show.mutate()}>
            <Eye aria-hidden="true" /> {show.isPending ? 'Preparing…' : 'Preview e-mail'}
          </Button>
          <Button size="sm" loading={run.isPending} onClick={() => run.mutate()}>
            <Send aria-hidden="true" /> {run.isPending ? 'Queuing…' : 'Send to recipients'}
          </Button>
        </div>
        {run.isSuccess && <p role="status" className="text-sm text-primary">Queued for {run.data.deliveries} recipient(s). Progress appears in the history below.</p>}
        {(run.isError || show.isError) && <p role="alert" className="text-sm text-destructive">{errorMessage(run.error ?? show.error)}</p>}
      </CardContent>
      <Dialog open={preview !== null} title={preview?.subject ?? ''} onClose={() => setPreview(null)} size="lg">
        {/* Sandboxed: the preview HTML cannot run scripts or navigate the app. */}
        {preview && <iframe title="E-mail preview" sandbox="" srcDoc={preview.html} className="h-[60dvh] w-full rounded-lg border bg-white" />}
      </Dialog>
    </Card>
  );
}

function HistoryCard() {
  const invalidate = useInvalidate();
  const [period, setPeriod] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [confirm, setConfirm] = useState<Delivery | null>(null);
  const search = new URLSearchParams(Object.entries({ period, status, page: String(page) }).filter(([, v]) => v)).toString();
  const list = useQuery({
    queryKey: ['monthly-reports', 'deliveries', search],
    queryFn: ({ signal }) => apiRequest<{ items: Delivery[]; pagination: { totalPages: number } }>(`${BASE}/deliveries?${search}`, { signal }),
    refetchInterval: (q) => (q.state.data?.items.some((d) => ['pending', 'processing', 'retry_scheduled'].includes(d.status)) ? 10_000 : false),
  });
  const retry = useMutation({
    mutationFn: (id: string) => apiRequest(`${BASE}/deliveries/${id}/retry`, { method: 'POST', json: {} }),
    onSuccess: () => setConfirm(null),
    onSettled: invalidate,
  });
  const uncertain = confirm?.lastError?.includes('may or may not have been delivered');

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Delivery history</CardTitle>
        <p className="text-xs text-muted-foreground">
          "Accepted by provider" means the e-mail service accepted the message; it does not guarantee it reached the inbox.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <Input type="month" aria-label="Report month" className="sm:w-48" value={period} onChange={(e) => (setPeriod(e.target.value), setPage(1))} />
          <Select aria-label="Status" className="sm:w-56" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
            <option value="">Any status</option>
            {(Object.keys(STATUS) as Status[]).map((s) => (
              <option key={s} value={s}>
                {STATUS[s].label}
              </option>
            ))}
          </Select>
        </div>
        {list.isPending && <LoadingState />}
        {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
        {list.data?.items.length === 0 && <p className="text-sm text-muted-foreground">No deliveries yet.</p>}
        <ul className="divide-y">
          {list.data?.items.map((d) => (
            <li key={d.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
              <div className="min-w-0 flex-1 basis-56 space-y-0.5">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <Mail className="size-4 text-muted-foreground" aria-hidden="true" />
                  {d.periodLabel}
                  <span className="truncate font-normal text-muted-foreground">→ {d.recipientEmail}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {d.trigger === 'manual' ? 'Sent manually' : `Scheduled ${formatDateTime(d.scheduledFor)}`} · {d.attemptCount} attempt(s)
                  {d.lastAttemptAt && ` · last ${formatDateTime(d.lastAttemptAt)}`}
                  {d.nextAttemptAt && d.status === 'retry_scheduled' && ` · next ${formatDateTime(d.nextAttemptAt)}`}
                  {d.providerMessageId && ` · ref ${d.providerMessageId}`}
                </p>
                {d.lastError && d.status !== 'sent' && <p className="text-xs break-words text-destructive">{d.lastError}</p>}
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge>
                {d.status === 'failed' && (
                  <Button size="sm" variant="outline" onClick={() => setConfirm(d)}>
                    <RotateCcw aria-hidden="true" /> Retry
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {list.data && <Pager page={page} totalPages={list.data.pagination.totalPages} onPage={setPage} />}
      </CardContent>
      <Dialog
        open={confirm !== null}
        title="Retry this delivery?"
        onClose={() => setConfirm(null)}
        size="sm"
        footer={
          <DialogActions>
            <Button variant="outline" onClick={() => setConfirm(null)} disabled={retry.isPending}>
              Cancel
            </Button>
            <Button loading={retry.isPending} onClick={() => confirm && retry.mutate(confirm.id)}>
              {retry.isPending ? 'Queuing…' : 'Retry'}
            </Button>
          </DialogActions>
        }
      >
        <p className={cn('text-sm', uncertain && 'text-warning')}>
          {uncertain
            ? 'The previous attempt was interrupted, so the e-mail may already have been delivered. Retry only if the recipient confirms they did not receive it.'
            : `The ${confirm?.periodLabel} report will be sent to ${confirm?.recipientEmail} again shortly.`}
        </p>
        {retry.isError && <p role="alert" className="mt-2 text-sm text-destructive">{errorMessage(retry.error)}</p>}
      </Dialog>
    </Card>
  );
}

/** Owner-only: monthly e-mail report settings, recipients, manual send and delivery history. */
export function MonthlyEmailPage() {
  const settings = useQuery({
    queryKey: ['monthly-reports', 'settings'],
    queryFn: ({ signal }) => apiRequest<{ settings: Settings; email: EmailInfo }>(`${BASE}/settings`, { signal }),
  });
  const recipients = useQuery({
    queryKey: ['monthly-reports', 'recipients'],
    queryFn: ({ signal }) => apiRequest<{ recipients: Recipient[] }>(`${BASE}/recipients`, { signal }).then((r) => r.recipients),
  });
  return (
    <Page>
      <PageHeader title="Monthly e-mail report" description="The previous month's financial summary, e-mailed automatically by the server." />
      <ReportTabs />
      {(settings.isPending || recipients.isPending) && <LoadingState />}
      {settings.isError && <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />}
      {settings.data && <ProviderBanner email={settings.data.email} />}
      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        {settings.data && <SettingsCard settings={settings.data.settings} email={settings.data.email} />}
        {recipients.data && <RecipientsCard recipients={recipients.data} />}
      </div>
      <SendNowCard />
      <HistoryCard />
    </Page>
  );
}
