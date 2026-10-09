/**
 * Prints fresh values for the secrets this app needs. Run it, paste the output
 * into server/.env (local) or the host's environment settings (deployed).
 * Never commit the output.
 */
import { randomBytes } from 'node:crypto';

console.log(`MFA_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
