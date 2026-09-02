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
  if (project.id === 'builder') {
    const avatarMap = readIndexMap('CHARACTER_AVATAR_BY_ID');
    const portraitMap = readIndexMap('CHARACTER_PORTRAIT_BY_ID');
    const landscapeMap = readIndexMap('CHARACTER_LANDSCAPE_AVATAR_BY_ID');
    payload.characterAssets = Object.fromEntries(payload.characters.map(character => {
      const id = character.id;
      const portraitFromData = fileNameFromAssetRef(character.img);
      const existingAsset = (assetType, candidates) => candidates.find(file => file && fs.existsSync(path.join(project.root, project.assetDirs[assetType], file))) || '';
      return [id, {
        avatar: existingAsset('avatar', [avatarMap[id], `${id}.png`]),
        portrait: existingAsset('portrait', [portraitMap[id], portraitFromData, `${id}.png`]),
        preview: existingAsset('preview', [landscapeMap[id], portraitMap[id], `${id}.png`]),
        landscape: existingAsset('landscape', [landscapeMap[id], avatarMap[id], `${id}.png`]),
      }];
    }));
    payload.characterAssetNames = Object.fromEntries(payload.characters.map(character => [character.id, character.assetNames || {}]));
    payload.weaponAssets = Object.fromEntries(payload.weapons.map(weapon => {
      const mappedName = {
        'J.E.T.': 'JET',
        '作品·蚀迹': '作品：蚀迹',
        '作品·众生': '作品：众生',
        'O.B.J重荷': 'O.B.J.重荷',
      }[weapon.name] || weapon.name;
      const candidate = `${mappedName}.png`;
      const current = fileNameFromAssetRef(weapon.img);
      const file = current && !/^via\.placeholder\.com/i.test(weapon.img || '') && fs.existsSync(path.join(project.root, project.assetDirs.weapon, current))
        ? current
        : (fs.existsSync(path.join(project.root, project.assetDirs.weapon, candidate)) ? candidate : '');
      return [weapon.id, file];
    }));
    payload.gearAssets = Object.fromEntries(payload.gears.map(gear => {
      const candidate = `${gear.name}.png`;
      return [gear.id, fs.existsSync(path.join(project.root, project.assetDirs.gear, candidate)) ? candidate : ''];
    }));
  }
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

function rawAssetUrl(project, assetType, fileName) {
  if (project.id !== 'builder') return `Sanatazm/endfield-axis-tool/${fileName}`;
  const dirName = project.assetDirs[assetType];
  return `https://raw.githubusercontent.com/Sanatazm/Endfield-Character-Builder/main/${encodeURIComponent(dirName).replace(/%2F/g, '/')}/${encodeURIComponent(fileName)}`;
}

function makeId(prefix, items) {
  const max = items.reduce((best, item) => {
    const match = String(item.id || '').match(new RegExp(`^${prefix}_(\\d+)$`));
    return match ? Math.max(best, Number(match[1])) : best;
  }, 0);
  return `${prefix}_${max + 1 || Date.now().toString(36)}`;
}

function readIndexMap(name) {
  const html = fs.readFileSync(path.join(builderRoot, 'index.html'), 'utf8');
  const marker = `const ${name} =`;
  const start = html.indexOf(marker);
  if (start === -1) return {};
  const braceStart = html.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < html.length; index++) {
    const char = html[index];
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (depth === 0) {
      const expression = html.slice(braceStart, index + 1);
      return Function(`"use strict"; return (${expression});`)();
    }
  }
  return {};
}

