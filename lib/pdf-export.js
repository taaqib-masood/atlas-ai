'use strict';
/**
 * T7: COMPARISON PDF EXPORT
 * Zero-dependency approach: renders an HTML page optimized for browser print-to-PDF.
 * The browser's built-in print dialog handles actual PDF generation.
 */
const { esc, SITE_NAME } = require('./html');

function pdfExportPage(ctx) {
  const ids = ctx.query.ids ? ctx.query.ids.split(',').map(Number).filter(n => n > 0) : [];
  const tools = ids.map(id => ctx.store.getToolById(id)).filter(Boolean);
  if (!tools.length) return { status: 404, html: '<h1>No tools to compare</h1><p>Add tools to the compare tray first.</p>' };

  const catAvg = {};
  const allTools = ctx.store.listTools({ limit: 9999 });
  tools.forEach(t => {
    const catTools = allTools.filter(x => x.category === t.category);
    const ratings = [];
    if (ctx.store.kind() === 'sqlite') {
      const revs = ctx.store.all('SELECT rating FROM reviews WHERE tool_id = ?', [t.id]);
      revs.forEach(r => ratings.push(r.rating));
    } else {
      (ctx.store.data.reviews || []).filter(r => r.tool_id === t.id).forEach(r => ratings.push(r.rating));
    }
    catAvg[t.category] = { tools: catTools.length, avgRating: ratings.length ? (ratings.reduce((a,b) => a + b, 0) / ratings.length).toFixed(1) : 'N/A' };
  });

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Atlas AI — Tool Comparison (PDF Export)</title>
<style>
  @page { size: A4; margin: 20mm; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .no-print { display:none !important; } }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; font-size:11pt; line-height:1.6; color:#1a1a18; max-width:100%; margin:0; padding:20px; }
  .pdf-header { border-bottom:2px solid #1a1a18; padding-bottom:12px; margin-bottom:24px; }
  .pdf-header h1 { font-size:18pt; margin:0 0 4px; }
  .pdf-header p { font-size:9pt; color:#6b6a63; margin:0; }
  .no-print { background:#f5f5f0; border:1px solid #e0e0d8; padding:12px 16px; margin-bottom:24px; border-radius:6px; font-size:9pt; color:#6b6a63; display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
  .no-print button { padding:8px 20px; background:#1a1a18; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:10pt; }
  table { width:100%; border-collapse:collapse; margin-bottom:32px; break-inside:avoid; }
  th, td { padding:8px 10px; border:1px solid #e0e0d8; text-align:left; vertical-align:top; font-size:9pt; }
  th { background:#f5f5f0; font-weight:600; white-space:nowrap; }
  td:first-child { font-weight:600; background:#fafaf8; width:120px; }
  .section-title { font-size:13pt; font-weight:700; margin:28px 0 12px; padding-bottom:6px; border-bottom:1px solid #e0e0d8; break-before:page; }
  .section-title:first-of-type { break-before:auto; }
  .footer { margin-top:40px; padding-top:12px; border-top:1px solid #e0e0d8; font-size:8pt; color:#6b6a63; text-align:center; }
  .badge-check { color:#2d7d46; }
  .badge-warn { color:#d4a72c; }
</style>
</head>
<body>
<div class="no-print">
  <span>📄 Print-ready comparison for ${tools.map(t => esc(t.name)).join(', ')}</span>
  <button onclick="window.print()">🖨 Print to PDF</button>
</div>

<div class="pdf-header">
  <h1>Atlas AI — Tool Comparison Report</h1>
  <p>Generated: ${new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })} · ${tools.length} tools compared · ${SITE_NAME}</p>
</div>

<h2 class="section-title">Overview</h2>
<table>
  <tr><th>Attribute</th>${tools.map(t => `<th>${esc(t.name)}</th>`).join('')}</tr>
  <tr><td>Category</td>${tools.map(t => `<td>${esc(t.category)}</td>`).join('')}</tr>
  <tr><td>Pricing</td>${tools.map(t => `<td>${esc(t.pricing_model || 'N/A')}</td>`).join('')}</tr>
  <tr><td>Lifecycle</td>${tools.map(t => `<td><span>${esc(t.lifecycle_status || 'N/A')}</span></td>`).join('')}</tr>
  <tr><td>Tags</td>${tools.map(t => `<td>${esc((t.tags || []).join(', ') || '—')}</td>`).join('')}</tr>
  <tr><td>Free tier</td>${tools.map(t => `<td>${esc(t.free_tier_limits || 'Not specified')}</td>`).join('')}</tr>
</table>

<h2 class="section-title">Feature Comparison</h2>
<table>
  <tr><th>Feature</th>${tools.map(t => `<th>${esc(t.name)}</th>`).join('')}</tr>
  <tr><td>Avg rating</td>${tools.map(t => `<td>${catAvg[t.category]?.avgRating || 'N/A'}</td>`).join('')}</tr>
  <tr><td>Category competitors</td>${tools.map(t => `<td>${catAvg[t.category]?.tools || 'N/A'} tools</td>`).join('')}</tr>
  <tr><td>Editorial badge</td>${tools.map(t => `<td>${t.editorial_badge ? '<span class="badge-check">'+esc(t.editorial_badge)+'</span>' : '—'}</td>`).join('')}</tr>
  <tr><td>Deal available</td>${tools.map(t => `<td>${t.has_deal ? '<span class="badge-check">Yes</span>' : '—'}</td>`).join('')}</tr>
  <tr><td>Enterprise ready</td>${tools.map(t => `<td>${t.compliance_data ? '<span class="badge-check">Yes</span>' : '—'}</td>`).join('')}</tr>
</table>

<h2 class="section-title">Descriptions</h2>
${tools.map(t => `<h3 style="font-size:11pt;margin:16px 0 4px;">${esc(t.name)}</h3><p style="margin:0 0 12px;font-size:9pt;">${esc(t.description || t.tagline || 'No description available.')}</p>`).join('')}

<h2 class="section-title">Notes</h2>
<table>
  <tr><th>Tool</th><th>Maker notes</th></tr>
  ${tools.map(t => `<tr><td>${esc(t.name)}</td><td>${esc((t.maker_notes || t.editorial_notes || 'None'))}</td></tr>`).join('')}
</table>

<div class="footer">
  <p>Generated by Atlas AI (${SITE_NAME}) · ${new Date().toISOString().slice(0, 10)} · Not for redistribution</p>
  <p>All data sourced from atlas-ai.local and public tool information. Ratings based on verified user reviews.</p>
</div>
</body>
</html>`;

  // Return as a full HTML page with unique styling for print
  return { html, headers: { 'content-type': 'text/html; charset=utf-8' } };
}

module.exports = { pdfExportPage };
