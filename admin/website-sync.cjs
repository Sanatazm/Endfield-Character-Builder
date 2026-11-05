const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SITE = 'https://www.akedata.wiki';
const DATA = 'https://data.akedata.wiki';
const OFFICIAL = 'https://endfield.hypergryph.com/';
const SPRITES = '/public/images/assets/beyond/dynamicassets/gameplay/ui/sprites/';
const parse = value => JSON.parse(value.replace(/("id"\s*:\s*)(-?\d{16,})(?=\s*[,}])/g, '$1"$2"'));

function download(address) {
  return new Promise((resolve, reject) => execFile('curl.exe', ['--compressed', '--fail', '--location', '--silent', '--show-error', '--connect-timeout', '10', '--max-time', '45', address],
    { encoding: 'buffer', maxBuffer: 60 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(new Error(`下载失败：${address}。请检查网络后重试。`));
      else resolve(stdout);
    }));
}

async function officialImages() {
  const html = (await download(OFFICIAL)).toString('utf8');
  const names = {};
  const images = {};
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]).filter(address => /\/\(main\)\/layout-/.test(address));
  if (!scripts.length) throw new Error('官网角色目录结构已变化，请更新采集规则');
  for (const address of scripts) {
    const source = (await download(address)).toString('utf8');
    for (const match of source.matchAll(/"operator\.content\.([\w]+)\.name":"([^"\\]+)"/g)) {
      if (/[\u4e00-\u9fff]/.test(match[2])) names[match[1]] = match[2];
    }
  }
  const styles = [...new Set([...html.matchAll(/href="([^"]+\.css)"/g)].map(match => match[1]))];
  for (const address of styles) {
    const css = (await download(address)).toString('utf8');
    for (const match of css.matchAll(/([^{}]+)\{[^{}]*background-image:url\((https:[^)]+)\)/g)) {
      const key = match[1].match(/data-key=["']?([\w]+)/)?.[1];
      if (!key || !names[key]) continue;
      const kind = /Operator_image__/.test(match[1]) ? 'avatar' : /Operator_illustration__/.test(match[1]) ? 'portrait' : '';
      if (kind) (images[names[key]] ||= {})[kind] = match[2];
    }
  }
  if (Object.values(images).filter(row => row.avatar && row.portrait).length < 20) throw new Error('官网头像与立绘识别不完整，已停止更新');
  return images;
}

async function collect(report = () => {}) {
  report('正在读取 AKEData 最新版本');
  const manifest = parse((await download(`${DATA}/manifest.json`)).toString('utf8'));
  const version = manifest.versions.find(row => row.id === manifest.latest);
  if (!version || !/^public\/[\w./-]+$/.test(version.tableCfgPath)) throw new Error('AKEData 版本目录无效');
  const tables = {};
  const required = ['I18nTextTable_CN', 'CharacterTable', 'CharGrowthTable', 'CharProfessionTable', 'WeaponBasicTable', 'ItemTable', 'EquipTable', 'EquipSuitTable', 'AttributeShowConfigTable', 'AttributeFilterTable', 'GemTable', 'GemTagKeyToWeaponTable', 'SkillPatchTable'];
  for (const name of required) {
    report(`正在下载数据表：${name}`);
    tables[name] = parse((await download(`${DATA}/${version.tableCfgPath}/${name}.json`)).toString('utf8'));
    if (!Object.keys(tables[name]).length) throw new Error(`数据表为空：${name}`);
  }
  report('正在关联官网头像和全身立绘');
  const official = await officialImages();
  report('正在检查 AKEData 图片资源目录');
  const assetIndex = parse((await download(`${DATA}/asset-sync-index.json`)).toString('utf8'));
  const indexedImages = assetIndex.datasets?.images?.files;
  if (!indexedImages) throw new Error('图片资源目录格式已变化，无法核对缺失资源');
  const text = value => typeof value === 'string' ? value : tables.I18nTextTable_CN[value?.id] || value?.text || '';
  const clean = value => String(value).replace(/<[^>]*>/g, '').replace(/\\n/g, '\n');
  const attrs = { 39:'力量', 40:'敏捷', 41:'智识', 42:'意志' };
  const weaponTypes = { 1:'单手剑', 2:'施术单元', 3:'双手剑', 5:'长柄武器', 6:'手铳' };
  const elements = { Physical:'物理', Fire:'灼热', Pulse:'电磁', Cryst:'寒冷', Natural:'自然' };
  const result = { version: version.id, characters:[], weapons:[], gears:[], setEffects:{}, axis:{}, warnings:[], assets:[] };
  const asset = (project, directory, file, address) => {
    let expected;
    if (address.startsWith(DATA + '/public/images/')) {
      expected = indexedImages[address.slice((DATA + '/public/images/').length)];
      if (!expected) { result.warnings.push(`缺少图片：${file}，本次跳过上传`); return ''; }
    }
    result.assets.push({ project, file: `${directory ? directory + '/' : ''}${file}`, address, expected });
    return `https://raw.githubusercontent.com/Sanatazm/${project === 'axis' ? 'endfield-axis-tool' : 'Endfield-Character-Builder'}/main/${directory ? directory.split('/').map(encodeURIComponent).join('/') + '/' : ''}${encodeURIComponent(file)}`;
  };
  for (const [id, char] of Object.entries(tables.CharacterTable)) {
    const grow = tables.CharGrowthTable[id];
    const name = text(char.name);
    if (!grow || !name) throw new Error(`角色数据不完整：${id}`);
    if (result.characters.some(row => row.name === name)) continue;
    const image = official[name];
    const row = { sourceId:id, name, stars:char.rarity, class:text(tables.CharProfessionTable[grow.profession]?.name), attr:elements[grow.charTypeId], mainPower:attrs[char.mainAttrType], subPower:attrs[char.subAttrType ?? grow.subAttrType], weaponType:weaponTypes[grow.weaponType] };
    if (Object.values(row).some(value => value === undefined || value === '')) throw new Error(`角色字段无法识别：${name}`);
    if (image?.avatar) row.avatarImg = asset('builder', 'img-avatar', `${id}.png`, image.avatar);
    if (image?.portrait) row.img = asset('builder', 'imag-char', `${id}.png`, image.portrait);
    for (const [kind, label] of [['avatar','正方形头像'],['portrait','全身立绘']]) {
      if (!image?.[kind]) result.warnings.push(`${name}：官网缺少${label}，本次跳过上传，已有图片保留`);
    }
    result.characters.push(row);
    const axis = { skills:{} };
    if (image?.avatar) axis.avatar = asset('axis', '', `sync_${id}_avatar.png`, image.avatar);
    for (const group of Object.values(grow.skillGroupMap || {})) {
      const label = { 0:'重击', 1:'战技', 2:'终结技', 3:'连携技' }[group.skillGroupType];
      if (label && group.icon) axis.skills[label] = asset('axis', '', `${group.icon}.png`, `${DATA}${SPRITES}skillicon/${group.icon}.png`);
    }
    result.axis[name] = axis;
  }
  const gems = Object.fromEntries(Object.values(tables.GemTable).map(row => [row.tagId, text(row.tagName).replace(/提升$/, '')]));
  for (const [id, weapon] of Object.entries(tables.WeaponBasicTable)) {
    const item = tables.ItemTable[id];
    const name = text(item?.name);
    if (!name || weapon.rarity < 4) continue;
    const key = Object.entries(tables.GemTagKeyToWeaponTable).find(([, row]) => row.list.includes(id))?.[0];
    const stats = key?.split('+').map(tag => gems[tag]);
    if (!stats || stats.some(value => !value) || !weaponTypes[weapon.weaponType]) throw new Error(`武器词条无法识别：${name}`);
    result.weapons.push({ sourceId:id, name, stars:weapon.rarity, type:weaponTypes[weapon.weaponType], stats, img:asset('builder', 'imag-weapon', `${name}.png`, `${DATA}${SPRITES}itemiconbig/${item.iconId || id}.png`) });
  }
  const suitNames = {};
  for (const [id, suit] of Object.entries(tables.EquipSuitTable)) {
    const name = text(suit.list?.[0]?.suitName);
    if (!name) throw new Error(`套装名称缺失：${id}`);
    suitNames[id] = name;
    result.setEffects[name] = suit.list.map(entry => {
      const bundles = tables.SkillPatchTable[entry.skillID]?.SkillPatchDataBundle;
      const bundle = bundles?.find(row => row.level === entry.skillLv);
      let description = text(bundle?.description);
      for (const variable of bundle?.blackboard || []) {
        description = description.replace(new RegExp(`\\{${variable.key}(:[^}]+)?\\}`, 'g'), (_, format) => format?.includes('%') ? `${Number((variable.value * 100).toFixed(2))}%` : String(variable.value));
        description = description.replace(new RegExp(`\\{1-${variable.key}(:[^}]+)?\\}`, 'g'), (_, format) => format?.includes('%') ? `${Number(((1 - variable.value) * 100).toFixed(2))}%` : String(1 - variable.value));
      }
      if (!description || /\{[^}]+\}/.test(description)) throw new Error(`套装效果未完整解析：${name}`);
      return clean(description);
    }).join('\n');
  }
  const filters = Object.values(tables.AttributeFilterTable).flatMap(row => row.list || []);
  for (const [id, equip] of Object.entries(tables.EquipTable)) {
    const item = tables.ItemTable[id];
    const name = text(item?.name);
    if (!name || !equip.suitID || !suitNames[equip.suitID] || /preset/.test(id)) continue;
    const stats = [equip.displayBaseAttrModifier, ...equip.displayAttrModifiers].map(modifier => {
      const config = tables.AttributeShowConfigTable[modifier.attrType]?.list.find(row => row.attributeModifier === modifier.modifierType);
      const filter = filters.find(row => row.attributeType === modifier.attrType && row.attributeModifier === modifier.modifierType && (row.compositeAttr || '') === (modifier.compositeAttr || ''));
      const label = ({ Main:'主能力', Sub:'副能力' })[modifier.compositeAttr] || text(filter?.name || config?.name);
      if (!label) throw new Error(`装备属性无法识别：${name}`);
      const values = modifier.enhancedAttrValues?.length ? [modifier.attrValue, ...modifier.enhancedAttrValues] : [modifier.attrValue];
      const compositePercent = modifier.compositeAttr && (!['Main','Sub'].includes(modifier.compositeAttr) || modifier.modifierType === 6);
      const percent = config?.showPercent || compositePercent;
      return `${label}：${values.map(value => {
        const displayed = modifier.compositeAttr === 'AllDamageTakenScalar' ? 1 - value : value;
        return `+${Number((displayed * (percent ? 100 : 1)).toFixed(percent ? 2 : 0))}${percent ? '%' : ''}`;
      }).join('/')}`;
    });
    const part = { 0:'护甲', 1:'护手', 2:'配件' }[equip.partType];
    if (!part) throw new Error(`装备部位无法识别：${name}`);
    result.gears.push({ sourceId:id, name, part, set:suitNames[equip.suitID], stats, img:asset('builder', 'img-gear', `${name}.png`, `${DATA}${SPRITES}itemiconbig/${item.iconId || id}.png`) });
  }
  if (result.characters.length < 20 || result.weapons.length < 40 || result.gears.length < 100) throw new Error('本次抓取数量异常，已停止更新');
  result.id = crypto.randomUUID();
  return result;
}

function mergeRows(existing, incoming, prefix) {
  const merged = existing.map(row => ({ ...row }));
  const changes = [];
  let max = Math.max(0, ...existing.map(row => Number(row.id?.match(new RegExp(`^${prefix}_(\\d+)$`))?.[1] || 0)));
  for (const row of incoming) {
    const normalized = Object.fromEntries(Object.entries(row).filter(([key, value]) => !['img','avatarImg'].includes(key) || value));
    const index = merged.findIndex(old => old.sourceId === row.sourceId || old.name === row.name);
    const old = index >= 0 ? merged[index] : null;
    const next = { ...old, ...normalized, id:old?.id || `${prefix}_${++max}` };
    if (JSON.stringify(next) === JSON.stringify(old)) continue;
    if (index >= 0) merged.splice(index, 1);
    merged.unshift(next);
    const fields = Object.keys(next).filter(key => JSON.stringify(next[key]) !== JSON.stringify(old?.[key])).map(key => ({ key, before:old?.[key] ?? '', after:next[key] }));
    changes.push({ name:row.name, mode:old ? '更新' : '新增', fields });
  }
  return { rows:merged, changes };
}

function prepare(collected, projects) {
  const baselineFile = path.join(projects.builder.root, '.backups', 'website-sync-baseline.json');
  const resourceKeys = new Map(collected.assets.map(asset => {
    const repo = asset.project === 'axis' ? 'endfield-axis-tool' : 'Endfield-Character-Builder';
    return [`https://raw.githubusercontent.com/Sanatazm/${repo}/main/${asset.file.split('/').map(encodeURIComponent).join('/')}`, asset.expected?.md5 || asset.address];
  }));
  const signature = row => {
    const value = JSON.stringify(row);
    return JSON.stringify({ row, resources:[...resourceKeys].filter(([address]) => value.includes(address)) });
  };
  const snapshot = {};
  for (const key of ['characters','weapons','gears']) snapshot[key] = Object.fromEntries(collected[key].map(row => [row.sourceId, signature(row)]));
  snapshot.setEffects = Object.fromEntries(Object.entries(collected.setEffects).map(([name, effect]) => [name, signature(effect)]));
  snapshot.axis = Object.fromEntries(Object.entries(collected.axis).map(([name, row]) => [name, signature(row)]));
  let baseline;
  if (fs.existsSync(baselineFile)) baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  else {
    // The owner confirmed all existing source content except Minghe is current.
    baseline = JSON.parse(JSON.stringify(snapshot));
    for (const row of collected.characters.filter(row => row.name === '明河')) delete baseline.characters[row.sourceId];
    delete baseline.axis['明河'];
    fs.mkdirSync(path.dirname(baselineFile), { recursive:true });
    fs.writeFileSync(baselineFile, JSON.stringify(baseline, null, 2) + '\n');
  }
  const pending = { ...collected };
  for (const key of ['characters','weapons','gears']) pending[key] = collected[key].filter(row => baseline[key]?.[row.sourceId] !== snapshot[key][row.sourceId]);
  pending.setEffects = Object.fromEntries(Object.entries(collected.setEffects).filter(([name]) => baseline.setEffects?.[name] !== snapshot.setEffects[name]));
  pending.axis = Object.fromEntries(Object.entries(collected.axis).filter(([name]) => baseline.axis?.[name] !== snapshot.axis[name]));
  const pendingNames = [...pending.characters, ...pending.weapons, ...pending.gears].map(row => row.name).concat(Object.keys(pending.axis));
  pending.warnings = collected.warnings.filter(message => pendingNames.some(name => message.includes(name)));
  const references = JSON.stringify([pending.characters, pending.weapons, pending.gears, pending.axis]);
  pending.assets = collected.assets.filter(asset => {
    const repo = asset.project === 'axis' ? 'endfield-axis-tool' : 'Endfield-Character-Builder';
    const target = `https://raw.githubusercontent.com/Sanatazm/${repo}/main/${asset.file.split('/').map(encodeURIComponent).join('/')}`;
    return references.includes(target);
  });
  collected = pending;
  const read = (project, name) => JSON.parse(fs.readFileSync(path.join(project.root, 'data', name + '.json'), 'utf8'));
  const files = [];
  const changes = {};
  const originals = {};
  for (const [key, prefix] of [['characters','char'],['weapons','w'],['gears','g']]) {
    const old = read(projects.builder, key);
    const merged = mergeRows(old, collected[key], prefix);
    const target = path.join(projects.builder.root, 'data', key + '.json');
    originals[target] = fs.readFileSync(target, 'utf8');
    files.push({ target, value:merged.rows });
    changes[key] = merged.changes;
  }
  const setTarget = path.join(projects.builder.root, 'data', 'set-effects.json');
  const sets = read(projects.builder, 'set-effects');
  originals[setTarget] = fs.readFileSync(setTarget, 'utf8');
  changes.setEffects = Object.entries(collected.setEffects).filter(([name, effect]) => sets[name] !== effect).map(([name, effect]) => ({ name, mode:sets[name] ? '更新' : '新增', fields:[{ key:'effect', before:sets[name] || '', after:effect }] }));
  files.push({ target:setTarget, value:{ ...sets, ...collected.setEffects } });
  const axis = read(projects.axis, 'axis-data');
  changes.axis = [];
  for (const [name, row] of Object.entries(collected.axis)) {
    const skills = Object.fromEntries(Object.entries(row.skills).filter(([, value]) => value));
    const next = { ...axis.charAssets[name], ...row, skills:{ ...axis.charAssets[name]?.skills, ...skills } };
    for (const type of axis.skillTypes) if (!(type in next.skills)) next.skills[type] = '';
    if (JSON.stringify(axis.charAssets[name]) === JSON.stringify(next)) continue;
    changes.axis.push({ name, mode:axis.charAssets[name] ? '更新' : '新增', fields:[{ key:'images', before:axis.charAssets[name] || '', after:next }] });
    axis.charAssets[name] = next;
    axis.orderedChars = [name, ...axis.orderedChars.filter(value => value !== name)];
  }
  const axisTarget = path.join(projects.axis.root, 'data', 'axis-data.json');
  originals[axisTarget] = fs.readFileSync(axisTarget, 'utf8');
  files.push({ target:axisTarget, value:axis });
  return { ...collected, files, changes, originals, baselineFile, snapshot };
}

async function apply(plan, projects, report, validate) {
  for (const [target, original] of Object.entries(plan.originals)) {
    if (fs.readFileSync(target, 'utf8') !== original) throw new Error('预览后本地数据已有修改，请重新检查更新');
  }
  const staged = [];
  const unique = [...new Map(plan.assets.map(row => [`${row.project}/${row.file}`, row])).values()];
  let complete = 0;
  // Download everything before modifying live data or images.
  for (let offset = 0; offset < unique.length; offset += 4) {
    const settled = await Promise.allSettled(unique.slice(offset, offset + 4).map(async row => {
      const content = await download(row.address);
      const png = content.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      if (!png) throw new Error(`图片格式异常：${row.file}`);
      if (row.expected && (content.length !== row.expected.size || crypto.createHash('md5').update(content).digest('hex') !== row.expected.md5)) throw new Error(`图片与资源目录不一致：${row.file}，请重新检查更新`);
      staged.push({ target:path.join(projects[row.project].root, row.file), content });
      report(`正在获取图片：${++complete}/${unique.length}`);
    }));
    const failed = settled.find(row => row.status === 'rejected');
    if (failed) throw failed.reason;
  }
  for (const [target, original] of Object.entries(plan.originals)) {
    if (fs.readFileSync(target, 'utf8') !== original) throw new Error('图片获取期间本地数据已有修改，请重新检查更新');
  }
  const backups = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    for (const entry of [...staged, ...plan.files.map(row => ({ target:row.target, content:Buffer.from(JSON.stringify(row.value, null, 2) + '\n') }))]) {
      const original = fs.existsSync(entry.target) ? fs.readFileSync(entry.target) : null;
      if (original?.equals(entry.content)) continue;
      const project = Object.values(projects).find(row => entry.target.startsWith(row.root + path.sep));
      const backup = path.join(project.root, '.backups', `sync-${stamp}`, path.relative(project.root, entry.target));
      if (original) { fs.mkdirSync(path.dirname(backup), { recursive:true }); fs.writeFileSync(backup, original); }
      backups.push({ target:entry.target, original });
      fs.mkdirSync(path.dirname(entry.target), { recursive:true });
      fs.writeFileSync(entry.target, entry.content);
    }
    report('正在生成并校验两个工具的数据');
    validate();
    fs.writeFileSync(plan.baselineFile, JSON.stringify(plan.snapshot, null, 2) + '\n');
  } catch (error) {
    for (const row of backups.reverse()) {
      if (row.original) fs.writeFileSync(row.target, row.original);
      else fs.unlinkSync(row.target);
    }
    throw error;
  }
}

module.exports = { collect, download, prepare, apply };
