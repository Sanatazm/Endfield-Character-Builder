const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');
const outDir = path.join(root, 'src', 'generated');

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
}

const gameDatabase = {
  setEffects: readJson('set-effects.json'),
  characters: readJson('characters.json'),
  weapons: readJson('weapons.json'),
  gears: readJson('gears.json'),
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'game-database.js'),
  `// Auto-generated from data/*.json. Do not edit by hand.\nwindow.gameDatabase = ${JSON.stringify(gameDatabase, null, 2)};\n`,
  'utf8',
);

console.log(`Built src/generated/game-database.js (${gameDatabase.characters.length} characters, ${gameDatabase.weapons.length} weapons, ${gameDatabase.gears.length} gears)`);
