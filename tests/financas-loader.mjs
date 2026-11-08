import { registerHooks, createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dependencies = process.env.FINANCAS_TEST_DEPENDENCIES;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('./') && context.parentURL?.includes('/src/financas/')) {
      const target = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(target))) return nextResolve(target.href, context);
    }
    return nextResolve(specifier, context);
  },
});
if (dependencies) {
  const requireDependency = createRequire(resolve(dependencies, 'package.json'));
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (error.code !== 'ERR_MODULE_NOT_FOUND' || !/^(papaparse|lucide-react|recharts|@fontsource\/dm-sans)(\/|$)/.test(specifier)) throw error;
        return nextResolve(pathToFileURL(requireDependency.resolve(specifier)).href, context);
      }
    },
  });
}