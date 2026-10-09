// Fails if anything under src/ writes to the console other than the logger.
//
// The logger (src/lib/logger.ts) is the only code allowed to touch console.*,
// because it is the only code that sanitises errors before writing them. A stray
// console.error('x', err) is exactly how a Prisma error carrying a patient's
// name and phone number ends up in a log file.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SINK = path.join('src', 'lib', 'logger.ts');
const offenders = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.ts') && p !== SINK) {
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (/\bconsole\.(log|info|warn|error|debug|trace)\b/.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
          offenders.push(`${p}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }
}
walk('src');

if (offenders.length) {
  console.error('console.* is only allowed in src/lib/logger.ts. Use logger.info/warn/error:\n');
  console.error(offenders.join('\n'));
  process.exit(1);
}
console.log('lint:logs ok — no console.* outside the logger');
