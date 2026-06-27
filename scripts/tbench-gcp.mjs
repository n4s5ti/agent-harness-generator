#!/usr/bin/env node
// tbench-gcp.mjs — provision quota-aware, self-running GCP VMs that run the OFFICIAL Terminal-Bench
// harness HARDEST-FIRST with the Darwin terminal agent, score the cost-Pareto, self-report to
// Firestore darwin_tbench_runs, and autostop. The `terminal-bench` board for the Darwin fleet.
//
// Same proven self-running-VM pattern as scripts/gcp-cluster.mjs (ADR-180/181): VMs fetch the fixed
// runner (scripts/gcp-tbench-runner.sh) from `main` and run on boot. Docker-in-VM needs cores for
// the task containers, so the default machine is e2-standard-8 + 200GB pd-standard.
//
// Usage:
//   node tbench-gcp.mjs up <model> [tag] [nTasks] [band]   provision one VM (hardest nTasks; band optional)
//   node tbench-gcp.mjs matrix                              cheap-model sweep on the hardest band
//   node tbench-gcp.mjs status                              list darwin-tb-* VMs
//   node tbench-gcp.mjs down <name|all>                     delete VM(s)
//
// Env: PROJECT (cognitum-20260110), ZONE (us-central1-a), MACHINE (e2-standard-8). Key from /tmp/.orkey.
// QUOTA-RESPECTFUL: never touches non-`darwin-tb-` VMs; skips if provisioning would exceed CPU_QUOTA.
import { execFileSync as gqx } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const PROJECT = process.env.PROJECT || 'cognitum-20260110';
const ZONE = process.env.ZONE || 'us-central1-a';
const MACHINE = process.env.MACHINE || 'e2-standard-8';
const CPU_QUOTA = 32;
const PREFIX = 'darwin-tb-';
const RUNNER_URL = 'https://raw.githubusercontent.com/ruvnet/agent-harness-generator/main/scripts/gcp-tbench-runner.sh';

const gq = (args) => gqx('gcloud', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const key = () => readFileSync('/tmp/.orkey', 'utf8').trim();

const STARTUP = `#!/bin/bash
M(){ curl -sf -H 'Metadata-Flavor: Google' "http://metadata/computeMetadata/v1/instance/attributes/$1" 2>/dev/null || true; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null 2>&1; apt-get install -y git curl >/dev/null 2>&1
mkdir -p /opt
curl -fsSL ${RUNNER_URL} -o /opt/tbench-runner.sh
bash /opt/tbench-runner.sh > /var/log/darwin-tbench.log 2>&1
echo "STARTUP_DONE $(date)" >> /var/log/darwin-tbench.log
`;

function listVMs() {
  try {
    const out = gq(['compute', 'instances', 'list', `--project=${PROJECT}`, '--format=value(name,status,machineType.basename())']);
    return out.trim().split('\n').filter(Boolean).map((l) => {
      const [name, status, mtype = ''] = l.split('\t');
      const vcpu = +(mtype.match(/-(\d+)$/)?.[1]) || (/small|micro/.test(mtype) ? 2 : 8);
      return { name, status, vcpu };
    });
  } catch { return []; }
}
const usedVCPU = () => listVMs().filter((v) => v.status === 'RUNNING' || v.status === 'STAGING').reduce((s, v) => s + v.vcpu, 0);
const vmExists = (name) => listVMs().some((v) => v.name === name);

function provision({ model, tag, nTasks = 8, band = '', machine = MACHINE }) {
  const vcpu = +(machine.match(/-(\d+)$/)?.[1]) || 8;
  if (usedVCPU() + vcpu > CPU_QUOTA) { console.error(`SKIP ${tag}: would exceed CPU quota (${usedVCPU()}+${vcpu}/${CPU_QUOTA}) — quota-respectful, not provisioning`); return false; }
  const name = `${PREFIX}${tag}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 62).replace(/-+$/, '');
  if (vmExists(name)) { console.error(`SKIP: ${name} already exists`); return false; }
  const tmp = `/tmp/startup-${name}.sh`; writeFileSync(tmp, STARTUP);
  const meta = [
    `orkey=${key()}`, `model=${model}`, `ntasks=${nTasks}`,
    band ? `band=${band}` : '', `maxsteps=${process.env.MAXSTEPS || 30}`,
    `pertaskcost=${process.env.PERTASKCOST || 1.5}`, `concurrency=${process.env.CONCURRENCY || 4}`,
    `branch=${process.env.BRANCH || 'claude/darwin-mode-evolve-polyglot'}`,
  ].filter(Boolean).join(',');
  console.error(`provisioning ${name}  (${model} · hardest ${nTasks}${band ? ` · band=${band}` : ''} · Terminal-Bench Core)`);
  try {
    gq(['compute', 'instances', 'create', name, `--project=${PROJECT}`, `--zone=${ZONE}`,
      `--machine-type=${machine}`, '--image-family=ubuntu-2204-lts', '--image-project=ubuntu-os-cloud',
      '--boot-disk-size=200GB', '--boot-disk-type=pd-standard', '--no-address',
      `--metadata=${meta}`, `--metadata-from-file=startup-script=${tmp}`, '--scopes=cloud-platform']);
  } catch (e) {
    console.error(`SKIP ${tag}: create failed — ${(e.message || '').split('\n').find((l) => /ERROR|Quota|exceeded/.test(l)) || 'error'}`);
    return false;
  }
  console.log(`✓ ${name} provisioning (self-runs on boot, autostops when done)`);
  return true;
}

// cheap-model sweep on the hardest band (the crack-the-tail matrix)
const MATRIX = [
  ['deepseek/deepseek-chat', 'ds', 8, 'hard'],
  ['z-ai/glm-4.6', 'glm', 8, 'hard'],
  ['moonshotai/kimi-k2', 'kimi', 8, 'hard'],
];

const [cmd, a, b, c, d] = process.argv.slice(2);
if (cmd === 'up') provision({ model: a, tag: b || a.split('/').pop().replace(/[.:]/g, '-'), nTasks: +(c || 8), band: d || '' });
else if (cmd === 'matrix') { for (const [model, tag, n, band] of MATRIX) try { provision({ model, tag, nTasks: n, band }); } catch (e) { console.error(e.message); } }
else if (cmd === 'status') { for (const v of listVMs().filter((v) => v.name.startsWith(PREFIX))) console.log(`${v.status.padEnd(10)} ${v.name}`); }
else if (cmd === 'down') {
  const targets = a === 'all' ? listVMs().filter((v) => v.name.startsWith(PREFIX)).map((v) => v.name) : [a];
  for (const n of targets) { try { gq(['compute', 'instances', 'delete', n, `--project=${PROJECT}`, `--zone=${ZONE}`, '--quiet']); console.log(`deleted ${n}`); } catch (e) { console.error(`delete ${n} failed: ${e.message}`); } }
} else {
  console.log('usage: tbench-gcp.mjs <up model [tag] [nTasks] [band] | matrix | status | down <name|all>>');
}
