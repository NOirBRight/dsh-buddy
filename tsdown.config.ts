import type { UserConfig } from 'tsdown'

const PACKAGE_ID = 'dsh-buddy'

const HOST_EXTERNAL = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-workspace',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/schemastery',
]

const host: UserConfig = {
  name: PACKAGE_ID,
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: HOST_EXTERNAL,
  },
}

const client: UserConfig = {
  name: `${PACKAGE_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-connection/client',
      '@deepseek-ai/dsh-client-ui-session/client',
      '@deepseek-ai/dsh-session',
    ],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default ({ env }: Pick<UserConfig, 'env'>): UserConfig[] => {
  const face = env?.DSH_BUILD_FACE
  if (face === 'host') return [host]
  if (face === 'client') return [client]
  if (face !== undefined) throw new Error(`unknown DSH build face: ${String(face)}`)
  return [host, client]
}
