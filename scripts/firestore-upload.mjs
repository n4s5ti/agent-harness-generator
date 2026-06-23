#!/usr/bin/env node
// Push a benchmark-run record to Firestore (native mode, default DB) via the REST API.
// Auth: a Bearer access token (gcloud auth print-access-token, or SA token). No SDK dependency.
// Usage: node firestore-upload.mjs <collection> <record.json>   [--project P]
//   or:  echo '<json>' | node firestore-upload.mjs <collection>
// Security: relies on IAM (the caller's token must have roles/datastore.user). Firestore native
// mode denies all client access by default; only IAM-authorized server identities can write.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const PROJECT = flag('--project', 'cognitum-20260110');
const positional = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
const COLLECTION = positional[0] || 'darwin_runs';
const recPath = positional[1];
const raw = recPath ? readFileSync(recPath, 'utf8') : readFileSync(0, 'utf8');
const rec = JSON.parse(raw);

const token = (process.env.FIRESTORE_TOKEN || execSync('gcloud auth print-access-token', { encoding: 'utf8' })).trim();

// JS value → Firestore typed value
function tv(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(tv) } };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tv(x)])) } };
  return { stringValue: String(v) };
}
const fields = Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, tv(v)]));

const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${COLLECTION}`;
const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ fields }),
});
const body = await res.json();
if (!res.ok) { console.error('Firestore write FAILED', res.status, JSON.stringify(body)); process.exit(1); }
console.log('✓ wrote', body.name?.split('/').pop(), 'to', COLLECTION);
