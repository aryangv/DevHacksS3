import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import ts from 'typescript';

const roots = [resolve('src'), resolve('../approvals/src')];
const failures = [];
async function check(directory, root) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await check(path, root);
    else if (entry.name.endsWith('.ts')) {
      const source = await readFile(path, 'utf8');
      const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      function visit(node) {
        const specifier =
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier;
        if (specifier && ts.isStringLiteral(specifier)) {
          const name = specifier.text;
          if (name.startsWith('.')) {
            const target = resolve(dirname(path), name);
            if (!target.startsWith(root + sep))
              failures.push(`${path}: cross-package import ${name}`);
          } else if (name.startsWith('@campus/') && name !== '@campus/contracts')
            failures.push(`${path}: implementation import ${name}`);
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
          failures.push(`${path}: dynamic import requires boundary review`);
        if (node.kind === ts.SyntaxKind.AnyKeyword) failures.push(`${path}: explicit any`);
        ts.forEachChild(node, visit);
      }
      visit(ast);
      if (/\bconsole\s*\./.test(source)) failures.push(`${path}: direct logging bypasses AuditLog`);
    }
  }
}
for (const root of roots) await check(root, root);
if (failures.length) {
  process.stderr.write(failures.join('\n') + '\n');
  process.exitCode = 1;
} else
  process.stdout.write('P4 source import boundaries, explicit-any and logging checks passed.\n');
