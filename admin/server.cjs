const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const url = require('url');

const builderRoot = path.resolve(__dirname, '..');
const adminDir = __dirname;
const axisRoot = path.resolve(process.env.AXIS_TOOL_ROOT || path.join(builderRoot, '..', 'endfield-axis-tool'));
const liveReloadClients = new Set();

const projects = {
  builder: {
    id: 'builder',
    name: '角色配置工具',
    root: builderRoot,
    appPath: '/app/builder/',
    dataFiles: {
      characters: 'characters.json',
      weapons: 'weapons.json',
      gears: 'gears.json',
      setEffects: 'set-effects.json',
    },
    assetDirs: {
      gear: 'img-gear',
      weapon: 'imag-weapon',
      avatar: 'img-avatar',
      portrait: 'imag-char',
      preview: 'imag-preview',
      landscape: 'imag-Landscape Avatar',
    },
    buildScript: 'build-data.cjs',
    validateScript: 'validate-data.cjs',
    commitPrefix: 'Update Endfield Character Builder data',
  },
  axis: {
    id: 'axis',
    name: '排轴工具',
    root: axisRoot,
    appPath: '/app/axis/',
    dataFiles: {
      axis: 'axis-data.json',
    },
    assetDirs: {
      axisImage: '.',
    },
    buildScript: 'build-data.cjs',
    validateScript: 'validate-data.cjs',
    commitPrefix: 'Update Endfield Axis Tool data',
  },
};

function projectFromQuery(query) {
  const project = projects[query.project] || projects.builder;
  if (!fs.existsSync(project.root)) throw new Error(`Project root does not exist: ${project.root}`);
  return project;
}

function dataDir(project) {
  return path.join(project.root, 'data');
}

function backupDir(project) {
  return path.join(project.root, '.backups');
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(text);
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  }[ext] || 'application/octet-stream';
}

function injectLiveReload(html) {
  const script = `
<script>
(() => {
  if (!window.EventSource) return;
  const source = new EventSource('/api/events');
  source.addEventListener('reload', () => window.location.reload());
})();
</script>`;
  return html.includes('/api/events') ? html : html.replace('</body>', `${script}\n</body>`);
}

