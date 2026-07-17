'use strict';
/**
 * deploy-vercel.js — deploy a built demo folder to Vercel via the REST API.
 * ============================================================================
 * Part of generator/ (Ugly-Website Rebuild — the outreach system).
 *
 * build-demo.js produces a ready-to-deploy static folder (index.html +
 * site.config.json + any copied template assets). This module ships that folder
 * to Vercel and returns the live demo URL, which the pipeline stores on
 * demos.demo_url (Convex) and later texts to the lead after opt-in.
 *
 * GRACEFUL NO-OP: if VERCEL_TOKEN is missing we DO NOT fail the build. We print a
 * clear message and return { deployed:false } so the caller keeps the static
 * folder on disk (open index.html locally, or deploy later once a token exists).
 *
 * Deploy flow (canonical two-step Vercel API):
 *   1. Upload every file:  POST /v2/files   (raw bytes, x-vercel-digest = sha1)
 *   2. Create deployment:  POST /v13/deployments  (files referenced by sha)
 *   3. Poll:               GET  /v13/deployments/{id}  until readyState=READY
 *   4. (optional) Alias:   POST /v2/deployments/{id}/aliases  → {slug}.demo.domain
 *
 * No secrets are hardcoded — token/team come from env (loaded from .env.local).
 *
 * Module:
 *   const { deployFolder } = require('./deploy-vercel');
 *   const res = await deployFolder('/path/to/build/acme-plumber-1234', {
 *     token: env.VERCEL_TOKEN, teamId: env.VERCEL_TEAM_ID,
 *     name: 'acme-plumber-1234', aliasHost: 'acme-plumber.demo.yourdomain.com',
 *   });
 *
 * CLI:
 *   node deploy-vercel.js ./build/acme-plumber-1234 --name acme-plumber-1234 --prod
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = 'https://api.vercel.com';

// Recursively collect files under a folder as { rel, abs, buf }.
function walk(dir, baseDir = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(abs, baseDir, out);
    } else if (entry.isFile()) {
      const rel = path.relative(baseDir, abs).split(path.sep).join('/');   // POSIX rel path for Vercel
      out.push({ rel, abs, buf: fs.readFileSync(abs) });
    }
  }
  return out;
}

const sha1 = buf => crypto.createHash('sha1').update(buf).digest('hex');

// Vercel project names: lowercase [a-z0-9._-], <=100 chars, no leading/trailing sep.
function sanitizeName(name) {
  let s = String(name || 'demo').toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-');
  s = s.replace(/^[-._]+|[-._]+$/g, '').slice(0, 100) || 'demo';
  return s;
}

// Append ?teamId= to a URL when a team scope is configured.
function withTeam(url, teamId) {
  if (!teamId) return url;
  return url + (url.includes('?') ? '&' : '?') + 'teamId=' + encodeURIComponent(teamId);
}

// fetch with small retry on transient network/5xx/429 (mirrors scraper retry ethos).
async function apiFetch(url, opts, tries = 3) {
  let lastErr;
  for (let a = 1; a <= tries; a++) {
    try {
      const res = await fetch(url, opts);
      if ((res.status === 429 || res.status >= 500) && a < tries) {
        await new Promise(r => setTimeout(r, 1500 * a));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (a < tries && /fetch failed|network|timeout|aborted|ECONN|ETIMEDOUT|socket|EAI_AGAIN/i.test(e.message)) {
        await new Promise(r => setTimeout(r, 1500 * a));
      } else throw e;
    }
  }
  throw lastErr;
}

// Upload one file's raw bytes; Vercel dedupes by the x-vercel-digest sha.
async function uploadFile(buf, sha, token, teamId) {
  const res = await apiFetch(withTeam(`${API}/v2/files`, teamId), {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/octet-stream',
      'x-vercel-digest': sha,
      'Content-Length': String(buf.length),
    },
    body: buf,
  });
  if (!res.ok && res.status !== 200 && res.status !== 201) {
    const t = await res.text().catch(() => '');
    throw new Error(`file upload ${res.status}: ${t.slice(0, 200)}`);
  }
}

async function poll(deploymentId, token, teamId, log, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await apiFetch(withTeam(`${API}/v13/deployments/${deploymentId}`, teamId), {
      headers: { Authorization: 'Bearer ' + token },
    });
    const j = await res.json().catch(() => ({}));
    const state = j.readyState || j.status || 'UNKNOWN';
    if (state === 'READY') return j;
    if (state === 'ERROR' || state === 'CANCELED') throw new Error('deployment ' + state + (j.errorMessage ? ': ' + j.errorMessage : ''));
    log(`   … build ${state.toLowerCase()}`);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('deployment poll timed out after ' + Math.round(timeoutMs / 1000) + 's');
}

// Best-effort: point a friendly host at the finished deployment. Requires the
// domain to already be configured in the Vercel account — failure is non-fatal.
async function setAlias(deploymentId, host, token, teamId, log) {
  try {
    const res = await apiFetch(withTeam(`${API}/v2/deployments/${deploymentId}/aliases`, teamId), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias: host }),
    });
    if (res.ok) { log(`   ✔ alias → https://${host}`); return host; }
    const t = await res.text().catch(() => '');
    log(`   ⚠ alias failed (${res.status}): ${t.slice(0, 160)} — using the *.vercel.app URL`);
  } catch (e) { log(`   ⚠ alias error: ${e.message} — using the *.vercel.app URL`); }
  return '';
}

// Make the project publicly viewable — remove Vercel Authentication (SSO) + password
// protection so a lead can open the demo link WITHOUT logging into Vercel. Demos are
// meant to be public, unlisted links; operator-authorized. Non-fatal on failure.
async function disableProtection(projectNameOrId, token, teamId, log) {
  try {
    const res = await apiFetch(withTeam(`${API}/v9/projects/${encodeURIComponent(projectNameOrId)}`, teamId), {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssoProtection: null, passwordProtection: null }),
    });
    if (res.ok) { log('   ✔ protection off — demo is publicly viewable'); return true; }
    const t = await res.text().catch(() => '');
    log(`   ⚠ could not disable protection (${res.status}): ${t.slice(0, 160)}`);
  } catch (e) { log('   ⚠ disable-protection error: ' + e.message); }
  return false;
}

/**
 * Deploy a folder. Returns a plain result object (never throws for the common
 * "no token" / API-error paths, so the caller can always keep the static folder).
 *   { deployed:false, reason, localPath }                       // no-op (no token)
 *   { deployed:true,  url, deploymentId, alias, inspectorUrl }  // success
 *   { deployed:false, error, localPath }                        // API failure
 */
