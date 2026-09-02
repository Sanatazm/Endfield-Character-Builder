const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exitCode = 1;
}

function warn(message) {
  console.warn(`WARN: ${message}`);
}

function assertUnique(items, field, label, allowedDuplicates = new Set()) {
  const seen = new Map();
  for (const item of items) {
    const value = item[field];
    if (!value) {
      fail(`${label} has empty ${field}: ${JSON.stringify(item)}`);
      continue;
    }
    if (seen.has(value)) {
      const key = `${label}.${field}.${value}`;
      if (allowedDuplicates.has(key)) warn(`${label} duplicate ${field}: ${value}`);
      else fail(`${label} duplicate ${field}: ${value}`);
    }
    seen.set(value, item);
  }
}

function assertGearImages(gears) {
  for (const gear of gears) {
    const file = path.join(root, 'img-gear', `${gear.name}.png`);
    if (!fs.existsSync(file)) {
      fail(`gear image missing: img-gear/${gear.name}.png`);
    }
  }
}

function assertWeaponImages(weapons) {
  for (const weapon of weapons) {
    const mapped = {
      'J.E.T.': 'JET',
      '作品·蚀迹': '作品：蚀迹',
      '作品·众生': '作品：众生',
      'O.B.J重荷': 'O.B.J.重荷',
    }[weapon.name] || weapon.name;
    const file = path.join(root, 'imag-weapon', `${mapped}.png`);
    if (!fs.existsSync(file)) {
      fail(`weapon image may be missing: imag-weapon/${mapped}.png`);
    }
  }
}

function main() {
  const setEffects = readJson('set-effects.json');
  const characters = readJson('characters.json');
  const weapons = readJson('weapons.json');
  const gears = readJson('gears.json');

  assertUnique(characters, 'id', 'characters');
  assertUnique(weapons, 'id', 'weapons');
  assertUnique(gears, 'id', 'gears');

  const validGearParts = new Set(['护甲', '护手', '配件']);
  for (const gear of gears) {
    if (!validGearParts.has(gear.part)) fail(`invalid gear part for ${gear.id}: ${gear.part}`);
    if (!Object.prototype.hasOwnProperty.call(setEffects, gear.set)) {
      fail(`gear set has no effect entry: ${gear.id} ${gear.name} -> ${gear.set}`);
    }
    if (!Array.isArray(gear.stats) || gear.stats.length === 0) {
      fail(`gear has no stats: ${gear.id} ${gear.name}`);
    }
  }

  assertGearImages(gears);
  assertWeaponImages(weapons);

  if (!process.exitCode) {
    console.log(`OK: ${characters.length} characters, ${weapons.length} weapons, ${gears.length} gears, ${Object.keys(setEffects).length} set effects`);
  }
}

main();
