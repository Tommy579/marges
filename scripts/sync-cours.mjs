import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const COURS_SOURCE = process.env.COURS_DIR || '/home/tom/Documents/Cours';
const COURS_TARGET = path.resolve('public/cours-files');

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;

  for (const item of fs.readdirSync(src)) {
    if (item.startsWith('.')) continue;
    const s = path.join(src, item);
    const d = path.join(dest, item);
    const stat = fs.statSync(s);

    if (stat.isDirectory()) {
      count += copyRecursive(s, d);
    } else {
      let shouldCopy = true;
      if (fs.existsSync(d)) {
        const destStat = fs.statSync(d);
        if (destStat.mtimeMs >= stat.mtimeMs && destStat.size === stat.size) {
          shouldCopy = false;
        }
      }
      if (shouldCopy) {
        fs.copyFileSync(s, d);
        count++;
      }
    }
  }
  return count;
}

console.log(`📡 Synchronisation des cours depuis : ${COURS_SOURCE}`);
const copied = copyRecursive(COURS_SOURCE, COURS_TARGET);
console.log(`✓ Synchronisation terminée (${copied} fichier(s) mis à jour).`);

if (process.argv.includes('--commit')) {
  try {
    const status = execSync('git status --porcelain public/cours-files', { encoding: 'utf-8' }).trim();
    if (status) {
      console.log('📦 Fichiers modifiés détectés, création du commit...');
      execSync('git add public/cours-files');
      execSync('git commit -m "chore(cours): mise à jour automatique des supports de cours"');
      if (process.argv.includes('--push')) {
        console.log('🚀 Push vers origin main...');
        execSync('git push origin main');
      }
    } else {
      console.log('✨ Aucun nouveau fichier de cours à committer.');
    }
  } catch (err) {
    console.error('Erreur git:', err.message);
  }
}
