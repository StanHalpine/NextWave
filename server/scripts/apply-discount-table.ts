/**
 * Enter the approved member-discount table into THIS database, once.
 *
 *   npm run discounts:apply
 *
 * Prevent 10% · Restore 15% · Optimize 20%, on Spinal X-rays, Supplements and Special services (src/lib/discountTable.ts).
 * It uses the very operations Admin → Memberships → "Member discounts by service category" uses (same checks, same audit rows,
 * recorded as the system actor "apply-discount-table"), and only ever adds: a category that already exists is left as an administrator
 * has it. Safe to run twice. After it, change anything on the admin screen.
 *
 * A fresh database starts with NO discounts — nothing is enabled until this runs (or someone enters the table by hand) on each
 * new database: staging, production. Perks are not touched.
 */
import { runAsSystem } from '../src/lib/audit.js';
import { basePrisma } from '../src/lib/prismaBase.js';
import { staffTransaction } from '../src/lib/staffTx.js';
import { applyApprovedTable } from '../src/lib/discountTable.js';

async function main(): Promise<number> {
  const applied = await runAsSystem('apply-discount-table', () => staffTransaction((tx, rec) => applyApprovedTable(tx, rec)));
  for (const c of applied) {
    const pct = Object.entries(c.percents).map(([code, p]) => `${code[0]}${code.slice(1).toLowerCase()} ${p}%`).join(' · ');
    console.log(`${c.outcome === 'created' ? 'created' : 'kept   '}  ${c.name}${c.outcome === 'created' ? `  —  ${pct}  —  services: ${c.services.join(', ') || '(none yet)'}${c.skipped.length ? `  — NOT linked: ${c.skipped.join(', ')}` : ''}` : '  (already there; left as it is)'}`);
  }
  console.log(applied.some((c) => c.outcome === 'created') ? 'Discounts are now enabled. Perks are unchanged (off).' : 'Nothing to do: every category was already there.');
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((e) => { console.error('apply failed:', e?.code ?? e?.constructor?.name, String(e?.message ?? e).split('\n')[0]); process.exitCode = 1; }).finally(() => basePrisma.$disconnect());