function notifyLiveReload(reason) {
  const payload = `event: reload\ndata: ${JSON.stringify({ reason, time: Date.now() })}\n\n`;
  for (const res of liveReloadClients) res.write(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 80 * 1024 * 1024) {
        reject(new Error('Request body is too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function readJsonFile(project, key) {
  const file = project.dataFiles[key];
  if (!file) throw new Error(`Unknown data key: ${key}`);
  return JSON.parse(fs.readFileSync(path.join(dataDir(project), file), 'utf8'));
}

function readAllData(project) {
  const payload = {};
  for (const key of Object.keys(project.dataFiles)) payload[key] = readJsonFile(project, key);
  return payload;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupFile(project, filePath) {
  if (!fs.existsSync(filePath)) return null;
  fs.mkdirSync(backupDir(project), { recursive: true });
  const relative = path.relative(project.root, filePath).replace(/[\\/]/g, '__');
  const target = path.join(backupDir(project), `${stamp()}__${relative}`);
  fs.copyFileSync(filePath, target);
  return path.relative(project.root, target);
}

function writeJsonFile(project, key, value) {
  const file = project.dataFiles[key];
  if (!file) throw new Error(`Unknown data key: ${key}`);
  const target = path.join(dataDir(project), file);
  const backup = backupFile(project, target);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return backup;
}

function safeAssetPath(project, assetType, fileName) {
  const dirName = project.assetDirs[assetType];
  if (!dirName) throw new Error(`Unknown asset type: ${assetType}`);
  const cleanName = path.basename(String(fileName || '').trim());
  if (!cleanName) throw new Error('File name is required');
  const ext = path.extname(cleanName).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    throw new Error('Only png, jpg, jpeg, and webp are allowed');
  }
  const dir = path.resolve(project.root, dirName);
  const target = path.resolve(dir, cleanName);
  if (!target.startsWith(dir)) throw new Error('Invalid file path');
  return target;
}

function runScript(project, script) {
  try {
    const output = childProcess.execFileSync(process.execPath, [path.join(project.root, 'scripts', script)], {
      cwd: project.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output: `${error.stdout || ''}${error.stderr || ''}`.trim() || error.message };
  }
}

function runGit(project, args) {
  try {
    const output = childProcess.execFileSync('git', args, {
      cwd: project.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, output: output.trim() };
  } catch (error) {
    return { ok: false, output: `${error.stdout || ''}${error.stderr || ''}`.trim() || error.message };
  }
}

function buildAndValidate(project) {
  const build = runScript(project, project.buildScript);
  if (!build.ok) return { ok: false, build, validate: null };
  const validate = runScript(project, project.validateScript);
  const result = { ok: validate.ok, build, validate };
  if (result.ok) notifyLiveReload(`${project.id}-data-updated`);
  return result;
}

function publishToGithub(project) {
  const before = runGit(project, ['status', '--porcelain']);
  if (!before.ok) return { ok: false, step: 'status', output: before.output };
  if (!before.output) return { ok: true, step: 'noop', output: 'No local changes to publish.' };

  const add = runGit(project, ['add', '-A']);
  if (!add.ok) return { ok: false, step: 'add', output: add.output };

  const staged = runGit(project, ['diff', '--cached', '--name-only']);
  if (!staged.ok) return { ok: false, step: 'diff', output: staged.output };
  if (!staged.output) return { ok: true, step: 'noop', output: 'No staged changes to publish.' };

  const message = `${project.commitPrefix} ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
  const commit = runGit(project, ['commit', '-m', message]);
  if (!commit.ok) return { ok: false, step: 'commit', output: commit.output };

  const push = runGit(project, ['push', 'origin', 'HEAD:main']);
  if (!push.ok) return { ok: false, step: 'push', output: push.output };

  return { ok: true, step: 'push', output: `${commit.output}\n${push.output}`.trim() };
}

function normalizeGear(input) {
  const stats = Array.isArray(input.stats)
    ? input.stats
    : String(input.stats || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return {
    id: String(input.id || '').trim(),
    name: String(input.name || '').trim(),
    part: String(input.part || '').trim(),
    set: String(input.set || '').trim(),
    img: String(input.img || defaultGearImage(input.part)).trim(),
    stats,
  };
}

function defaultGearImage(part) {
  if (part === '护甲') return 'https://via.placeholder.com/80?text=Armor';
  if (part === '护手') return 'https://via.placeholder.com/80?text=Gaunt';
  return 'https://via.placeholder.com/80?text=Acc';
}

function validateGear(gear) {
  if (!gear.id) throw new Error('装备 id 必填');
  if (!gear.name) throw new Error('装备名称必填');
  if (!['护甲', '护手', '配件'].includes(gear.part)) throw new Error('装备部位必须是 护甲 / 护手 / 配件');
  if (!gear.set) throw new Error('套装名称必填');
  if (!Array.isArray(gear.stats) || gear.stats.length === 0) throw new Error('至少填写一条属性');
}

function saveAxisCharacter(input) {
  const data = readJsonFile(projects.axis, 'axis');
  const name = String(input.name || '').trim();
  if (!name) throw new Error('角色名必填');
  const skills = {};
  const attrs = {};
  for (const skillType of data.skillTypes || []) {
    skills[skillType] = String((input.skills || {})[skillType] || '').trim();
    attrs[skillType] = String((input.attrs || {})[skillType] || '').trim();
  }
  data.charAssets[name] = {
    avatar: String(input.avatar || '').trim(),
    skills,
  };
  data.skillAttrMap[name] = attrs;
  if (input.includeInOrder !== false && !data.orderedChars.includes(name)) data.orderedChars.push(name);
  const backup = writeJsonFile(projects.axis, 'axis', data);
  const result = buildAndValidate(projects.axis);
  return { backup, data, result };
}

async function handleApi(req, res, pathname, query) {
  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('\n');
    liveReloadClients.add(res);
    req.on('close', () => liveReloadClients.delete(res));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/projects') {
    sendJson(res, 200, Object.fromEntries(Object.entries(projects).map(([id, project]) => [id, {
      id,
      name: project.name,
      appPath: project.appPath,
      root: project.root,
      dataKeys: Object.keys(project.dataFiles),
      assetTypes: Object.keys(project.assetDirs),
    }])));
    return;
  }

  const project = projectFromQuery(query);

  if (req.method === 'GET' && pathname === '/api/data') {
    sendJson(res, 200, readAllData(project));
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/data/')) {
    const key = pathname.split('/').pop();
    const value = JSON.parse(await readBody(req));
    const backup = writeJsonFile(project, key, value);
    const result = buildAndValidate(project);
    sendJson(res, result.ok ? 200 : 400, { ok: result.ok, backup, ...result });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/gear') {
    if (project.id !== 'builder') throw new Error('Gear editing is only available for the character builder project.');
    const input = JSON.parse(await readBody(req));
    const gear = normalizeGear(input);
    validateGear(gear);
    const gears = readJsonFile(project, 'gears');
    const index = gears.findIndex(item => item.id === gear.id);
    if (index >= 0) gears[index] = gear;
    else gears.push(gear);
    const backup = writeJsonFile(project, 'gears', gears);
    const result = buildAndValidate(project);
    sendJson(res, result.ok ? 200 : 400, { ok: result.ok, mode: index >= 0 ? 'updated' : 'created', gear, backup, ...result });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/axis/character') {
    const { backup, result } = saveAxisCharacter(JSON.parse(await readBody(req)));
    sendJson(res, result.ok ? 200 : 400, { ok: result.ok, backup, ...result });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/upload') {
    const input = JSON.parse(await readBody(req));
    const target = safeAssetPath(project, input.assetType, input.fileName);
    const base64 = String(input.base64 || '').replace(/^data:[^,]+,/, '');
    if (!base64) throw new Error('File data is required');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const backup = backupFile(project, target);
    fs.writeFileSync(target, Buffer.from(base64, 'base64'));
    notifyLiveReload(`${project.id}-asset-updated`);
    sendJson(res, 200, { ok: true, file: path.relative(project.root, target), backup });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/build') {
    const result = buildAndValidate(project);
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    const publish = publishToGithub(project);
    sendJson(res, publish.ok ? 200 : 400, { ...result, publish, ok: publish.ok });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
}

function serveApp(res, pathname) {
  const match = pathname.match(/^\/app\/([^/]+)\/?(.*)$/);
  const project = match ? projects[match[1]] : projects.builder;
  if (!project) {
    sendText(res, 404, 'Not found');
    return;
  }
  const relative = match && match[2] ? match[2] : 'index.html';
  const target = path.resolve(project.root, relative);
  if (!target.startsWith(project.root) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    sendText(res, 404, 'Not found');
    return;
  }
  let body = fs.readFileSync(target);
  if (path.basename(target).toLowerCase() === 'index.html') body = injectLiveReload(body.toString('utf8'));
  res.writeHead(200, { 'content-type': mimeType(target) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = url.parse(req.url, true);
    const pathname = decodeURIComponent(parsed.pathname);
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, parsed.query);
      return;
    }
    if (pathname === '/app' || pathname === '/app/' || pathname.startsWith('/app/')) {
      serveApp(res, pathname === '/app' ? '/app/builder/' : pathname);
      return;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed' });
      return;
    }
    const file = pathname === '/' ? 'index.html' : path.basename(pathname);
    const filePath = path.join(adminDir, file);
    if (!fs.existsSync(filePath)) {
      sendText(res, 404, 'Not found');
      return;
    }
    sendText(res, 200, fs.readFileSync(filePath, 'utf8'), mimeType(filePath));
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

const port = Number(process.env.PORT || 8787);
server.listen(port, '127.0.0.1', () => {
  console.log(`Endfield data admin: http://127.0.0.1:${port}`);
  console.log(`Character Builder preview: http://127.0.0.1:${port}/app/builder/`);
  console.log(`Axis Tool preview: http://127.0.0.1:${port}/app/axis/`);
  console.log(`Character Builder root: ${builderRoot}`);
  console.log(`Axis Tool root: ${axisRoot}`);
});