async function deployFolder(folderPath, opts = {}) {
  const log = opts.log || console.log;
  const token = opts.token || process.env.VERCEL_TOKEN || '';
  const teamId = opts.teamId || process.env.VERCEL_TEAM_ID || '';
  const target = opts.target || 'production';
  const name = sanitizeName(opts.name || path.basename(folderPath));

  if (!fs.existsSync(folderPath)) return { deployed: false, error: 'folder not found: ' + folderPath, localPath: folderPath };

  // ── Graceful no-op when no token is configured ──
  if (!token) {
    log('');
    log('⚠  VERCEL_TOKEN not set — skipping deploy (no-op).');
    log('   The ready-to-deploy folder is on disk:');
    log('     ' + folderPath);
    log('   Open ' + path.join(folderPath, 'index.html') + ' in a browser to preview,');
    log('   or set VERCEL_TOKEN in .env.local and re-run to publish.');
    return { deployed: false, reason: 'no VERCEL_TOKEN', localPath: folderPath };
  }

  try {
    const files = walk(folderPath);
    if (!files.length) return { deployed: false, error: 'folder is empty: ' + folderPath, localPath: folderPath };

    log(`\n🚀 Deploying ${files.length} file(s) to Vercel as "${name}" (${target}) …`);

    // 1) upload every file (referenced by sha in the deployment body)
    const manifest = [];
    for (const f of files) {
      const sha = sha1(f.buf);
      await uploadFile(f.buf, sha, token, teamId);
      manifest.push({ file: f.rel, sha, size: f.buf.length });
    }

    // 2) create the deployment (static — no build step; framework: null)
    const body = {
      name,
      files: manifest,
      target,
      projectSettings: { framework: null },
    };
    const res = await apiFetch(withTeam(`${API}/v13/deployments`, teamId), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const created = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (created.error && created.error.message) || JSON.stringify(created).slice(0, 300);
      throw new Error(`create deployment ${res.status}: ${msg}`);
    }

    const deploymentId = created.id || created.uid;
    const inspectorUrl = created.inspectorUrl || '';
    log(`   created ${deploymentId} — waiting for READY …`);

    // make the demo publicly viewable (project now exists after first deployment)
    if (opts.public !== false) await disableProtection(name, token, teamId, log);

    // 3) poll to READY
    const done = await poll(deploymentId, token, teamId, log, opts.pollTimeoutMs || 180000);
    let url = 'https://' + (done.url || created.url);

    // 4) optional friendly alias
    let alias = '';
    if (opts.aliasHost && !/yourdomain\.com|example\.com/i.test(opts.aliasHost)) {
      alias = await setAlias(deploymentId, opts.aliasHost, token, teamId, log);
    }

    const finalUrl = alias ? 'https://' + alias : url;
    log(`✅ Deployed: ${finalUrl}`);
    return { deployed: true, url: finalUrl, vercelUrl: url, deploymentId, alias, inspectorUrl };
  } catch (e) {
    log(`❌ Vercel deploy failed: ${e.message}`);
    log('   The static folder is still on disk: ' + folderPath);
    return { deployed: false, error: e.message, localPath: folderPath };
  }
}

module.exports = { deployFolder, sanitizeName };

// ─── Standalone CLI ────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const folder = args.find(a => !a.startsWith('--'));
    if (!folder) { console.error('Usage: node deploy-vercel.js <folder> [--name x] [--prod] [--alias host]'); process.exit(1); }
    const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

    // load .env.local (no dependency)
    for (const f of [path.join(__dirname, '..', '.env.local'), path.join(__dirname, '.env.local')]) {
      try {
        for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
          const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
          if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      } catch (_) { /* optional */ }
    }

    const abs = path.isAbsolute(folder) ? folder : path.resolve(process.cwd(), folder);
    const res = await deployFolder(abs, {
      name: get('--name') || path.basename(abs),
      target: args.includes('--prod') ? 'production' : 'production',
      aliasHost: get('--alias'),
    });
    console.log(JSON.stringify(res, null, 2));
    if (res.error) process.exit(1);
  })();
}
