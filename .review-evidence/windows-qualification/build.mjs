// Source bundle recipe follows scripts/daemon-load-bench.mjs; no production edits or substitutions.
import { build, version as esbuildVersion } from 'esbuild';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const [treeArg = '.', outArg = '.review-evidence/windows-qualification/out'] = process.argv.slice(2);
const tree = resolve(treeArg), out = resolve(outArg);
mkdirSync(out, {recursive: true});
const aliases = {};
for (const name of readdirSync(join(tree, 'packages'))) {
  const dir = join(tree, 'packages', name);
  try { aliases[JSON.parse(readFileSync(join(dir, 'package.json'))).name] = join(dir, 'src/index.ts'); } catch {}
}
const entry = join(out, 'entry.mjs');
const p = x => JSON.stringify(join(tree, 'packages', x));
writeFileSync(entry, [
  `export * from ${p('core/src/runtime-env.ts')};`,
  `export {runCapture,runCaptureRaw,spawnProcess} from ${p('core/src/proc.ts')};`,
  `export {detectClaudeVersion,createClaudeAdapter,probeAuthStatus,BIN} from ${p('harness-claude/src/index.ts')};`,
  `export {probeClaudeHelp} from ${p('harness-claude/src/effort-probe.ts')};`,
].join('\n'));
const outfile = join(out, 'candidate.mjs');
const built = await build({entryPoints:[entry], outfile, bundle:true, platform:'node', format:'esm',
  target:'node24', alias:aliases, metafile:true,
  nodePaths:[join(tree,'node_modules'),join(tree,'node_modules/.pnpm/node_modules')],
  banner:{js:'import {createRequire as evidenceRequire} from "node:module"; const require=evidenceRequire(import.meta.url);'},
});
const hash = f => createHash('sha256').update(readFileSync(f)).digest('hex');
const git = args => execFileSync('git', args, {cwd:tree,encoding:'utf8'}).trim();
const inputs = Object.keys(built.metafile.inputs).map(file => ({file,sha256:hash(resolve(file))}));
writeFileSync(join(out,'build-identity.json'), JSON.stringify({tree,head:git(['rev-parse','HEAD']),
  trackedDirty:git(['status','--porcelain','--untracked-files=no']),node:process.version,esbuildVersion,
  lock:hash(join(tree,'pnpm-lock.yaml')),bundle:hash(outfile),inputs,
  instrumentation:'No build substitutions. Runtime child_process boundary observer in worker.mjs.',
},null,2));
writeFileSync(join(out,'metafile.json'), JSON.stringify(built.metafile,null,2));