function assetFileNameForCharacter(charId, assetType, originalName) {
  const ext = path.extname(originalName || '').toLowerCase() || '.png';
  const maps = {
    avatar: 'CHARACTER_AVATAR_BY_ID',
    portrait: 'CHARACTER_PORTRAIT_BY_ID',
    preview: 'CHARACTER_LANDSCAPE_AVATAR_BY_ID',
    landscape: 'CHARACTER_LANDSCAPE_AVATAR_BY_ID',
  };
  const mapName = maps[assetType];
  const mapped = mapName ? readIndexMap(mapName)[charId] : '';
  return mapped || `${charId}${ext}`;
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

function writeBase64Asset(project, assetType, fileName, base64) {
  const target = safeAssetPath(project, assetType, fileName);
  const cleanBase64 = String(base64 || '').replace(/^data:[^,]+,/, '');
  if (!cleanBase64) throw new Error('File data is required');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const backup = backupFile(project, target);
  fs.writeFileSync(target, Buffer.from(cleanBase64, 'base64'));
  return { file: path.relative(project.root, target), backup };
}

function fileNameFromAssetRef(ref) {
  if (!ref || typeof ref !== 'string') return '';
  try {
    const pathname = /^https?:\/\//i.test(ref) ? new URL(ref).pathname : ref;
    return decodeURIComponent(path.basename(pathname));
  } catch {
    return path.basename(ref);
  }
}

function axisAssetRef(fileName) {
  return `Sanatazm/endfield-axis-tool/${fileName}`;
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

function normalizeGear(input, existing = []) {
  const stats = Array.isArray(input.stats)
    ? input.stats
    : String(input.stats || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return {
    id: String(input.id || '').trim() || makeId('g', existing),
    name: String(input.name || '').trim(),
    part: String(input.part || '').trim(),
    set: String(input.set || '').trim(),
    img: String(input.img || defaultGearImage(input.part)).trim(),
    stats,
  };
}

function upsertFirst(items, next, name, prefix) {
  const index = items.findIndex(item => item.name === name);
  if (index >= 0) {
    next.id = items[index].id;
    items.splice(index, 1);
  } else if (items.some(item => item.id === next.id)) {
    next.id = makeId(prefix, items);
  }
  items.unshift(next);
  return index;
}

function normalizeWeapon(input, existing = []) {
  const stats = Array.isArray(input.stats)
    ? input.stats
    : [input.stat1, input.stat2, input.stat3].filter(Boolean).map(value => String(value).trim());
  return {
    id: String(input.id || '').trim() || makeId('w', existing),
    name: String(input.name || '').trim(),
    type: String(input.type || '').trim(),
    stars: Number(input.stars || 6),
    img: String(input.img || '').trim() || 'https://via.placeholder.com/80?text=6',
    stats,
  };
}

function normalizeCharacter(input, existing = []) {
  return {
    id: String(input.id || '').trim() || makeId('char', existing),
    name: String(input.name || '').trim(),
    stars: Number(input.stars || 6),
    attr: String(input.attr || '').trim(),
    class: String(input.class || '').trim(),
    mainPower: String(input.mainPower || '').trim(),
    subPower: String(input.subPower || '').trim(),
    weaponType: String(input.weaponType || '').trim(),
    img: String(input.img || '').trim(),
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

function normalizeSetEffect(value) {
  return String(value || '')
    .split(/\r?\n|<br\s*\/?>/i)
    .map(line => line.trim())
    .filter(Boolean)
    .join('<br>');
}

function validateWeapon(weapon) {
  if (!weapon.id) throw new Error('武器 id 必填');
  if (!weapon.name) throw new Error('武器名称必填');
  if (!weapon.type) throw new Error('武器类型必填');
  if (![4, 5, 6].includes(Number(weapon.stars))) throw new Error('武器星级必须是 4 / 5 / 6');
  if (!Array.isArray(weapon.stats) || weapon.stats.length === 0) throw new Error('至少填写一条武器词条');
}

function validateCharacter(character) {
  if (!character.id) throw new Error('角色 id 必填');
  if (!character.name) throw new Error('角色名称必填');
  if (![4, 5, 6].includes(Number(character.stars))) throw new Error('角色星级必须是 4 / 5 / 6');
  for (const key of ['attr', 'class', 'mainPower', 'subPower', 'weaponType']) {
    if (!character[key]) throw new Error(`角色 ${key} 必填`);
  }
}

function saveAxisCharacter(input) {
  const data = readJsonFile(projects.axis, 'axis');
  const name = String(input.name || '').trim();
  if (!name) throw new Error('角色名必填');
  const existing = data.charAssets[name] || { avatar: '', skills: {} };
  const images = input.images || {};
  let avatar = String(input.avatar || existing.avatar || '').trim();
  const skills = {};
  const attrs = {};

  if (images.avatar) {
    const fileName = fileNameFromAssetRef(existing.avatar) || images.avatar.fileName;
    const upload = writeBase64Asset(projects.axis, 'axisImage', fileName, images.avatar.base64);
    avatar = axisAssetRef(path.basename(upload.file));
  }

  for (const skillType of data.skillTypes || []) {
    const oldPath = existing.skills?.[skillType] || '';
    let nextPath = String((input.skills || {})[skillType] || oldPath || '').trim();
    if (images.skills?.[skillType]) {
      const fileName = fileNameFromAssetRef(oldPath) || images.skills[skillType].fileName;
      const upload = writeBase64Asset(projects.axis, 'axisImage', fileName, images.skills[skillType].base64);
      nextPath = axisAssetRef(path.basename(upload.file));
    }
    skills[skillType] = nextPath;
    attrs[skillType] = String((input.attrs || {})[skillType] || '').trim();
  }
  data.charAssets[name] = {
    avatar,
    skills,
  };
  data.skillAttrMap[name] = attrs;
  if (input.includeInOrder !== false) {
    data.orderedChars = data.orderedChars.filter(item => item !== name);
    data.orderedChars.unshift(name);
  }
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

  if (req.method === 'POST' && pathname === '/api/set-effect') {
    if (project.id !== 'builder') throw new Error('Set effect editing is only available for the character builder project.');
    const input = JSON.parse(await readBody(req));
    const name = String(input.name || '').trim();
    const effect = normalizeSetEffect(input.effect);
    if (!name) throw new Error('请输入套装名称');
    if (!effect) throw new Error('请输入套装效果');
    const setEffects = readJsonFile(project, 'setEffects');
    const existed = Object.prototype.hasOwnProperty.call(setEffects, name);
    const reordered = { [name]: effect };
    for (const [setName, setEffect] of Object.entries(setEffects)) {
      if (setName !== name) reordered[setName] = setEffect;
    }
    const backup = writeJsonFile(project, 'setEffects', reordered);
    const result = buildAndValidate(project);
    sendJson(res, result.ok ? 200 : 400, { ok: result.ok, mode: existed ? 'updated' : 'created', name, effect, backup, ...result });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/delete') {
    const input = JSON.parse(await readBody(req));
    const entity = String(input.entity || '');
    const key = String(input.key || '').trim();
    if (!key) throw new Error('缺少要删除的数据');
    let backup;
    if (entity === 'setEffects') {
      if (project.id !== 'builder') throw new Error('套装效果删除仅适用于角色配置工具');
      const setEffects = readJsonFile(project, 'setEffects');
      if (!Object.prototype.hasOwnProperty.call(setEffects, key)) throw new Error('套装效果不存在');
      delete setEffects[key];
      backup = writeJsonFile(project, 'setEffects', setEffects);
    } else if (entity === 'axisCharacter') {
      if (project.id !== 'axis') throw new Error('排轴角色删除仅适用于排轴工具');
      const data = readJsonFile(project, 'axis');
      if (!Object.prototype.hasOwnProperty.call(data.charAssets, key)) throw new Error('排轴角色不存在');
      delete data.charAssets[key];
      delete data.skillAttrMap[key];
      data.orderedChars = data.orderedChars.filter(name => name !== key);
      backup = writeJsonFile(project, 'axis', data);
    } else if (['characters', 'weapons', 'gears'].includes(entity)) {
      if (project.id !== 'builder') throw new Error('角色配置数据删除仅适用于角色配置工具');
      const items = readJsonFile(project, entity);
      const index = items.findIndex(item => item.id === key);
      if (index < 0) throw new Error('要删除的数据不存在');
      items.splice(index, 1);
      backup = writeJsonFile(project, entity, items);
    } else {
      throw new Error('不支持的删除类型');
    }
    const result = buildAndValidate(project);
    sendJson(res, result.ok ? 200 : 400, { ok: result.ok, backup, ...result });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/gear') {
    if (project.id !== 'builder') throw new Error('Gear editing is only available for the character builder project.');
    const input = JSON.parse(await readBody(req));
    if (input.image && input.name) {
      const fileName = `${String(input.name).trim()}.png`;
      const upload = writeBase64Asset(project, 'gear', fileName, input.image);
      input.img = rawAssetUrl(project, 'gear', path.basename(upload.file));
    }
    const gears = readJsonFile(project, 'gears');
    const gear = normalizeGear(input, gears);
    validateGear(gear);
    const index = upsertFirst(gears, gear, gear.name, 'g');
    const backups = { gears: writeJsonFile(project, 'gears', gears) };
    const result = buildAndValidate(project);
    sendJson(res, result.ok ? 200 : 400, { ok: result.ok, mode: index >= 0 ? 'updated' : 'created', gear, backup: backups.gears, backups, ...result });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/weapon') {
    if (project.id !== 'builder') throw new Error('Weapon editing is only available for the character builder project.');
    const input = JSON.parse(await readBody(req));
    const weapons = readJsonFile(project, 'weapons');
    if (input.image && input.name) {
      const fileName = `${String(input.name).trim()}.png`;
      const upload = writeBase64Asset(project, 'weapon', fileName, input.image);
      input.img = rawAssetUrl(project, 'weapon', path.basename(upload.file));
    }
    const weapon = normalizeWeapon(input, weapons);
    validateWeapon(weapon);
    const index = upsertFirst(weapons, weapon, weapon.name, 'w');
    const backup = writeJsonFile(project, 'weapons', weapons);
    const result = buildAndValidate(project);
    sendJson(res, result.ok ? 200 : 400, { ok: result.ok, mode: index >= 0 ? 'updated' : 'created', weapon, backup, ...result });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/character') {
    if (project.id !== 'builder') throw new Error('Character editing is only available for the character builder project.');
    const input = JSON.parse(await readBody(req));
    const characters = readJsonFile(project, 'characters');
    const character = normalizeCharacter(input, characters);
    validateCharacter(character);

    const uploads = input.images || {};
    const existing = characters.find(item => item.id === character.id) || {};
    character.assetNames = { ...(existing.assetNames || {}) };
    for (const assetType of ['avatar', 'portrait', 'preview', 'landscape']) {
      if (!uploads[assetType]) continue;
      const fileName = assetFileNameForCharacter(character.id, assetType, uploads[assetType].fileName);
      const upload = writeBase64Asset(project, assetType, fileName, uploads[assetType].base64);
      character.assetNames[assetType] = uploads[assetType].fileName || fileName;
      if (assetType === 'portrait') character.img = rawAssetUrl(project, assetType, path.basename(upload.file));
      if (!character.img && assetType === 'avatar') character.img = rawAssetUrl(project, assetType, path.basename(upload.file));
    }

    const index = upsertFirst(characters, character, character.name, 'char');
    const backup = writeJsonFile(project, 'characters', characters);
    const result = buildAndValidate(project);
    sendJson(res, result.ok ? 200 : 400, { ok: result.ok, mode: index >= 0 ? 'updated' : 'created', character, backup, ...result });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/axis/character') {
    const { backup, result } = saveAxisCharacter(JSON.parse(await readBody(req)));
    sendJson(res, result.ok ? 200 : 400, { ok: result.ok, backup, ...result });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/upload') {
    const input = JSON.parse(await readBody(req));
    const upload = writeBase64Asset(project, input.assetType, input.fileName, input.base64);
    notifyLiveReload(`${project.id}-asset-updated`);
    sendJson(res, 200, { ok: true, ...upload });
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
