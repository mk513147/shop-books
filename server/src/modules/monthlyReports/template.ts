import type { MonthlySummary } from '../reports/reports.service.js';

/** "1234567.5" -> "₹12,34,567.50" (Indian digit grouping; string only, no floats). */
export function formatInr(amount: string): string {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!match) return amount;
  const [, sign = '', whole = '0', fraction = ''] = match;
  const digits = whole.replace(/^0+(?=\d)/, '');
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}` : lastThree;
  return `${sign}₹${grouped}.${fraction.padEnd(2, '0')}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const MODE_LABELS: Record<string, string> = {
  cash: 'Cash',
  upi: 'UPI',
  bank_transfer: 'Bank transfer',
  card: 'Card',
  cheque: 'Cheque',
  other: 'Other',
};

interface Line {
  label: string;
  amount: string;
  note?: string;
}

/**
 * The monthly e-mail: plain, table-based HTML with inline styles (works in common mail clients)
 * plus a plain-text alternative. Period activity and current balances are labelled separately,
 * supplier payments are never added to expenses, and customer dues/advances are never netted.
 * Contains no links to private documents and no bill images.
 */
export function renderMonthlyEmail(s: MonthlySummary, shopName: string, generatedAt: string, withAttachment: boolean) {
  const subject = `${shopName}: monthly financial summary for ${s.label}`;
  const change =
    s.expenses.changePercent === null
      ? 'No comparison (no expenses in the previous month).'
      : `${s.expenses.changePercent.startsWith('-') ? `${s.expenses.changePercent.slice(1)}% lower` : `${s.expenses.changePercent}% higher`} than the previous month (${formatInr(s.expenses.previous.amount)}).`;

  const sections: { title: string; subtitle: string; lines: Line[] }[] = [
    {
      title: `Expenses in ${s.label}`,
      subtitle: 'Activity in the month (voided expenses excluded)',
      lines: [
        { label: `Total expenses (${s.expenses.count})`, amount: s.expenses.amount, note: change },
        { label: 'Paid at purchase', amount: s.expenses.paidAtPurchase },
        { label: 'Settled by later supplier payments', amount: s.expenses.settledByPayments },
        { label: 'Still payable on these expenses (now)', amount: s.expenses.outstanding },
      ],
    },
    {
      title: 'Suppliers',
      subtitle: 'Supplier payments settle expenses; they are not extra expenses',
      lines: [
        { label: `Supplier expenses in ${s.label}`, amount: s.supplierActivity.supplierExpenses },
        { label: `Supplier payments in ${s.label} (${s.supplierActivity.paymentCount})`, amount: s.supplierActivity.payments },
        { label: `Supplier payable now (${s.suppliers.suppliersWithPayable} supplier(s))`, amount: s.suppliers.totalPayable },
        { label: 'Unallocated supplier payments now', amount: s.suppliers.totalUnallocated },
      ],
    },
    {
      title: 'Customer dues',
      subtitle: 'What customers owe the shop',
      lines: [
        { label: `Dues recorded in ${s.label}`, amount: s.customerActivity.duesRecorded },
        { label: 'Payments received against dues', amount: s.customerActivity.duePaymentsReceived },
        { label: `Outstanding customer dues now (${s.customers.customersWithDue} customer(s))`, amount: s.customers.totalDue },
      ],
    },
    {
      title: 'Customer advances',
      subtitle: 'Held for customers; separate from dues and never netted',
      lines: [
        { label: `Advances received in ${s.label}`, amount: s.customerActivity.advancesReceived },
        { label: 'Refunds issued', amount: s.customerActivity.refundsIssued },
        { label: `Available customer advances now (${s.customers.customersWithAdvance} customer(s))`, amount: s.customers.totalAdvance },
      ],
    },
  ];
  const categories = s.categories.filter((c) => c.count > 0);
  const generated = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(generatedAt));

  const row = (label: string, value: string, note?: string) =>
    `<tr><td style="padding:6px 0;border-bottom:1px solid #e5e7eb;color:#374151">${esc(label)}${
      note ? `<div style="font-size:12px;color:#6b7280">${esc(note)}</div>` : ''
    }</td><td style="padding:6px 0;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;white-space:nowrap">${esc(value)}</td></tr>`;

  const html = `<!doctype html><html><body style="margin:0;background:#f6f8f7;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px">
<tr><td style="padding:20px 24px;border-bottom:3px solid #0f766e">
<div style="font-size:13px;color:#0f766e;font-weight:600">${esc(shopName)}</div>
<h1 style="margin:4px 0 0;font-size:20px">Monthly financial summary: ${esc(s.label)}</h1>
<div style="font-size:13px;color:#6b7280">${esc(s.from)} to ${esc(s.to)} · generated ${esc(generated)} IST</div>
</td></tr>
${sections
  .map(
    (sec) => `<tr><td style="padding:16px 24px 4px">
<h2 style="margin:0;font-size:16px;color:#0f766e">${esc(sec.title)}</h2>
<div style="font-size:12px;color:#6b7280;margin-bottom:6px">${esc(sec.subtitle)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">${sec.lines.map((l) => row(l.label, formatInr(l.amount), l.note)).join('')}</table>
</td></tr>`,
  )
  .join('\n')}
${
  categories.length
    ? `<tr><td style="padding:16px 24px 4px"><h2 style="margin:0 0 6px;font-size:16px;color:#0f766e">Expenses by category</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">${categories
        .map((c) => row(`${c.name} (${c.count})`, `${formatInr(c.amount)}${c.percent ? ` · ${c.percent}%` : ''}`))
        .join('')}</table></td></tr>`
    : ''
}
${
  s.paymentModes.length
    ? `<tr><td style="padding:16px 24px 4px"><h2 style="margin:0 0 6px;font-size:16px;color:#0f766e">Expenses by payment mode at purchase</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">${s.paymentModes
        .map((m) => row(`${m.paymentMode ? MODE_LABELS[m.paymentMode] : 'Not paid at purchase'} (${m.count})`, formatInr(m.amount)))
        .join('')}</table></td></tr>`
    : ''
}
${s.notes.length ? `<tr><td style="padding:12px 24px 0;font-size:13px;color:#374151"><ul style="margin:0;padding-left:18px">${s.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></td></tr>` : ''}
<tr><td style="padding:16px 24px 20px;font-size:12px;color:#6b7280">
These figures represent transactions recorded in ${esc(shopName)}. "Now" figures are balances at the time this e-mail was generated.
Customer dues and advances are not sales or income.${withAttachment ? ' The attached Excel workbook contains the details.' : ''}
</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    `${shopName}`,
    `Monthly financial summary: ${s.label} (${s.from} to ${s.to})`,
    `Generated ${generated} IST`,
    '',
    ...sections.flatMap((sec) => [
      `${sec.title.toUpperCase()} (${sec.subtitle})`,
      ...sec.lines.map((l) => `  ${l.label}: ${formatInr(l.amount)}${l.note ? ` (${l.note})` : ''}`),
      '',
    ]),
    ...(categories.length ? ['EXPENSES BY CATEGORY', ...categories.map((c) => `  ${c.name} (${c.count}): ${formatInr(c.amount)}`), ''] : []),
    ...s.notes.map((n) => `- ${n}`),
    '',
    `These figures represent recorded transactions. Customer dues and advances are not sales or income.${withAttachment ? ' Details are in the attached Excel workbook.' : ''}`,
  ].join('\n');

  return { subject, html, text };
}
