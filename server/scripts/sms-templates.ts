/**
 * Rewrites docs/SMS_TEMPLATES.md from src/integrations/templates.ts — the copy to hand to the
 * A2P campaign form. Run after changing any wording:   npm run sms:templates
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderTemplatesDoc } from '../src/integrations/templateDoc.js';

const target = path.resolve(process.cwd(), '..', 'docs', 'SMS_TEMPLATES.md');
writeFileSync(target, renderTemplatesDoc());
process.stdout.write(`wrote ${path.relative(process.cwd(), target)}\n`);
