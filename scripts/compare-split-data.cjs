const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function extractGameDatabase(html) {
  function findMatchingBrace(source, openIndex) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;
    for (let i = openIndex; i < source.length; i += 1) {
      const ch = source[i];
      const next = source[i + 1];
      if (inLineComment) {
        if (ch === '\n') inLineComment = false;
        continue;
      }
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          i += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '/' && next === '/') {
        inLineComment = true;
        i += 1;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    throw new Error('Cannot find matching brace');
  }

  const declIndex = html.indexOf('const gameDatabase');
  const equalsIndex = html.indexOf('=', declIndex);
  const openIndex = html.indexOf('{', equalsIndex);
  const closeIndex = findMatchingBrace(html, openIndex);
  return vm.runInNewContext(`(${html.slice(openIndex, closeIndex + 1)})`, {});
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, 'data', file), 'utf8'));
}

const originalHtml = childProcess.execFileSync('git', ['show', 'HEAD:index.html'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});
const original = extractGameDatabase(originalHtml);
const split = {
  setEffects: readJson('set-effects.json'),
  characters: readJson('characters.json'),
  weapons: readJson('weapons.json'),
  gears: readJson('gears.json'),
};

const originalText = JSON.stringify(original);
const splitText = JSON.stringify(split);
if (originalText !== splitText) {
  console.error('ERROR: split data does not match original gameDatabase');
  process.exit(1);
}

console.log(`OK: split data matches original (${split.characters.length} characters, ${split.weapons.length} weapons, ${split.gears.length} gears)`);
