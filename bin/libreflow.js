#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) { parsed._.push(token); continue; }
    const [rawKey, inline] = token.slice(2).split(/=(.*)/s);
    const next = inline !== undefined ? inline : (argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true);
    if (parsed[rawKey] === undefined) parsed[rawKey] = next;
    else parsed[rawKey] = Array.isArray(parsed[rawKey]) ? [...parsed[rawKey], next] : [parsed[rawKey], next];
  }
  return parsed;
}

function required(value, label) {
  if (!value || value === true) throw new Error(`${label} is required.`);
  return value;
}

function values(raw) {
  return (Array.isArray(raw) ? raw : [raw]).flatMap(value => String(value || '').split(',')).map(value => value.trim()).filter(Boolean);
}

function printHelp() {
  process.stdout.write(`LibreFlow automation CLI

Usage: libreflow <resource> <action> [options]

Authentication:
  --api-key <token>       or LIBREFLOW_API_KEY
  --base-url <url>        or LIBREFLOW_URL (default http://localhost:6767)

Commands:
  projects list
  images list --project <id>
  images upload --project <id> [--batch-name <name>] <file...>
  ingest urls --project <id> [--file urls.txt] <url...>
  jobs list [--project <id>]
  jobs get|cancel|retry <job-id>
  jobs infer --project <id> --model <id> [--selection unannotated|all] [--confidence .25]
  versions list --source-type project --source <id>
  versions create --source-type project --source <id> [--name <name>]
  webhooks list
  webhooks create --url <url> --events job.completed,annotation.saved [--project <id>]
  webhooks delete <webhook-id>
  webhooks deliveries
  webhooks retry-delivery <delivery-id>

Examples:
  libreflow projects list
  libreflow images upload --project abc board-001.jpg board-002.png
  libreflow jobs infer --project abc --model model-1 --selection unannotated
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [resource, action, id, ...rest] = args._;
  if (!resource || ['help', '-h'].includes(resource) || args.help) { printHelp(); return; }

  const baseUrl = String(args['base-url'] || process.env.LIBREFLOW_URL || 'http://localhost:6767').replace(/\/$/, '');
  const apiKey = required(args['api-key'] || process.env.LIBREFLOW_API_KEY, 'API key (--api-key or LIBREFLOW_API_KEY)');

  async function request(apiPath, options = {}) {
    const response = await fetch(`${baseUrl}${apiPath}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(options.json === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.headers || {}),
      },
      body: options.json === undefined ? options.body : JSON.stringify(options.json),
      signal: AbortSignal.timeout(Number(args.timeout) || 180_000),
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    if (!response.ok) throw new Error(typeof data === 'object' ? (data.error || data.message || JSON.stringify(data)) : `${response.status}: ${data}`);
    return data;
  }

  let output;
  if (resource === 'projects' && action === 'list') {
    output = await request('/api/automation/projects');
  } else if (resource === 'images' && action === 'list') {
    output = await request(`/api/automation/images?projectId=${encodeURIComponent(required(args.project, '--project'))}`);
  } else if (resource === 'images' && action === 'upload') {
    const files = [id, ...rest].filter(Boolean).map(filename => path.resolve(filename));
    if (!files.length) throw new Error('Provide at least one image file.');
    const projectId = required(args.project, '--project');
    const uploaded = { images: [], errors: [], batchId: null };
    for (let offset = 0; offset < files.length; offset += 25) {
      const form = new FormData();
      form.append('projectId', projectId);
      if (uploaded.batchId) form.append('batchId', uploaded.batchId);
      else if (args['batch-name']) form.append('batchName', args['batch-name']);
      for (const filename of files.slice(offset, offset + 25)) {
        if (!fs.statSync(filename).isFile()) throw new Error(`Not a file: ${filename}`);
        form.append('images', new Blob([fs.readFileSync(filename)]), path.basename(filename));
      }
      const chunk = await request('/api/automation/images/upload', { method: 'POST', body: form });
      uploaded.batchId = chunk.batchId;
      uploaded.images.push(...(chunk.images || []));
      uploaded.errors.push(...(chunk.errors || []));
    }
    output = uploaded;
  } else if (resource === 'ingest' && action === 'urls') {
    let urls = [id, ...rest].filter(Boolean);
    if (args.file) urls.push(...fs.readFileSync(path.resolve(args.file), 'utf8').split(/\r?\n/));
    urls = urls.map(url => url.trim()).filter(Boolean);
    output = await request('/api/automation/ingest/urls', { method: 'POST', json: { projectId: required(args.project, '--project'), batchName: args['batch-name'], urls } });
  } else if (resource === 'jobs' && action === 'list') {
    const query = args.project ? `?projectId=${encodeURIComponent(args.project)}` : '';
    output = await request(`/api/automation/jobs${query}`);
  } else if (resource === 'jobs' && action === 'get') {
    output = await request(`/api/automation/jobs/${encodeURIComponent(required(id, 'job id'))}`);
  } else if (resource === 'jobs' && ['cancel', 'retry'].includes(action)) {
    output = await request(`/api/automation/jobs/${encodeURIComponent(required(id, 'job id'))}/${action}`, { method: 'POST', json: {} });
  } else if (resource === 'jobs' && action === 'infer') {
    output = await request('/api/automation/jobs/inference', { method: 'POST', json: {
      projectId: required(args.project, '--project'),
      modelId: required(args.model, '--model'),
      selection: args.selection || 'unannotated',
      confThreshold: Number(args.confidence || 0.25),
      imageIds: values(args['image-ids']),
      replaceExisting: Boolean(args.replace),
      name: args.name,
    } });
  } else if (resource === 'versions' && ['list', 'create'].includes(action)) {
    const sourceType = args['source-type'] || 'project';
    const sourceId = required(args.source || args.project, '--source (or --project)');
    const endpoint = `/api/dataset-lifecycle/${encodeURIComponent(sourceType)}/${encodeURIComponent(sourceId)}/versions`;
    output = await request(endpoint, action === 'create' ? { method: 'POST', json: { name: args.name, description: args.description, split: args.split } } : {});
  } else if (resource === 'webhooks' && action === 'list') {
    output = await request('/api/automation/webhooks');
  } else if (resource === 'webhooks' && action === 'create') {
    output = await request('/api/automation/webhooks', { method: 'POST', json: { name: args.name, projectId: args.project || null, url: required(args.url, '--url'), events: values(required(args.events, '--events')) } });
  } else if (resource === 'webhooks' && action === 'delete') {
    output = await request(`/api/automation/webhooks/${encodeURIComponent(required(id, 'webhook id'))}`, { method: 'DELETE' });
  } else if (resource === 'webhooks' && action === 'deliveries') {
    output = await request('/api/automation/webhook-deliveries');
  } else if (resource === 'webhooks' && action === 'retry-delivery') {
    output = await request(`/api/automation/webhook-deliveries/${encodeURIComponent(required(id, 'delivery id'))}/retry`, { method: 'POST', json: {} });
  } else {
    throw new Error(`Unknown command: ${[resource, action].filter(Boolean).join(' ')}. Run "libreflow help".`);
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`LibreFlow CLI: ${error.message}\n`);
  process.exitCode = 1;
});
