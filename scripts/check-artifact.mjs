#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, posix, resolve, sep } from 'node:path'

const newline = String.fromCharCode(10)
const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageName = 'dsh-buddy'
const packageVersion = '0.1.0'
const alpha1Version = '0.1.2-alpha.1'
const officialRepository = 'https://github.com/deepseek-ai/deepseek-harness.git'
const officialTag = 'dsh-v0.1.2-alpha.1'
const officialCommit = 'cd5ef8148158c3a752a658978873241fdf8e2bbc'

const fixtureSpecs = [
  ['@deepseek-ai/cordis', '4.0.1'],
  ['@deepseek-ai/cosmokit', '1.8.2'],
  ['@deepseek-ai/schemastery', '3.18.1'],
  ['@deepseek-ai/dsh-agent', alpha1Version],
  ['@deepseek-ai/dsh-brand', alpha1Version],
  ['@deepseek-ai/dsh-client-connection', alpha1Version],
  ['@deepseek-ai/dsh-client-modules', alpha1Version],
  ['@deepseek-ai/dsh-client-store', alpha1Version],
  ['@deepseek-ai/dsh-client-ui-session', alpha1Version],
  ['@deepseek-ai/dsh-client-ui-slots', alpha1Version],
  ['@deepseek-ai/dsh-credentials', alpha1Version],
  ['@deepseek-ai/dsh-host-webserver', alpha1Version],
  ['@deepseek-ai/dsh-llm', alpha1Version],
  ['@deepseek-ai/dsh-scope', alpha1Version],
  ['@deepseek-ai/dsh-session', alpha1Version],
  ['@deepseek-ai/dsh-session-title', alpha1Version],
  ['@deepseek-ai/dsh-storage', alpha1Version],
  ['@deepseek-ai/dsh-storage-domain', alpha1Version],
  ['@deepseek-ai/dsh-timeout', alpha1Version],
  ['@deepseek-ai/dsh-typert-protocol', alpha1Version],
  ['@deepseek-ai/dsh-user-approval', alpha1Version],
  ['@deepseek-ai/dsh-user-questions', alpha1Version],
  ['@deepseek-ai/dsh-util-crypto', alpha1Version],
  ['@deepseek-ai/dsh-workspace', alpha1Version],
  ['@standard-schema/spec', '1.1.0'],
  ['@types/prop-types', '15.7.15'],
  ['@types/react', '18.3.31'],
  ['bytes', '3.1.2'],
  ['compressible', '2.0.18'],
  ['compression', '1.8.1'],
  ['csstype', '3.2.3'],
  ['debug', '2.6.9'],
  ['immer', '10.2.0'],
  ['js-tokens', '4.0.0'],
  ['loose-envify', '1.4.0'],
  ['mime-db', '1.54.0'],
  ['ms', '2.0.0'],
  ['negotiator', '0.6.4'],
  ['negotiator', '1.0.0'],
  ['on-headers', '1.1.0'],
  ['react', '18.3.1'],
  ['safe-buffer', '5.2.1'],
  ['use-sync-external-store', '1.2.0'],
  ['vary', '1.1.2'],
  ['zod', '4.4.3'],
  ['zustand', '4.4.7'],
]
const fixtureSpecKeys = new Set(fixtureSpecs.map(([name, version]) => name + '@' + version))
const expectedFixtureRecords = new Map([
  ["bytes@3.1.2", {"size":4496,"sha256":"835e37ad5a40da45eaed6e32d99847627a15b2a4671741182521fe48dee3c581","integrity":"sha512-/Nf7TyzTx6S3yRJObOAV7956r8cr2+Oj8AC5dt8wSP3BQAoeX58NoHyCU8P8zGkNXStjTSi6fzO6F0pBdcYbEg=="}],
  ["compressible@2.0.18", {"size":3067,"sha256":"a57b9d8e8224a68045384e59753cd35e455efe037e090b6ac465d30a022059d6","integrity":"sha512-AF3r7P5dWxL8MxyITRMlORQNaOA2IkAFaTr4k7BUumjPtRpGDTZpl0Pb1XCO6JeDCBdp126Cgs9sMxqSjgYyRg=="}],
  ["compression@1.8.1", {"size":9213,"sha256":"871674d45b53482fae81687f547e4c677c5c637eaa066ec8c412178b549dd5d5","integrity":"sha512-9mAqGPHLakhCLeNyxPkK4xVo746zQ/czLH1Ky+vkitMnWfWZps8r0qXuwhwizagCRttsL4lfG4pIOvaWLpAP0w=="}],
  ["csstype@3.2.3", {"size":138324,"sha256":"f3501f8ee1c73f7568fecb22c11231162c0467e59262461da5579519307427a3","integrity":"sha512-z1HGKcYy2xA8AGQfwrn0PAy+PB7X/GSj3UVJW9qKyn43xWa+gl5nXmU4qqLMRzWVLFC8KusUX8T/0kCiOYpAIQ=="}],
  ["debug@2.6.9", {"size":16514,"sha256":"34ae48c66698f1f81e2a2e6e322f34e8a88b0986a3fa7b74bb5ea14c0edb1c98","integrity":"sha512-bC7ElrdJaJnPbAP+1EotYvqZsb3ecl5wi6Bfi6BJTUcNowp6cvspg0jXznRTKDjm/E7AdgFBVeAPVMNcKGsHMA=="}],
  ["@deepseek-ai/cordis@4.0.1", {"size":55438,"sha256":"b07c794237ef9ec3b3bf86c8bdd8de456ae5c5ed45fd495f827884bc27c3c338","integrity":null}],
  ["@deepseek-ai/cosmokit@1.8.2", {"size":13976,"sha256":"74986e0a5d2b7984607d5913974b083d30efe31ac5c25a8b1efc90b06fa4ec90","integrity":null}],
  ["@deepseek-ai/dsh-agent@0.1.2-alpha.1", {"size":43122,"sha256":"d6a34e11400e93f84b988a0d6f933169e79eb528770e3298774df936e0a03e9d","integrity":null}],
  ["@deepseek-ai/dsh-brand@0.1.2-alpha.1", {"size":6255,"sha256":"a5deb877f8689fa1ee746edc6ea40dda2a03b7d557275f56dcb9d425fabd3237","integrity":null}],
  ["@deepseek-ai/dsh-client-connection@0.1.2-alpha.1", {"size":67223,"sha256":"e021d6174ebe5bb8493234d1517d9e7d892545414e61dba8551a445dd9aa6a51","integrity":null}],
  ["@deepseek-ai/dsh-client-modules@0.1.2-alpha.1", {"size":33150,"sha256":"4a02286fcc53f4e20b105301367a4754791215a677f26fad1b5b07f7c13f047c","integrity":null}],
  ["@deepseek-ai/dsh-client-store@0.1.2-alpha.1", {"size":9059,"sha256":"4233299a3502b150251abc648f15ca9ded7b94480e3d8a1391671c504875f9b7","integrity":null}],
  ["@deepseek-ai/dsh-client-ui-session@0.1.2-alpha.1", {"size":8691,"sha256":"d85d92dd7cac460f2aa5fab0628c122aac4292d03d5c5131362f7643b3acb952","integrity":null}],
  ["@deepseek-ai/dsh-client-ui-slots@0.1.2-alpha.1", {"size":26470,"sha256":"a79d2a84690a71836984d84f133c901e538a8a27cf4609a0d70b40717f491938","integrity":null}],
  ["@deepseek-ai/dsh-credentials@0.1.2-alpha.1", {"size":20022,"sha256":"574d1fb92d650edfaa74f5e660dd72bd0870fca97ea2d2a032508e59159f30c3","integrity":null}],
  ["@deepseek-ai/dsh-host-webserver@0.1.2-alpha.1", {"size":15511,"sha256":"9b3c5dba5c47042782e7cdab7ee52b8f6dc5fb792681889e7ab162b0a3f7d2f1","integrity":null}],
  ["@deepseek-ai/dsh-llm@0.1.2-alpha.1", {"size":88662,"sha256":"6586f1549731554ee32db4472fb1cda5a043357d2383f1deef9fa484388038eb","integrity":null}],
  ["@deepseek-ai/dsh-scope@0.1.2-alpha.1", {"size":15116,"sha256":"abe87a14d9ac8840a53b30e047a335e0f9e23f385cf3f87caa482c360a6dd57a","integrity":null}],
  ["@deepseek-ai/dsh-session@0.1.2-alpha.1", {"size":85692,"sha256":"e9c8475c5cb913a9189f13aec7a7d94c2f35a34f576ab51a06e51f3300f5606f","integrity":null}],
  ["@deepseek-ai/dsh-session-title@0.1.2-alpha.1", {"size":24946,"sha256":"bac20372ba4a468ad561f8a13191614a859bd76a21e8b1b95bf1b8a2e1c108ed","integrity":null}],
  ["@deepseek-ai/dsh-storage@0.1.2-alpha.1", {"size":12949,"sha256":"34cd70fd88e91aded468d35ee297a97ce31b60f14097d621576fe6b9e3d91cfc","integrity":null}],
  ["@deepseek-ai/dsh-storage-domain@0.1.2-alpha.1", {"size":21431,"sha256":"f19db9e120422bb305d0d02a658984d39e591d067bbd92742f4edc8200f75b90","integrity":null}],
  ["@deepseek-ai/dsh-timeout@0.1.2-alpha.1", {"size":10892,"sha256":"2abed7a638df6a3650d7e46392d9d7fe731149316b4f564556f6583ed1a400a7","integrity":null}],
  ["@deepseek-ai/dsh-typert-protocol@0.1.2-alpha.1", {"size":17539,"sha256":"13b17a1105bb3112987a10d1d3a973d7142457bb9955275faeb95bfb03e36ab3","integrity":null}],
  ["@deepseek-ai/dsh-user-approval@0.1.2-alpha.1", {"size":19382,"sha256":"8c78b70bf2f645507a4733a43aa11fe4d2c7c16cf15e5116bb58e3a383e2e43d","integrity":null}],
  ["@deepseek-ai/dsh-user-questions@0.1.2-alpha.1", {"size":10348,"sha256":"c414a7936483f1865b1cb67564acd7ed915645a776f04cb4c9c11a834c06b81b","integrity":null}],
  ["@deepseek-ai/dsh-util-crypto@0.1.2-alpha.1", {"size":5274,"sha256":"97a27aaa8c4b28f64de5c939acc2742c8986fc2012a53ee10256078c8557e0ee","integrity":null}],
  ["@deepseek-ai/dsh-workspace@0.1.2-alpha.1", {"size":31328,"sha256":"426b829995deca8316477075e013e585d41e823f9706f6e24a3257a22f04b1aa","integrity":null}],
  ["@deepseek-ai/schemastery@3.18.1", {"size":25098,"sha256":"a64b5bed661f303cb27a44bc3942142da953460cca44571f89d960f35a74b682","integrity":null}],
  ["immer@10.2.0", {"size":171225,"sha256":"23e8ffb42851e74536e4cad3354f1d2183aee0d5a9f16e0d92a33e6fbcea74b2","integrity":"sha512-d/+XTN3zfODyjr89gM3mPq1WNX2B8pYsu7eORitdwyA2sBubnTl3laYlBk4sXY5FUa5qTZGBDPJICVbvqzjlbw=="}],
  ["js-tokens@4.0.0", {"size":6542,"sha256":"d884c7a2d8adb5568c1272d92b4f9c62707f4226cf9e7b22e7b957c7361e3c53","integrity":"sha512-RdJUflcE3cUzKiMqQgsCu06FPu9UdIJO0beYbPhHN4k6apgJtifcoCtT9bcxOpYBtpD2kCM6Sbzg4CausW/PKQ=="}],
  ["loose-envify@1.4.0", {"size":2842,"sha256":"1218830a93538a4f730d530138e945ea6a65b45e099ee7a9ea538a05141babdc","integrity":"sha512-lyuxPGr/Wfhrlem2CL/UcnUc1zcqKAImBDzukY7Y5F/yQiNdko6+fRLevlw1HgMySw7f611UIY408EtxRSoK3Q=="}],
  ["mime-db@1.54.0", {"size":29535,"sha256":"2b21054e65d0eabd58c5002d2713e968dd47b15700bfed4b7281a344ded1c420","integrity":"sha512-aU5EJuIN2WDemCcAp2vFBfp/m4EAhWJnUNSSw0ixs7/kXbd6Pg64EmwJkNdFhB8aWt1sH2CTXrLxo/iAGV3oPQ=="}],
  ["ms@2.0.0", {"size":2874,"sha256":"362152ab8864181fc3359a3c440eec58ce3e18f773b0dde4d88a84fe13d73ecb","integrity":"sha512-Tpp60P6IUJDTuOq/5Z8cdskzJujfwqfOTkrwIwj7IRISpnkJnT6SyJ4PCPnGMoFjC9ddhal5KVIYtAt97ix05A=="}],
  ["negotiator@0.6.4", {"size":6725,"sha256":"8fc72d4030ac7b0d4c51933a19224d72bebab8d51da196cb863f754cd772b210","integrity":"sha512-myRT3DiWPHqho5PrJaIRyaMv2kgYf0mUVgBNOYMuCH5Ki1yEiQaf/ZJuQ62nvpc44wL5WDbTX7yGJi1Neevw8w=="}],
  ["negotiator@1.0.0", {"size":6792,"sha256":"b5a2dfee1dc0ac52c623cd5c0304be5a8a41cfad40e09f1a13606972cb2dbc04","integrity":"sha512-8Ofs/AUQh8MaEcrlq5xOX0CQ9ypTF5dl78mjlMNfOK08fzpgTHQRQPBxcPlEtIw0yRpws+Zo/3r+5WRby7u3Gg=="}],
  ["on-headers@1.1.0", {"size":3607,"sha256":"2721477949965442f4229652bb79cc252fc5074458c40adfef12d933f156c224","integrity":"sha512-737ZY3yNnXy37FHkQxPzt4UZ2UWPWiCZWLvFZ4fu5cueciegX0zGPnrlY6bwRg4FdQOe9YU8MkmJwGhoMybl8A=="}],
  ["react@18.3.1", {"size":81751,"sha256":"8d9bed01a672e7eaf387942d781ad47c6a43089a30a0306060f9fd5ac7870347","integrity":"sha512-wS+hAgJShR0KhEvPJArfuPVN1+Hz1t0Y6n5jLrGQbkb4urgPE/0Rve+1kMB1v/oWgHgm4WIcV+i7F2pTVj+2iQ=="}],
  ["safe-buffer@5.2.1", {"size":9972,"sha256":"5d181804516c4a693a384272a7bd0e42d17e0d4b301ccfbe408669ccafdcb3e8","integrity":"sha512-rp3So07KcdmmKbGvgaNxQSJr7bGVSVk5S9Eq1F+ppbRo70+YeaDxkw5Dd8NPN+GD6bjnYm2VuPuCXmpuYvmCXQ=="}],
  ["@standard-schema/spec@1.1.0", {"size":4178,"sha256":"a7cb7268be280ab518d450f8c3b07c86f23417225c0ab53691ed59b3067cceaf","integrity":"sha512-l2aFy5jALhniG5HgqrD6jXLi/rUWrKvqN/qJx6yoJsgKhblVd+iqqU4RCXavm/jPityDo5TCvKMnpjKnOriy0w=="}],
  ["@types/prop-types@15.7.15", {"size":3029,"sha256":"c258ce4d6ca9dcfbefb0457da225deb680b739389e195211435edb7b3a3aec10","integrity":"sha512-F6bEyamV9jKGAFBEmlQnesRPGOQqS2+Uwi0Em15xenOxHaf2hv6L8YCVn3rPdPJOiJfPiCnLIRyvwVaqMY3MIw==","archiveIntegrity":"sha512-Wklr8gKjZtA4orRrMX2UwZZPPcm5GbOqgBXG2H71hnBmRTGp4jyERHHxzUYxrKw9TDdmDlIwrm8mpdXdmtoo8w=="}],
  ["@types/react@18.3.31", {"size":78498,"sha256":"f1d3c1d9a1dc47954eb570ff29acd658b0aebd72d3363fdb71cca61f3298337d","integrity":"sha512-vfEqpXTvwT91yhmwdfouStN2hSKwTvyRs8qpLfADyrq/kxDw0hZM7Wk9Ug1FELj8hIby+S/+kQCSRFF32nv2Qw==","archiveIntegrity":"sha512-gXe2lRfAtrcj9BJW9K0hMyQSixOYgJrWNHJ8sCSjWAMlwwNFJNGsraJ/cptXV7Ue44RXxCPK8u/53oGdeBWczQ=="}],
  ["use-sync-external-store@1.2.0", {"size":6939,"sha256":"06adb9d5da9c1c2bcef99d18f423460d17fc03906c06f2f2b1610cc35b8300e2","integrity":"sha512-eEgnFxGQ1Ife9bzYs6VLi8/4X6CObHMw9Qr9tPY43iKwsPw8xE8+EFsf/2cFZ5S3esXgpWgtSCtLNS41F+sKPA=="}],
  ["vary@1.1.2", {"size":3772,"sha256":"7378860671377a35e7a443ecfdca0745cfd066f595c90d581b827defea246e71","integrity":"sha512-BNGbWLfd0eUPabhkXUVm0j8uuvREyTh5ovRa/dyow/BqAbZJyC+5fU+IzQOzmAKzYqYRAISoRhdQr3eIZ/PXqg=="}],
  ["zod@4.4.3", {"size":759588,"sha256":"ee38f17f533fd500610685a483ae2f413c26f4eb33a51684314563c8d60f279c","integrity":"sha512-ytENFjIJFl2UwYglde2jchW2Hwm4GJFLDiSXWdTrJQBIN9Fcyp7n4DhxJEiWNAJMV1/BqWfW/kkg71UDcHJyTQ=="}],
  ["zustand@4.4.7", {"size":51707,"sha256":"c22d32f791abba72fc246ef1d3ca964d01da204bc73727318a5be61daa2ad66b","integrity":"sha512-QFJWJMdlETcI69paJwhSMJz7PPWjVP8Sjhclxmxmxv/RYI7ZOvR5BHX+ktH0we9gTWQMxcne8q1OY8xxz604gw=="}],
])


function fail(message) {
  throw new Error('[artifact-gate] ' + message)
}

function ok(message) {
  console.log('[artifact-gate] OK: ' + message)
}

const invalidRegistry = 'http://127.0.0.1:1'
const sensitiveEnvironmentName = /(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|SSH|AWS_|AZURE_|GOOGLE_|GCP_|CLOUDSDK_|DOCKER_|NPM_|PNPM_|YARN_|COREPACK_|^GIT_|KUBECONFIG|NETRC|CURL_HOME|BUNDLE_|CARGO_|BUN_|DENO_|PIP_|POETRY_|MAVEN_|GRADLE_|RUBYGEMS_|GEM_)/i
const artifactEnvironmentOverrides = new Set(['XDG_CONFIG_HOME', 'npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_registry', 'npm_config_audit', 'npm_config_fund', 'PNPM_STORE_DIR'])

function scrubSubprocessEnvironment(source = process.env) {
  const environment = {}
  for (const [name, value] of Object.entries(source)) {
    if (name === 'NODE_PATH' || name === 'NODE_OPTIONS' || name === 'XDG_CONFIG_DIRS' || name === 'XDG_DATA_DIRS' || sensitiveEnvironmentName.test(name)) continue
    environment[name] = value
  }
  return environment
}

function command(commandName, args, options = {}) {
  const requestedEnvironment = options.env
  const commandOptions = { ...options }
  delete commandOptions.env
  const environment = scrubSubprocessEnvironment(requestedEnvironment)
  if (requestedEnvironment !== undefined) {
    for (const name of artifactEnvironmentOverrides) {
      if (name in requestedEnvironment) environment[name] = requestedEnvironment[name]
    }
    if (requestedEnvironment.npm_config_registry !== invalidRegistry || requestedEnvironment.npm_config_audit !== 'false' || requestedEnvironment.npm_config_fund !== 'false') fail('artifact subprocess must use invalid registry and disabled audit/fund overrides')
  }
  try {
    return execFileSync(commandName, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...commandOptions,
      env: environment,
    })
  } catch (error) {
    const stdout = error && typeof error.stdout === 'string' ? error.stdout : ''
    const stderr = error && typeof error.stderr === 'string' ? error.stderr : String(error)
    fail(commandName + ' ' + args.join(' ') + ' failed' + newline + stdout + newline + stderr)
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch (error) {
    fail(label + ' is not valid JSON: ' + String(error))
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasTarControlEscape(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') continue
    const next = value[index + 1]
    if (next === '\\') {
      index += 1
      continue
    }
    if ('abtnvfre'.includes(next) || /[0-7]/.test(next) || (next === 'x' && /^[0-9A-Fa-f]{2}/.test(value.slice(index + 2)))) return true
  }
  return false
}

function tarEntries(tarball) {
  const seen = new Set()
  const verbose = command('tar', ['-tvzf', tarball])
    .split(newline)
    .map((line) => line.endsWith('\r') ? line.slice(0, -1) : line)
    .filter((line) => line !== '')
  for (const line of verbose) {
    if (line[0] !== '-' && line[0] !== 'd') fail('tarball contains a non-regular entry: ' + line)
  }
  const entries = command('tar', ['-tzf', tarball])
    .split(newline)
    .map((entry) => entry.endsWith('\r') ? entry.slice(0, -1) : entry)
    .filter((entry) => entry !== '')
  if (entries.length === 0) fail('tarball must contain package/ as its only archive root')
  for (const entry of entries) {
    if (entry.startsWith('-')) fail('tarball contains an option-shaped entry: ' + entry)
    if (hasTarControlEscape(entry)) fail('tarball contains a control character in an entry name: ' + entry)
    if (!entry.startsWith('package/')) fail('tarball must contain package/ as its only archive root: ' + entry)
    if (entry.startsWith('/') || entry.includes('\\') || entry.split('/').some((part) => part === '..' || part === '.')) fail('tarball contains an unsafe path: ' + entry)
    if (seen.has(entry)) fail('tarball contains duplicate entry: ' + entry)
    seen.add(entry)
  }
  return entries
}

function tarText(tarball, entry) {
  if (entry.startsWith('-')) fail('tar member name must not be an option: ' + entry)
  return command('tar', ['-xOzf', tarball, '--', entry])
}

function packageEntry(relativePath) {
  return 'package/' + relativePath
}

function requireEntry(entries, relativePath) {
  const entry = packageEntry(relativePath)
  if (!entries.includes(entry)) fail('tarball is missing ' + relativePath)
}

function collectExportTargets(value, targets, location) {
  if (typeof value === 'string') {
    if (!value.startsWith('./') || value.includes('*')) fail('exports.' + location + ' has an invalid target')
    targets.push(value.slice(2))
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectExportTargets(item, targets, location + '[' + String(index) + ']'))
    return
  }
  if (!isRecord(value)) fail('exports.' + location + ' has an invalid target')
  for (const [key, item] of Object.entries(value)) collectExportTargets(item, targets, location + '.' + key)
}

function globPattern(pattern) {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*' && pattern[index + 1] === '*' && pattern[index + 2] === '/') {
      source += '(?:.*/)?'
      index += 2
    } else if (character === '*' && pattern[index + 1] === '*') {
      source += '.*'
      index += 1
    } else if (character === '*') {
      source += '[^/]*'
    } else if (character === '?') {
      source += '[^/]'
    } else if ('\\.+^$()[]{}|'.includes(character)) {
      source += '\\' + character
    } else {
      source += character
    }
  }
  if (!pattern.includes('*') && !pattern.includes('?')) source += '(?:/.*)?'
  return new RegExp(source + '$')
}

function checkPackReport(record, entries) {
  if (!Array.isArray(record.files)) fail('pnpm pack JSON did not contain a files list')
  const reportPaths = record.files.map((file) => {
    if (!isRecord(file) || typeof file.path !== 'string' || file.path === '' || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').some((part) => part === '..')) fail('pnpm pack report contains an invalid file path')
    return packageEntry(file.path)
  })
  if (new Set(reportPaths).size !== reportPaths.length) fail('pnpm pack report contains duplicate files')
  const archivePaths = entries.filter((entry) => entry.startsWith('package/') && !entry.endsWith('/'))
  const expected = [...new Set(reportPaths)].sort()
  const actual = [...new Set(archivePaths)].sort()
  if (expected.length !== actual.length || expected.some((entry, index) => entry !== actual[index])) fail('pnpm pack report does not match tarball entries')
  ok('pack report and tarball entries match exactly')
}

function isDependencyAlias(specifier) {
  return specifier.startsWith('file:') || specifier.startsWith('link:') || specifier.startsWith('workspace:') || specifier.startsWith('/') || specifier.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(specifier) || specifier.startsWith('~/')
}

function checkOverrideValues(value, label) {
  if (typeof value === 'string') {
    if (isDependencyAlias(value)) fail(label + ' contains a local alias')
    return
  }
  if (!isRecord(value)) fail(label + ' contains an invalid override value')
  for (const [name, nested] of Object.entries(value)) checkOverrideValues(nested, label + '.' + name)
}

function checkNoDependencyAliases(packageJson, label) {
  for (const sectionName of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const section = packageJson[sectionName]
    if (section === undefined) continue
    if (!isRecord(section)) fail(label + ' has an invalid ' + sectionName + ' section')
    for (const [name, specifier] of Object.entries(section)) {
      if (typeof specifier !== 'string' || isDependencyAlias(specifier)) fail(label + ' contains a local alias in ' + sectionName + '.' + name)
    }
  }
  if (packageJson.pnpm === undefined) return
  if (!isRecord(packageJson.pnpm) || packageJson.pnpm.overrides === undefined) return
  if (!isRecord(packageJson.pnpm.overrides)) fail(label + ' has invalid pnpm overrides')
  checkOverrideValues(packageJson.pnpm.overrides, label + ' pnpm.overrides')
}

function checkTarTextNegativeCases() {
  let rejected = false
  try {
    tarText('/tmp/missing-dsh-buddy-tarball', '--version')
  } catch (error) {
    if (error instanceof Error && error.message.includes('must not be an option')) rejected = true
    else throw error
  }
  if (!rejected) fail('tar member extraction accepted an option-shaped entry name')
  ok('tar member extraction uses -- and rejects option-shaped names')
}

function checkTarEntriesNegativeCases() {
  const cases = [
    { name: '--version', message: 'option-shaped entry' },
    { name: 'other', message: 'archive root' },
    { name: 'control\tname', message: 'control character' },
    { name: 'fifo', message: 'non-regular entry', fifo: true },
    { name: 'link', message: 'non-regular entry', symlink: true },
  ]
  for (const item of cases) {
    const root = mkdtempSync(join(tmpdir(), 'dsh-buddy-tar-entry-'))
    const member = join(root, item.name)
    const archive = join(root, 'case.tgz')
    try {
      if (item.fifo) command('mkfifo', [member])
      else if (item.symlink) {
        writeFileSync(join(root, 'target'), 'fixture')
        symlinkSync('target', member)
      } else writeFileSync(member, 'fixture')
      command('tar', ['-czf', archive, '-C', root, '--', item.name])
      let rejected = false
      try {
        tarEntries(archive)
      } catch (error) {
        if (error instanceof Error && error.message.includes(item.message)) rejected = true
        else throw error
      }
      if (!rejected) fail('tar entry validator accepted ' + item.message)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  ok('tar entries accept only regular files/directories and reject unsafe names')
}

function checkDependencyAliasNegativeCases() {
  const cases = [
    { dependencies: { bad: 'file:./fixtures' } },
    { devDependencies: { bad: 'link:../local' } },
    { peerDependencies: { bad: 'workspace:*' } },
    { optionalDependencies: { bad: '/absolute/path' } },
    { pnpm: { overrides: { bad: 'C:/local' } } },
  ]
  for (const candidate of cases) {
    let rejected = false
    try { checkNoDependencyAliases(candidate, 'negative alias case') } catch (error) {
      if (error instanceof Error && error.message.includes('local alias')) rejected = true
      else throw error
    }
    if (!rejected) fail('packed-manifest alias validator accepted a forbidden alias')
  }
  ok('packed-manifest alias negative cases are rejected')
}

function checkProvenanceGraphNegativeCases(provenance, sourcePackage, records) {
  const cases = [
    (candidate) => { candidate.edges = candidate.edges.slice(1) },
    (candidate) => {
      const edge = candidate.edges.find((item) => item.range !== null)
      edge.range = '0.0.0'
    },
    (candidate) => {
      const edge = candidate.edges.find((item) => item.field === 'dependencies')
      edge.field = 'runtime-import'
    },
    (candidate) => {
      candidate.edges[0].reachable = false
    },
    (candidate) => {
      candidate.edges = candidate.edges.filter((edge) => edge.child !== 'negotiator@0.6.4')
    },
    (candidate) => {
      candidate.edges.push({ parent: packageKey(packageName, packageVersion), child: 'bytes@3.1.2', range: null, field: 'runtime-import', reachable: true })
    },
  ]
  for (const mutate of cases) {
    const candidate = JSON.parse(JSON.stringify(provenance))
    mutate(candidate)
    let rejected = false
    try {
      checkProvenanceGraph(candidate, sourcePackage, records)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('[artifact-gate]')) rejected = true
      else throw error
    }
    if (!rejected) fail('provenance graph negative case was accepted')
  }
  const firstRuntime = fixtureRuntimeImports.entries().next().value
  if (!firstRuntime) fail('provenance graph runtime-import negative case has no fixture')
  const [runtimeParent, originalRuntimeImports] = firstRuntime
  fixtureRuntimeImports.set(runtimeParent, new Set([...originalRuntimeImports, '@artifact-gate/undeclared-runtime-import']))
  let undeclaredRejected = false
  try {
    checkProvenanceGraph(provenance, sourcePackage, records)
  } catch (error) {
    if (error instanceof Error && error.message.includes('undeclared runtime import')) undeclaredRejected = true
    else throw error
  } finally {
    fixtureRuntimeImports.set(runtimeParent, originalRuntimeImports)
  }
  if (!undeclaredRejected) fail('provenance graph accepted an undeclared runtime import')
  ok('provenance graph negative cases reject missing, wrong, unreachable, multi-version, extra, and undeclared-runtime edges')
}

function manifestEntry(entries) {
  if (!entries.includes('package/package.json')) fail('fixture tarball must contain package/package.json')
  return 'package/package.json'
}

function checkFixtureDeliverability(files) {
  for (const file of files) {
    const result = spawnSync('git', ['check-ignore', '--no-index', '-q', join('fixtures', 'alpha1', file)], { cwd, encoding: 'utf8', env: scrubSubprocessEnvironment() })
    if (result.status !== 1) fail('fixture tarball must fail git check-ignore: ' + file + ' (status ' + String(result.status) + ')')
  }
  ok('fixture tarballs are deliverable and not ignored')
}

const fixtureManifests = new Map()
const fixtureRuntimeImports = new Map()
const graphFieldNames = new Set(['dependencies', 'optionalDependencies', 'peerDependencies', 'runtime-import', 'browser-entrypoint'])
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const rangeVersionPattern = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*|[xX*]))?(?:\.(0|[1-9]\d*|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const rangeTokenPattern = /^(?:(\^|~|>=|<=|>|<|=)\s*)?((?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/

function packageKey(name, version) {
  return name + '@' + version
}

function splitPackageKey(key) {
  const separator = key.lastIndexOf('@')
  if (separator <= 0 || separator === key.length - 1) fail('provenance graph contains an invalid package key: ' + key)
  return { name: key.slice(0, separator), version: key.slice(separator + 1) }
}

function parseSemver(value) {
  if (typeof value !== 'string') return undefined
  const match = semverPattern.exec(value)
  if (!match) return undefined
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part))) return undefined
  return { major, minor, patch, prerelease: match[4] === undefined ? [] : match[4].split('.') }
}

function compareSemver(left, right) {
  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

function parseRangeVersion(value) {
  if (/^[xX*]$/.test(value)) return null
  const match = rangeVersionPattern.exec(value)
  if (!match) return undefined
  const major = Number(match[1])
  const minor = match[2] === undefined || /^[xX*]$/.test(match[2]) ? undefined : Number(match[2])
  const patch = match[3] === undefined || /^[xX*]$/.test(match[3]) ? undefined : Number(match[3])
  if (!Number.isSafeInteger(major) || (minor !== undefined && !Number.isSafeInteger(minor)) || (patch !== undefined && !Number.isSafeInteger(patch))) return undefined
  return { major, minor, patch, prerelease: match[4] === undefined ? [] : match[4].split('.') }
}

function parseRangeArm(value) {
  let remaining = value.trim()
  if (remaining === '') return undefined
  const constraints = []
  while (remaining !== '') {
    const match = rangeTokenPattern.exec(remaining)
    if (!match) return undefined
    const parsed = parseRangeVersion(match[2])
    if (parsed === undefined) return undefined
    constraints.push({ operator: match[1] ?? '', version: parsed })
    remaining = remaining.slice(match[0].length).trim()
  }
  return constraints
}

function boundVersion(value, minor = 0, patch = 0) {
  return { major: value.major, minor: value.minor ?? minor, patch: value.patch ?? patch, prerelease: value.prerelease }
}

function compareRangeVersion(left, right) {
  return compareSemver(left, right)
}

function rangeConstraintMatches(version, constraint) {
  const { operator, version: bound } = constraint
  if (bound === null) return true
  if (operator === '' || operator === '=') {
    if (version.major !== bound.major) return false
    if (bound.minor !== undefined && version.minor !== bound.minor) return false
    if (bound.patch !== undefined && version.patch !== bound.patch) return false
    if (bound.patch !== undefined && bound.prerelease.length > 0 && compareRangeVersion(version, bound) !== 0) return false
    return true
  }
  if (operator === '^' || operator === '~') {
    const lower = boundVersion(bound)
    let upper
    if (operator === '~') {
      upper = bound.minor === undefined ? { major: bound.major + 1, minor: 0, patch: 0, prerelease: [] } : { major: bound.major, minor: bound.minor + 1, patch: 0, prerelease: [] }
    } else if (bound.major > 0) {
      upper = { major: bound.major + 1, minor: 0, patch: 0, prerelease: [] }
    } else if (bound.minor === undefined) {
      upper = { major: 1, minor: 0, patch: 0, prerelease: [] }
    } else if (bound.minor > 0) {
      upper = { major: 0, minor: bound.minor + 1, patch: 0, prerelease: [] }
    } else {
      upper = { major: 0, minor: 0, patch: (bound.patch ?? 0) + 1, prerelease: [] }
    }
    return compareSemver(version, lower) >= 0 && compareSemver(version, upper) < 0
  }
  const lower = boundVersion(bound)
  const comparison = compareSemver(version, lower)
  if (operator === '>') return comparison > 0
  if (operator === '>=') return comparison >= 0
  if (operator === '<') return comparison < 0
  if (operator === '<=') return comparison <= 0
  return false
}

function satisfiesSemver(version, range) {
  const parsedVersion = parseSemver(version)
  if (parsedVersion === undefined || typeof range !== 'string' || range.trim() === '') return false
  const arms = range.split('||').map(parseRangeArm)
  if (arms.some((arm) => arm === undefined)) return false
  return arms.some((constraints) => constraints.every((constraint) => rangeConstraintMatches(parsedVersion, constraint)))
}

function collectRuntimeImports(tarball, entries, packageName) {
  const imports = new Set()
  for (const entry of entries.filter((item) => item.endsWith('.js') || item.endsWith('.mjs') || item.endsWith('.cjs'))) {
    const code = tarText(tarball, entry)
    const specifiers = new Set([...staticImports(code), ...staticRequires(code)])
    for (const specifier of specifiers) {
      if (specifier.startsWith('node:') || specifier.startsWith('.') || specifier.startsWith('/')) continue
      const root = packageRoot(specifier)
      if (root === packageName || builtinModules.includes(root)) continue
      imports.add(root)
    }
  }
  return imports
}

function graphCandidates(byName, name, range) {
  const candidates = byName.get(name) ?? []
  if (range === null) return candidates
  return candidates.filter((record) => satisfiesSemver(record.version, range))
}

function expectedProvenanceEdges(sourcePackage, records, manifests, runtimeImports) {
  const root = packageKey(packageName, packageVersion)
  const browserEntrypoint = '@deepseek-ai/dsh-client-modules'
  const byName = new Map()
  for (const record of records.values()) {
    const list = byName.get(record.name) ?? []
    list.push(record)
    byName.set(record.name, list)
  }
  const edges = []
  const edgeKeys = new Set()
  const visited = new Set([root])
  const queue = [root]
  const addEdge = (parent, name, range, field) => {
    const candidates = graphCandidates(byName, name, range)
    const peerRuntime = field === 'peerDependencies' && (runtimeImports.get(parent)?.has(name) ?? false)
    const parentManifest = parent === root ? sourcePackage : manifests.get(parent)
    const parentPeerMeta = parentManifest?.peerDependenciesMeta
    const optionalPeer = field === 'peerDependencies' && isRecord(parentPeerMeta) && isRecord(parentPeerMeta[name]) && parentPeerMeta[name].optional === true
    const required = field === 'dependencies' || field === 'browser-entrypoint' || (peerRuntime && !optionalPeer) || (parent === root && field === 'peerDependencies')
    if (candidates.length === 0) {
      if (required) fail('provenance graph has no locked ' + field + ' target for ' + parent + ' -> ' + name + (range === null ? '' : ' (' + range + ')'))
      return undefined
    }
    if (candidates.length !== 1) fail('provenance graph has an ambiguous multi-version target for ' + parent + ' -> ' + name + (range === null ? '' : ' (' + range + ')'))
    const child = packageKey(candidates[0].name, candidates[0].version)
    const key = parent + '\0' + child + '\0' + field
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key)
      edges.push({ parent, child, range, field, reachable: true })
    }
    if (!visited.has(child)) {
      visited.add(child)
      queue.push(child)
    }
    return child
  }
  const rootFields = ['dependencies', 'peerDependencies']
  for (const field of rootFields) {
    const section = sourcePackage[field]
    if (section === undefined) continue
    if (!isRecord(section)) fail('source package.json has an invalid ' + field + ' section')
    for (const [name, range] of Object.entries(section)) {
      if (typeof range !== 'string') fail('source package.json has an invalid range for ' + name)
      addEdge(root, name, range, field)
    }
  }
  addEdge(root, browserEntrypoint, null, 'browser-entrypoint')
  while (queue.length > 0) {
    const parent = queue.shift()
    if (parent === root) continue
    const manifest = manifests.get(parent)
    if (!manifest) fail('provenance graph reached a package without a manifest: ' + parent)
    for (const field of ['dependencies', 'optionalDependencies']) {
      const section = manifest[field]
      if (section === undefined) continue
      if (!isRecord(section)) fail(parent + ' has an invalid ' + field + ' section')
      for (const [name, range] of Object.entries(section)) {
        if (typeof range !== 'string') fail(parent + ' has an invalid range for ' + field + '.' + name)
        addEdge(parent, name, range, field)
      }
    }
    const peers = manifest.peerDependencies
    if (peers !== undefined && !isRecord(peers)) fail(parent + ' has an invalid peerDependencies section')
    const peerMeta = manifest.peerDependenciesMeta
    if (peerMeta !== undefined && !isRecord(peerMeta)) fail(parent + ' has an invalid peerDependenciesMeta section')
    const imports = runtimeImports.get(parent) ?? new Set()
    for (const [name, range] of Object.entries(peers ?? {})) {
      if (typeof range !== 'string') fail(parent + ' has an invalid peer dependency range for ' + name)
      const metadata = peerMeta?.[name]
      const optional = isRecord(metadata) && metadata.optional === true
      if (optional || imports.has(name)) addEdge(parent, name, range, 'peerDependencies')
    }
    const declared = new Set([
      ...Object.keys(isRecord(manifest.dependencies) ? manifest.dependencies : {}),
      ...Object.keys(isRecord(manifest.optionalDependencies) ? manifest.optionalDependencies : {}),
      ...Object.keys(isRecord(manifest.peerDependencies) ? manifest.peerDependencies : {}),
    ])
    for (const name of imports) {
      if (declared.has(name)) continue
      const candidates = byName.get(name) ?? []
      if (candidates.length === 1) addEdge(parent, name, null, 'runtime-import')
      else if (candidates.length > 1) fail('provenance graph cannot choose a version for runtime import ' + parent + ' -> ' + name)
      else fail('provenance graph has an undeclared runtime import: ' + parent + ' -> ' + name)
    }
  }
  if (visited.size !== records.size + 1) {
    const unreachable = [...records.values()].map((record) => packageKey(record.name, record.version)).filter((key) => !visited.has(key))
    fail('provenance graph has unreachable package records: ' + unreachable.join(', '))
  }
  return edges.sort((left, right) => {
    for (const field of ['parent', 'field', 'child']) {
      if (left[field] === right[field]) continue
      return left[field] < right[field] ? -1 : 1
    }
    return 0
  })
}

function checkProvenanceGraph(provenance, sourcePackage, records) {
  const root = packageKey(packageName, packageVersion)
  const expectedRoots = [root, packageKey('@deepseek-ai/dsh-client-modules', alpha1Version)]
  if (!Array.isArray(provenance.roots) || JSON.stringify(provenance.roots) !== JSON.stringify(expectedRoots)) fail('alpha1 provenance graph roots are not exact')
  const expected = expectedProvenanceEdges(sourcePackage, records, fixtureManifests, fixtureRuntimeImports)
  if (!Array.isArray(provenance.edges)) fail('alpha1 provenance is missing locked package graph edges')
  const expectedByKey = new Map(expected.map((edge) => [edge.parent + '\0' + edge.child + '\0' + edge.field, edge]))
  const actualByKey = new Map()
  for (const edge of provenance.edges) {
    if (!isRecord(edge)) fail('alpha1 provenance graph contains a malformed edge')
    const keys = Object.keys(edge).sort().join(',')
    if (keys !== 'child,field,parent,range,reachable') fail('alpha1 provenance graph edge has extra or missing fields')
    if (typeof edge.parent !== 'string' || typeof edge.child !== 'string' || (typeof edge.range !== 'string' && edge.range !== null) || typeof edge.field !== 'string' || typeof edge.reachable !== 'boolean') fail('alpha1 provenance graph edge has invalid fields')
    if (!graphFieldNames.has(edge.field)) fail('alpha1 provenance graph edge has an invalid declaration field')
    const key = edge.parent + '\0' + edge.child + '\0' + edge.field
    if (actualByKey.has(key)) fail('alpha1 provenance graph contains a duplicate edge')
    actualByKey.set(key, edge)
    const child = splitPackageKey(edge.child)
    if (fixtureManifests.has(edge.child) === false) fail('alpha1 provenance graph points to an unpinned package: ' + edge.child)
    if (edge.range !== null && !satisfiesSemver(child.version, edge.range)) fail('alpha1 provenance graph has a semver mismatch: ' + edge.parent + ' -> ' + edge.child + ' (' + edge.range + ')')
    if (edge.reachable !== true) fail('alpha1 provenance graph marks a locked edge unreachable: ' + key)
  }
  if (actualByKey.size !== expectedByKey.size) fail('alpha1 provenance graph edge set is not exact')
  for (const [key, expectedEdge] of expectedByKey) {
    const actual = actualByKey.get(key)
    if (!actual || JSON.stringify(actual) !== JSON.stringify(expectedEdge)) fail('alpha1 provenance graph edge differs from the locked declaration: ' + key)
  }
  const versionsByName = new Map()
  for (const record of records.values()) {
    const versions = versionsByName.get(record.name) ?? new Set()
    versions.add(record.version)
    versionsByName.set(record.name, versions)
  }
  for (const [name, versions] of versionsByName) {
    if (versions.size <= 1) continue
    for (const version of versions) {
      const child = packageKey(name, version)
      if (![...actualByKey.values()].some((edge) => edge.child === child)) fail('alpha1 provenance multi-version package is not reachable: ' + child)
    }
  }
  ok('alpha1 provenance graph edges, declarations, semver, reachability, and multi-version selections are exact')
}

function checkAlpha1Fixtures(sourcePackage) {
  const fixtureRoot = join(cwd, 'fixtures', 'alpha1')
  assertFixtureDirectory(fixtureRoot, 'alpha1')
  const provenancePath = join(fixtureRoot, 'provenance.json')
  assertRegularFixture(provenancePath, 'provenance.json')
  const provenance = parseJson(readFileSync(provenancePath, 'utf8'), 'alpha1 fixture provenance')
  if (provenance.format !== 1 || !isRecord(provenance.officialCheckout) || provenance.officialCheckout.repository !== officialRepository || provenance.officialCheckout.tag !== officialTag || provenance.officialCheckout.commit !== officialCommit) fail('alpha1 fixture provenance is not pinned to the official release commit')
  if (JSON.stringify(provenance.entrypoints) !== JSON.stringify(['dsh-buddy Host', 'dsh-buddy/client', '@deepseek-ai/dsh-client-modules/client'])) fail('alpha1 fixture provenance entrypoints are not exact')
  if (!Array.isArray(provenance.packages) || provenance.packages.length !== fixtureSpecs.length) fail('alpha1 fixture provenance package set is not exact')
  const actualEntries = readdirSync(fixtureRoot).sort()
  for (const entry of actualEntries) assertRegularFixture(join(fixtureRoot, entry), entry)
  if (actualEntries.some((entry) => entry !== 'provenance.json' && !entry.endsWith('.tgz'))) fail('alpha1 fixtures contain an extracted or unexpected entry')
  const files = actualEntries.filter((entry) => entry.endsWith('.tgz'))
  if (files.length !== fixtureSpecs.length) fail('alpha1 fixture tarball set is not exact')
  checkFixtureDeliverability(files)
  const records = new Map()
  for (const record of provenance.packages) {
    if (!isRecord(record) || typeof record.name !== 'string' || typeof record.version !== 'string') fail('alpha1 provenance contains a malformed package record')
    if (Object.keys(record).sort().join(',') !== 'bytes,file,name,sha256,size,source,version') fail('alpha1 provenance package record has extra or missing fields')
    const key = record.name + '@' + record.version
    if (records.has(key) || !fixtureSpecKeys.has(key)) fail('alpha1 provenance contains an unexpected or duplicate package record: ' + key)
    records.set(key, record)
  }
  for (const [name, version] of fixtureSpecs) {
    const key = name + '@' + version
    const record = records.get(key)
    const expected = expectedFixtureRecords.get(key)
    if (!record || !expected) fail('alpha1 provenance is missing ' + key)
    if (typeof record.file !== 'string' || record.file.includes('/') || record.file.includes('\\') || !record.file.endsWith('.tgz')) fail('alpha1 provenance has an invalid tarball filename for ' + key)
    const path = join(fixtureRoot, record.file)
    if (!files.includes(record.file)) fail('alpha1 provenance tarball is missing for ' + key)
    assertRegularFixture(path, record.file)
    const bytes = readFileSync(path)
    if (!Number.isSafeInteger(record.bytes) || record.bytes !== expected.size || record.bytes !== bytes.byteLength || record.size !== expected.size) fail('alpha1 tarball size mismatch for ' + key)
    if (typeof record.sha256 !== 'string' || record.sha256 !== expected.sha256 || !/^[0-9a-f]{64}$/.test(record.sha256) || createHash('sha256').update(bytes).digest('hex') !== record.sha256) fail('alpha1 tarball SHA-256 mismatch for ' + key)
    const entries = tarEntries(path)
    const packageJson = parseJson(tarText(path, manifestEntry(entries)), key + ' package.json')
    if (packageJson.name !== name || packageJson.version !== version) fail('alpha1 tarball manifest mismatch for ' + key)
    fixtureManifests.set(key, packageJson)
    fixtureRuntimeImports.set(key, collectRuntimeImports(path, entries, name))
    if (name.startsWith('@deepseek-ai/')) {
      if (!isRecord(record.source) || Object.keys(record.source).sort().join(',') !== 'commit,kind,repository,tag' || record.source.kind !== 'official-clean-checkout' || record.source.repository !== officialRepository || record.source.tag !== officialTag || record.source.commit !== officialCommit) fail('official provenance is incomplete for ' + key)
    } else {
      const normalized = isRecord(record.source) && record.source.kind === 'registry-normalized'
      const sourceKind = normalized ? 'registry-normalized' : 'registry'
      const expectedArchiveIntegrity = normalized ? expected.archiveIntegrity : expected.integrity
      const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
      if (!isRecord(record.source) || Object.keys(record.source).sort().join(',') !== (normalized ? 'archiveIntegrity,integrity,kind,registry' : 'integrity,kind,registry') || record.source.kind !== sourceKind || record.source.registry !== 'https://registry.npmjs.org' || record.source.integrity !== expected.integrity || expectedArchiveIntegrity !== integrity) fail('registry provenance integrity mismatch for ' + key)
    }
  }
  const recordedFiles = new Set([...records.values()].map((record) => record.file))
  if (recordedFiles.size !== files.length || files.some((file) => !recordedFiles.has(file))) fail('alpha1 provenance tarball file set is not exact')
  checkProvenanceGraph(provenance, sourcePackage, records)
  checkProvenanceGraphNegativeCases(provenance, sourcePackage, records)
  ok('alpha1 tarballs are exact, regular, version-pinned, and provenance-verified')
}

function checkPackageExportsAndFiles(entries, packageJson) {
  if (!isRecord(packageJson.exports)) fail('package.json exports must be an object')
  const exportTargets = []
  collectExportTargets(packageJson.exports, exportTargets, '')
  for (const target of new Set(exportTargets)) requireEntry(entries, target)
  if (!Array.isArray(packageJson.files) || packageJson.files.length === 0) fail('package.json files must be a non-empty array')
  for (const pattern of packageJson.files) {
    if (typeof pattern !== 'string' || pattern === '') fail('package.json files contains an invalid pattern')
    const matcher = globPattern(pattern)
    if (!entries.some((entry) => entry.startsWith('package/') && matcher.test(entry.slice('package/'.length)))) fail('package.json files pattern has no packed match: ' + pattern)
  }
  const declaredFiles = packageJson.files.map((pattern) => globPattern(pattern))
  for (const entry of entries.filter((item) => item.startsWith('package/') && !item.endsWith('/'))) {
    const relativePath = entry.slice('package/'.length)
    if (relativePath !== 'package.json' && !declaredFiles.some((matcher) => matcher.test(relativePath))) fail('tarball contains an undeclared packed file: ' + relativePath)
  }
  for (const target of ['lib/index.js', 'lib/client.js', 'lib/types/index.d.ts', 'lib/types/client/index.d.ts', 'page/index.html', 'page/buddy.js', 'page/buddy.css', 'page/buddy-sprites.png', 'cordis.patch.yml', 'README.md']) requireEntry(entries, target)
  ok('exports, declared files, and page assets are present')
}

function checkForbiddenEntries(entries) {
  const forbidden = [/^package\/(?:src|fixtures|node_modules|scripts)(?:\/|$)/, /^package\/(?:tsconfig|vitest|eslint|tsdown|pnpm-lock)/, /\.map$/, /\.orig\./]
  for (const entry of entries) if (forbidden.some((pattern) => pattern.test(entry))) fail('tarball contains forbidden path: ' + entry)
  ok('no source, fixture, map, or build-control paths are packed')
}

function staticImports(code) {
  return staticModuleSpecifiers(code, false)
}

function staticRequires(code) {
  return staticModuleSpecifiers(code, true)
}

function staticModuleSpecifiers(code, includeCommonJs) {
  const tokens = []
  let index = 0
  const identifierStart = /[A-Za-z_$]/
  const identifierPart = /[A-Za-z0-9_$]/
  const canStartRegex = (token) => {
    if (token === undefined) return true
    if (token.kind === 'punctuator') return '([{,;:=!?&|+-*%^~<>'.includes(token.value)
    return token.kind === 'identifier' && ['case', 'delete', 'do', 'else', 'in', 'instanceof', 'of', 'return', 'throw', 'typeof', 'void', 'yield', 'await'].includes(token.value)
  }

  const readString = (quote) => {
    index += 1
    let value = ''
    while (index < code.length) {
      const next = code[index]
      if (next === '\\') {
        if (index + 1 < code.length) value += code[index + 1]
        index += 2
        continue
      }
      index += 1
      if (next === quote) break
      value += next
    }
    return value
  }

  function skipRegexLiteral() {
    index += 1
    let escaped = false
    let inClass = false
    while (index < code.length) {
      const next = code[index++]
      if (escaped) {
        escaped = false
        continue
      }
      if (next === '\\') {
        escaped = true
        continue
      }
      if (next === '[') inClass = true
      else if (next === ']') inClass = false
      else if (next === '/' && !inClass) break
    }
    while (index < code.length && /[A-Za-z]/.test(code[index])) index += 1
  }

  function skipTemplateExpression() {
    let depth = 1
    let previousToken
    while (index < code.length && depth > 0) {
      const character = code[index]
      if (/\s/.test(character)) {
        index += 1
        continue
      }
      if (character === '/' && code[index + 1] === '/') {
        index += 2
        while (index < code.length && code[index] !== '\n') index += 1
        continue
      }
      if (character === '/' && code[index + 1] === '*') {
        const end = code.indexOf('*/', index + 2)
        index = end === -1 ? code.length : end + 2
        continue
      }
      if (character === '\'' || character === '"') {
        const value = readString(character)
        const token = { kind: 'string', value }
        tokens.push(token)
        previousToken = token
        continue
      }
      if (character === '`') {
        const token = { kind: 'template', value: '' }
        tokens.push(token)
        skipTemplateLiteral()
        previousToken = token
        continue
      }
      if (character === '/' && canStartRegex(previousToken)) {
        skipRegexLiteral()
        const token = { kind: 'regex', value: '' }
        tokens.push(token)
        previousToken = token
        continue
      }
      if (character === '{') {
        depth += 1
        const token = { kind: 'punctuator', value: character }
        tokens.push(token)
        previousToken = token
        index += 1
        continue
      }
      if (character === '}') {
        depth -= 1
        if (depth > 0) {
          const token = { kind: 'punctuator', value: character }
          tokens.push(token)
          previousToken = token
        }
        index += 1
        continue
      }
      if (identifierStart.test(character)) {
        const start = index
        index += 1
        while (index < code.length && identifierPart.test(code[index])) index += 1
        const token = { kind: 'identifier', value: code.slice(start, index) }
        tokens.push(token)
        previousToken = token
        continue
      }
      if (/[0-9]/.test(character)) {
        index += 1
        while (index < code.length && /[A-Za-z0-9_.]/.test(code[index])) index += 1
        const token = { kind: 'number', value: '' }
        tokens.push(token)
        previousToken = token
        continue
      }
      const token = { kind: 'punctuator', value: character }
      tokens.push(token)
      previousToken = token
      index += 1
    }
  }

  function skipTemplateLiteral() {
    index += 1
    while (index < code.length) {
      const character = code[index]
      if (character === '\\') {
        index += 2
        continue
      }
      if (character === '`') {
        index += 1
        return
      }
      if (character === '$' && code[index + 1] === '{') {
        index += 2
        skipTemplateExpression()
        continue
      }
      index += 1
    }
  }

  while (index < code.length) {
    const character = code[index]
    if (/\s/.test(character)) {
      index += 1
      continue
    }
    if (character === '/' && code[index + 1] === '/') {
      index += 2
      while (index < code.length && code[index] !== '\n') index += 1
      continue
    }
    if (character === '/' && code[index + 1] === '*') {
      const end = code.indexOf('*/', index + 2)
      index = end === -1 ? code.length : end + 2
      continue
    }
    if (character === '`') {
      skipTemplateLiteral()
      continue
    }
    if (character === '\'' || character === '"') {
      tokens.push({ kind: 'string', value: readString(character) })
      continue
    }
    if (character === '/' && canStartRegex(tokens.at(-1))) {
      skipRegexLiteral()
      continue
    }
    if (identifierStart.test(character)) {
      const start = index
      index += 1
      while (index < code.length && identifierPart.test(code[index])) index += 1
      tokens.push({ kind: 'identifier', value: code.slice(start, index) })
      continue
    }
    tokens.push({ kind: 'punctuator', value: character })
    index += 1
  }
  const callOpen = (tokenIndex) => {
    const next = tokens[tokenIndex + 1]
    if (next?.kind === 'punctuator' && next.value === '(') return tokenIndex + 1
    if (next?.kind === 'punctuator' && next.value === '?' && tokens[tokenIndex + 2]?.kind === 'punctuator' && tokens[tokenIndex + 2].value === '.' && tokens[tokenIndex + 3]?.kind === 'punctuator' && tokens[tokenIndex + 3].value === '(') return tokenIndex + 3
    return undefined
  }
  const closingParenthesis = (openIndex) => {
    if (openIndex === undefined) return undefined
    let depth = 0
    for (let tokenIndex = openIndex; tokenIndex < tokens.length; tokenIndex += 1) {
      const token = tokens[tokenIndex]
      if (token.kind !== 'punctuator') continue
      if (token.value === '(') depth += 1
      else if (token.value === ')') {
        depth -= 1
        if (depth === 0) return tokenIndex
      }
    }
    return undefined
  }
  const staticStringCall = (openIndex) => {
    if (openIndex === undefined || tokens[openIndex + 1]?.kind !== 'string' || tokens[openIndex + 2]?.kind !== 'punctuator' || tokens[openIndex + 2].value !== ')') return undefined
    return tokens[openIndex + 1].value
  }
  const imports = new Set()
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex]
    if (token.kind !== 'identifier' || (includeCommonJs ? !['require', 'createRequire'].includes(token.value) : (token.value !== 'import' && token.value !== 'export'))) continue
    const next = tokens[tokenIndex + 1]
    if (token.value === 'import' && next?.kind === 'string') {
      imports.add(next.value)
      continue
    }
    if (!includeCommonJs && next?.kind === 'punctuator' && next.value === '(' && tokens[tokenIndex + 2]?.kind === 'string' && tokens[tokenIndex + 3]?.kind === 'punctuator' && tokens[tokenIndex + 3].value === ')') {
      imports.add(tokens[tokenIndex + 2].value)
      continue
    }
    if (!includeCommonJs && next?.kind === 'punctuator' && next.value === '.') continue
    if (includeCommonJs) {
      const previous = tokens[tokenIndex - 1]
      if (token.value === 'require' && previous?.kind === 'punctuator' && previous.value === '.') continue
      const openIndex = callOpen(tokenIndex)
      if (token.value === 'require') {
        const specifier = staticStringCall(openIndex)
        if (specifier !== undefined) imports.add(specifier)
      } else {
        const closeIndex = closingParenthesis(openIndex)
        const specifier = staticStringCall(callOpen(closeIndex))
        if (specifier !== undefined) imports.add(specifier)
      }
      continue
    }
    let depth = 0
    for (let candidateIndex = tokenIndex + 1; candidateIndex < tokens.length; candidateIndex += 1) {
      const candidate = tokens[candidateIndex]
      if (candidate.kind === 'punctuator' && '([{'.includes(candidate.value)) depth += 1
      else if (candidate.kind === 'punctuator' && ')]}'.includes(candidate.value)) {
        if (depth === 0) break
        depth -= 1
      }
      if (depth === 0 && candidate.kind === 'punctuator' && candidate.value === ';') break
      if (depth === 0 && candidate.kind === 'identifier' && candidate.value === 'from' && tokens[candidateIndex + 1]?.kind === 'string') {
        imports.add(tokens[candidateIndex + 1].value)
        break
      }
    }
  }
  return imports
}

function checkRuntimeImportScannerNegativeCases() {
  const source = [
    'const prose = "from \"@artifact-gate/false\"";',
    '// import("@artifact-gate/comment")',
    'const template = `require("@artifact-gate/template")`;',
    'const nested = `outer ${`from "${current.goal.phase}"`} end`;',
    'const interpolatedRequire = `value ${require("@artifact-gate/interpolated-cjs")}`;',
    'const interpolatedImport = `value ${import("@artifact-gate/interpolated-esm")}`;',
    'const interpolatedCreateRequire = `value ${createRequire(import.meta.url)("@artifact-gate/interpolated-create")}`;',
    'const created = createRequire(import.meta.url)("@artifact-gate/create-require");',
    'const optional = require?.("@artifact-gate/optional-require");',
    'const dynamic = import("@artifact-gate/dynamic");',
    'const value = require("@artifact-gate/cjs");',
    'const property = object.require("@artifact-gate/property");',
    'import "@artifact-gate/real";',
    'export { value } from "@artifact-gate/export";',
  ].join(newline)
  const imports = staticImports(source)
  const requires = staticRequires(source)
  if (imports.has('@artifact-gate/false') || imports.has('@artifact-gate/comment') || imports.has('@artifact-gate/template') || imports.has('${current.goal.phase}') || imports.has('@artifact-gate/cjs') || imports.has('@artifact-gate/interpolated-cjs') || imports.has('@artifact-gate/property')) fail('runtime import scanner accepted a string, comment, template, or CommonJS import')
  if (!imports.has('@artifact-gate/real') || !imports.has('@artifact-gate/export') || !imports.has('@artifact-gate/dynamic') || !imports.has('@artifact-gate/interpolated-esm') || !requires.has('@artifact-gate/cjs') || !requires.has('@artifact-gate/interpolated-cjs') || !requires.has('@artifact-gate/interpolated-create') || !requires.has('@artifact-gate/create-require') || !requires.has('@artifact-gate/optional-require') || requires.has('@artifact-gate/property')) fail('runtime import scanner missed or misclassified a module import')
  ok('runtime import scanner ignores inert text and finds runtime module imports')
}

function packageRoot(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}

function checkLocalImport(entries, sourceEntry, specifier) {
  const sourceDirectory = posix.dirname(sourceEntry)
  const rawTarget = posix.normalize(posix.join(sourceDirectory, specifier))
  const candidates = [rawTarget]
  if (!posix.extname(rawTarget)) candidates.push(rawTarget + '.js', rawTarget + '.json', posix.join(rawTarget, 'index.js'))
  if (!candidates.some((candidate) => entries.includes(packageEntry(candidate)))) fail(sourceEntry + ' has an unresolved packed import: ' + specifier)
}

function checkStaticClosure(entries, packageJson) {
  const declared = new Set([...Object.keys(isRecord(packageJson.dependencies) ? packageJson.dependencies : {}), ...Object.keys(isRecord(packageJson.peerDependencies) ? packageJson.peerDependencies : {}), ...Object.keys(isRecord(packageJson.optionalDependencies) ? packageJson.optionalDependencies : {})])
  const builtin = new Set(builtinModules)
  const imports = new Set()
  for (const entry of entries.filter((item) => item.startsWith('package/lib/') && item.endsWith('.js'))) {
    const code = tarText(currentTarball, entry)
    const specifiers = new Set([...staticImports(code), ...staticRequires(code)])
    for (const specifier of specifiers) {
      imports.add(specifier)
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        checkLocalImport(entries, entry.slice('package/'.length), specifier)
        continue
      }
      const root = packageRoot(specifier)
      if (specifier.startsWith('node:') || builtin.has(specifier) || builtin.has(root)) continue
      if (!declared.has(root)) fail(entry + ' imports undeclared package: ' + specifier)
    }
  }
  ok('static import closure is declared (' + Array.from(imports).sort().join(', ') + ')')
}

function pageReferencePath(reference) {
  const prefix = '/buddy/assets/'
  const path = reference.split(/[?#]/, 1)[0]
  if (reference === '' || /[\\\s]/.test(reference) || !reference.startsWith(prefix) || !path.startsWith(prefix) || path.split('/').includes('..')) fail('page static reference must be an internal absolute asset URL: ' + reference)
  return path
}

function pageStaticReferences(text, kind) {
  const pattern = kind === 'html' ? /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]*))/gi : /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'\s]*))\s*\)/gi
  const references = []
  let match
  while ((match = pattern.exec(text)) !== null) references.push(match[1] ?? match[2] ?? match[3])
  return references
}

function checkPageClosureNegativeCases() {
  const allowed = pageReferencePath('/buddy/assets/buddy.css?v=3')
  if (allowed !== '/buddy/assets/buddy.css') fail('page static reference query handling changed unexpectedly')
  const discovered = [...pageStaticReferences('<link href = "/buddy/assets/a.css"><script src="/buddy/assets/b.js"></script><img src=/buddy/assets/c.png><a href=/buddy/assets/d.css>', 'html'), ...pageStaticReferences('.x { background: URL("/buddy/assets/x.png") }', 'css')]
  if (discovered.join(',') !== '/buddy/assets/a.css,/buddy/assets/b.js,/buddy/assets/c.png,/buddy/assets/d.css,/buddy/assets/x.png') fail('page closure did not discover every HTML/CSS reference')
  for (const reference of ['buddy.css', './buddy.css', '../buddy.css', 'https://cdn.example/buddy.css', '//cdn.example/buddy.css', 'data:text/css,body{}', '/other/buddy.css', ...pageStaticReferences('<img src="https://cdn.example/image.png"><a href="../other.css"></a>', 'html'), ...pageStaticReferences('.x { background: url() }', 'css')]) {
    let rejected = false
    try {
      pageReferencePath(reference)
    } catch (error) {
      if (error instanceof Error && error.message.includes('internal absolute asset URL')) rejected = true
      else throw error
    }
    if (!rejected) fail('page closure accepted an external or relative reference: ' + reference)
  }
  ok('page closure discovers all HTML/CSS references and rejects external or relative resources')
}

function checkPageClosure(entries) {
  const references = new Set()
  for (const entry of entries.filter((candidate) => candidate.startsWith('package/page/') && (candidate.endsWith('.html') || candidate.endsWith('.css')))) {
    const kind = entry.endsWith('.html') ? 'html' : 'css'
    for (const reference of pageStaticReferences(tarText(currentTarball, entry), kind)) references.add(reference)
  }
  for (const reference of references) requireEntry(entries, 'page/' + pageReferencePath(reference).slice('/buddy/assets/'.length))
  ok('page static references are internal, absolute, and resolve inside every packed HTML/CSS page asset')
}

function checkKioskLauncher() {
  const shell = readFileSync(join(cwd, 'scripts', 'kiosk.sh'), 'utf8')
  const legacy = readFileSync(join(cwd, 'scripts', 'kiosk.py'), 'utf8')
  const page = readFileSync(join(cwd, 'page', 'buddy.js'), 'utf8')
  const client = readFileSync(join(cwd, 'src', 'client', 'index.ts'), 'utf8')
  const chrome = readFileSync(join(cwd, 'scripts', 'kiosk_chrome.py'), 'utf8')
  const urlValidator = readFileSync(join(cwd, 'scripts', 'kiosk_urls.py'), 'utf8')
  const routes = readFileSync(join(cwd, 'src', 'host', 'routes.ts'), 'utf8')
  const sprites = readFileSync(join(cwd, 'scripts', 'normalize-sprites.py'), 'utf8')
  const host = readFileSync(join(cwd, 'src', 'index.ts'), 'utf8')
  if (!shell.includes('python3 "$ROOT/scripts/kiosk_urls.py"') || !shell.includes('exec python3 "$ROOT/scripts/kiosk_chrome.py" "$@"')) fail('kiosk shell does not use the shared validator and token-safe launcher')
  const chromeOverride = 'CHROME="${DSH_BUDDY_CHROME:-}"'
  if (!shell.includes(chromeOverride) || shell.indexOf(chromeOverride) > shell.indexOf('command -v google-chrome')) fail('kiosk shell does not honor DSH_BUDDY_CHROME before PATH lookup')
  if (shell.includes('kiosk.py') || shell.includes('WebKit') || !legacy.includes('from kiosk_chrome import main') || /\bimport gi\b/.test(legacy) || legacy.includes('WebKit') || legacy.includes('load_uri') || legacy.includes('authenticate_url')) fail('kiosk must not select the unaccepted WebKit authentication path')
  if (page.includes('mock=1') || page.includes('const MOCK') || page.includes('mock-1')) fail('Buddy page ships a production mock query mode')
  if (!page.includes('const MAX_SSE_EVENT_DATA = 512 * 1024') || !page.includes('UTF8_ENCODER.encode(event.data).byteLength > MAX_SSE_EVENT_DATA') || !page.includes('function validFrame') || !page.includes('actualCounts') || !page.includes('ids.has(row.id)') || !page.includes('state.pending.has(frame.interaction.requestId)')) fail('Buddy page does not cap and validate complete SSE frames')
  if (!client.includes('UTF8_ENCODER.encode(event.data).byteLength > MAX_EVENT_DATA_BYTES') || !client.includes('if (stream === next) closeStream()')) fail('Buddy client does not cap JSON input and close failed EventSources')
  if (!routes.includes('function rejectRequest') || !routes.includes('function rejectBodyRequest') || !routes.includes('discardRequest(req)') || !routes.includes('rejectBodyRequest(req, res, 415') || !routes.includes("rejectBodyRequest(req, res, 400, 'invalid content length'") || !routes.includes("rejectBodyRequest(req, res, 413, 'payload too large'")) fail('Buddy route validation does not dispose requests before rejection')
  if (!routes.includes("response.on('error', onError)") || !routes.includes('if (!response.write(line)) await waitForDrain(response)') || !routes.includes('for (const response of [...kioskClients])')) fail('Buddy SSE peers do not isolate errors and backpressure')
  if (!routes.includes('fsConstants.O_NOFOLLOW') || !routes.includes('READ_ONLY_DIRECTORY_NOFOLLOW') || !routes.includes('handle: FileHandle') || !routes.includes('fd: handle.fd') || !routes.includes("autoClose: false") || !routes.includes("stream.once('close', closeHandle)") || !routes.includes('handle.close().catch') || !routes.includes('/proc/self/fd')) fail('Buddy assets do not retain their FileHandle until stream close')
  if (!routes.includes('win32.relative') || !routes.includes('win32.isAbsolute')) fail('Buddy route containment is not portable across Windows drives')
  if (!routes.includes('MAX_PEER_QUEUE_ITEMS') || !routes.includes('MAX_PEER_QUEUE_BYTES') || !routes.includes('previous.items >= MAX_PEER_QUEUE_ITEMS') || !routes.includes('previous.bytes + lineBytes > MAX_PEER_QUEUE_BYTES')) fail('Buddy SSE peer write queues are not bounded')
  if (sprites.includes('assert ') || !sprites.includes('os.path.samefile') || !sprites.includes('os.replace') || !sprites.includes('NamedTemporaryFile')) fail('sprite normalization does not validate same-file inputs and atomically replace output')
  if (!urlValidator.includes('_TOKEN_QUERY = re.compile(r\"token=[A-Za-z0-9_-]{43}\\Z\")')) fail('kiosk URL validator does not require a 43-character base64url token')
  if (!chrome.includes('--app={_INITIAL_PAGE}') || !chrome.includes('"Page.enable"') || !chrome.includes('"Network.enable"') || !chrome.includes('"Network.getAllCookies"')) fail('Chromium kiosk does not use the ordered CDP authentication path')
  if (!chrome.includes('--remote-debugging-pipe') || !chrome.includes('_PipeConnection') || !chrome.includes('_pipe_command') || !chrome.includes('\"stdin\": subprocess.PIPE') || !chrome.includes('\"stdout\": subprocess.PIPE') || chrome.includes('f"--remote-debugging-port={port}"')) fail('Chromium kiosk does not use a private DevTools pipe')
  if (!chrome.includes('_ensure_private_parent') || !chrome.includes('metadata = os.lstat(current)') || !chrome.includes('os.mkdir(current, mode=0o700)') || chrome.includes('os.makedirs(parent')) fail('Chromium kiosk does not validate profile parents without following links')
  if (!chrome.includes('_ALLOWED_EXTRA_ARGUMENTS = frozenset()') || !chrome.includes('if argument not in _ALLOWED_EXTRA_ARGUMENTS') || !chrome.includes('\"--disable-extensions\"') || chrome.includes('\"LD_LIBRARY_PATH\"')) fail('Chromium kiosk does not enforce its extra-argument and child-environment allowlists')
  const officialCookiePattern = '_BASE64URL_COOKIE_NAME = re.compile(r"^dsh-auth-[A-Za-z0-9_-]{43}$")'
  if (!chrome.includes(officialCookiePattern) || !chrome.includes('cookie_name not in names') || !chrome.includes('_official_cookie_name') || !chrome.includes('cookie_name != expected_name') || !chrome.includes('hashlib.sha256') || !chrome.includes('base64.urlsafe_b64encode') || !chrome.includes('not cookie_value.strip()') || !chrome.includes('cookie.get(\"httpOnly\") is not True') || !chrome.includes('cookie.get(\"sameSite\") != \"Strict\"') || !chrome.includes('domain.startswith(\".\")') || !chrome.includes('_canonical_host(domain) != host') || !chrome.includes('\"domain\" in attributes')) fail('Chromium kiosk does not require the official base64url Host cookie attributes')
  if (!chrome.includes('200 <= status < 300')) fail('Chromium kiosk does not require a successful Buddy response')
  if ((chrome.match(/subprocess\.Popen\(/g) ?? []).length !== 1) fail('Chromium kiosk launches more than one browser process')
  if (!chrome.includes('parsed.query in ("", expected.query)')) fail('Chromium kiosk rejects the token query on the root authentication response')
  if (chrome.includes('startswith("LC_")') || chrome.includes('**os.environ')) fail('Chromium kiosk copies an unallowlisted environment')
  if (!chrome.includes('if not os.path.isabs(raw):') || !chrome.includes('DSH_BUDDY_KIOSK_DATA must be an absolute path')) fail('Chromium kiosk accepts a relative explicit profile path')
  if (shell.includes('--dump-dom "$AUTH_URL"') || shell.includes('exec "$CHROME"')) fail('kiosk shell passes the authentication URL directly to Chromium')
  if (/\blog\([^)]*authenticateUrl/.test(host)) fail('Buddy runtime logs the authentication URL and may expose its token')
  ok('shell kiosk launcher delegates validation and keeps the token out of browser arguments or logs')
}

function cleanEnvironment(storeDirectory) {
  const config = join(storeDirectory, 'config')
  return {
    ...scrubSubprocessEnvironment(),
    XDG_CONFIG_HOME: config,
    npm_config_userconfig: join(config, 'npmrc'),
    npm_config_globalconfig: join(config, 'global.npmrc'),
    npm_config_registry: invalidRegistry,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    PNPM_STORE_DIR: storeDirectory,
  }
}

function checkSubprocessEnvironmentNegativeCases() {
  const source = {
    PATH: process.env.PATH ?? '',
    DISPLAY: ':0',
    SERVICE_KEY: 'secret-key',
    SERVICE_SECRET: 'secret',
    SERVICE_TOKEN: 'token',
    SERVICE_PASSWORD: 'password',
    SERVICE_CREDENTIAL: 'credential',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    AWS_PROFILE: 'default',
    AWS_SHARED_CREDENTIALS_FILE: '/tmp/credentials',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/application.json',
    NPM_CONFIG_USERCONFIG: '/tmp/.npmrc',
    PNPM_HOME: '/tmp/pnpm',
    GIT_CONFIG_GLOBAL: '/tmp/.gitconfig',
    NODE_PATH: '/tmp/node_modules',
    NODE_OPTIONS: '--require=/tmp/secret.js',
    XDG_CONFIG_DIRS: '/tmp/system-config',
    XDG_DATA_DIRS: '/tmp/system-data',
  }
  const environment = scrubSubprocessEnvironment(source)
  for (const name of ['SERVICE_KEY', 'SERVICE_SECRET', 'SERVICE_TOKEN', 'SERVICE_PASSWORD', 'SERVICE_CREDENTIAL', 'SSH_AUTH_SOCK', 'AWS_PROFILE', 'AWS_SHARED_CREDENTIALS_FILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'NPM_CONFIG_USERCONFIG', 'PNPM_HOME', 'GIT_CONFIG_GLOBAL', 'NODE_PATH', 'NODE_OPTIONS', 'XDG_CONFIG_DIRS', 'XDG_DATA_DIRS']) {
    if (name in environment) fail('scrubbed subprocess environment retained ' + name)
  }
  if (environment.PATH !== source.PATH || environment.DISPLAY !== source.DISPLAY) fail('scrubbed subprocess environment removed required display/runtime variables')
  const capture = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { encoding: 'utf8', env: environment })
  if (capture.status !== 0) fail('subprocess environment capture failed')
  const captured = parseJson(capture.stdout, 'subprocess environment capture')
  for (const name of ['SERVICE_KEY', 'SERVICE_SECRET', 'SERVICE_TOKEN', 'SERVICE_PASSWORD', 'SERVICE_CREDENTIAL', 'SSH_AUTH_SOCK', 'AWS_PROFILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'NPM_CONFIG_USERCONFIG', 'PNPM_HOME', 'GIT_CONFIG_GLOBAL', 'NODE_PATH', 'NODE_OPTIONS', 'XDG_CONFIG_DIRS', 'XDG_DATA_DIRS']) {
    if (name in captured) fail('captured subprocess environment retained ' + name)
  }
  const commandCapture = parseJson(command(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env: { ...source, SERVICE_SECRET: 'command-secret', npm_config_registry: invalidRegistry, npm_config_audit: 'false', npm_config_fund: 'false' } }), 'command environment capture')
  if ('SERVICE_SECRET' in commandCapture || 'NODE_OPTIONS' in commandCapture) fail('command wrapper bypassed subprocess environment scrubbing')
  const isolated = cleanEnvironment('/tmp/dsh-buddy-artifact-store')
  if (isolated.npm_config_registry !== invalidRegistry || isolated.PNPM_STORE_DIR !== '/tmp/dsh-buddy-artifact-store' || !isolated.npm_config_userconfig.startsWith('/tmp/dsh-buddy-artifact-store/')) fail('artifact subprocess environment did not set explicit invalid registry/store overrides')
  if ('NODE_PATH' in isolated || 'NODE_OPTIONS' in isolated) fail('artifact subprocess environment retained Node injection variables')
  ok('subprocess credential scrub and captured child environment checks passed')
}

function checkTemporaryCleanupNegativeCases() {
  let escapedRoot
  let survivingTarget
  let independentRoot
  let primaryError
  try {
    escapedRoot = mkdtempSync(join(tmpdir(), 'dsh-buddy-cleanup-escaped-'))
    survivingTarget = mkdtempSync(join(tmpdir(), 'dsh-buddy-cleanup-target-'))
    independentRoot = mkdtempSync(join(tmpdir(), 'dsh-buddy-cleanup-independent-'))
    symlinkSync(survivingTarget, join(escapedRoot, 'escape'))
    const failures = cleanupTemporaryRoots([[escapedRoot, 'escaped'], [independentRoot, 'independent']])
    if (failures.length === 0) fail('temporary cleanup accepted a member resolving outside its root')
    if (existsSync(independentRoot)) fail('temporary cleanup stopped after a failed root audit')
    if (!existsSync(survivingTarget)) fail('temporary cleanup followed an external member symlink')
    if (!existsSync(escapedRoot)) fail('temporary cleanup recursively removed a root after a failed member audit')
    const targetFailures = cleanupTemporaryRoots([[survivingTarget, 'target']])
    if (targetFailures.length !== 0) fail('temporary cleanup could not remove its audited target root')
    const primary = new Error('primary operation failure')
    const cleanup = new Error('cleanup failure')
    try {
      finishWithCleanup(primary, true, [cleanup], 'cleanup regression')
      fail('cleanup aggregation returned instead of preserving the primary error')
    } catch (error) {
      if (!(error instanceof AggregateError) || error.errors[0] !== primary || error.errors[1] !== cleanup || error.cause !== primary) fail('cleanup aggregation did not preserve primary and cleanup errors')
    }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    const cleanupFailures = []
    if (escapedRoot !== undefined) {
      try {
        rmSync(join(escapedRoot, 'escape'), { force: true })
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    try {
      cleanupFailures.push(...cleanupTemporaryRoots([[escapedRoot, 'escaped-final'], [survivingTarget, 'target-final'], [independentRoot, 'independent-final']].filter(([root]) => root !== undefined)))
    } catch (error) {
      cleanupFailures.push(error)
    }
    finishWithCleanup(primaryError, primaryError !== undefined, cleanupFailures, 'temporary cleanup regression')
  }
  ok('temporary cleanup audits lstat/realpath containment, attempts every root, and preserves primary errors')
}

function isPathWithin(root, candidate) {
  return candidate === root || candidate.startsWith(root + sep)
}

function auditTemporaryTree(root, label) {
  const temporaryDirectory = realpathSync(tmpdir())
  const rootPath = resolve(root)
  const rootMetadata = lstatSync(rootPath)
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) fail(label + ' temporary root is not a directory')
  const rootRealPath = realpathSync(rootPath)
  if (!isPathWithin(temporaryDirectory, rootRealPath)) fail(label + ' temporary root escaped the system temporary directory')
  const visitedRealPaths = new Set()
  const visit = (memberPath) => {
    const metadata = lstatSync(memberPath)
    let realPath
    try {
      realPath = realpathSync(memberPath)
    } catch (error) {
      if (metadata.isSymbolicLink() && error && error.code === 'ENOENT') {
        // A dangling link is removed later with unlinkSync, without following its target.
        return
      }
      throw error
    }
    if (!isPathWithin(rootRealPath, realPath)) fail(label + ' temporary member escaped its root: ' + memberPath)
    if (visitedRealPaths.has(realPath)) return
    visitedRealPaths.add(realPath)
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      for (const child of readdirSync(realPath)) visit(join(realPath, child))
    }
  }
  visit(rootPath)
}

function unlinkTemporaryLink(path, rootRealPath, temporaryDirectory, label) {
  const parentRealPath = realpathSync(dirname(path))
  if (!isPathWithin(temporaryDirectory, parentRealPath) || (rootRealPath !== undefined && !isPathWithin(rootRealPath, parentRealPath))) {
    throw new Error(label + ' temporary link parent escaped its allowed root: ' + path)
  }
  unlinkSync(join(parentRealPath, basename(path)))
}

function removeTemporaryTree(path, rootRealPath, temporaryDirectory, label, isRoot = false) {
  let metadata
  try {
    metadata = lstatSync(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') return
    throw error
  }
  if (metadata.isSymbolicLink()) {
    unlinkTemporaryLink(path, isRoot ? undefined : rootRealPath, temporaryDirectory, label)
    return
  }
  const parentRealPath = realpathSync(dirname(path))
  if (!isPathWithin(temporaryDirectory, parentRealPath) || (!isRoot && !isPathWithin(rootRealPath, parentRealPath))) {
    throw new Error(label + ' temporary member parent escaped its allowed root: ' + path)
  }
  const entryPath = join(parentRealPath, basename(path))
  metadata = lstatSync(entryPath)
  if (metadata.isSymbolicLink()) {
    unlinkTemporaryLink(entryPath, rootRealPath, temporaryDirectory, label)
    return
  }
  const realPath = realpathSync(entryPath)
  if (!isPathWithin(rootRealPath, realPath)) throw new Error(label + ' temporary member escaped its root: ' + path)
  if (!metadata.isDirectory()) {
    unlinkSync(entryPath)
    return
  }
  for (const child of readdirSync(realPath)) removeTemporaryTree(join(realPath, child), rootRealPath, temporaryDirectory, label)
  const finalMetadata = lstatSync(realPath)
  if (finalMetadata.isSymbolicLink()) {
    unlinkTemporaryLink(realPath, isRoot ? undefined : rootRealPath, temporaryDirectory, label)
    return
  }
  const finalRealPath = realpathSync(realPath)
  if (!isPathWithin(rootRealPath, finalRealPath)) throw new Error(label + ' temporary member escaped its root during cleanup: ' + path)
  if (!finalMetadata.isDirectory()) {
    unlinkSync(realPath)
    return
  }
  rmdirSync(finalRealPath)
}

function cleanupTemporaryRoot(root, label) {
  const failures = []
  const rootPath = resolve(root)
  let metadata
  try {
    metadata = lstatSync(rootPath)
  } catch (error) {
    if (error && error.code === 'ENOENT') return failures
    failures.push(error)
    return failures
  }
  let temporaryDirectory
  let temporaryPath
  try {
    temporaryPath = resolve(tmpdir())
    temporaryDirectory = realpathSync(temporaryPath)
  } catch (error) {
    failures.push(error)
    return failures
  }
  if (!isPathWithin(temporaryPath, rootPath)) {
    failures.push(new Error(label + ' temporary root is outside the system temporary directory'))
    return failures
  }
  let rootRealPath
  if (metadata.isSymbolicLink()) {
    try {
      rootRealPath = realpathSync(rootPath)
      if (!isPathWithin(temporaryDirectory, rootRealPath)) failures.push(new Error(label + ' temporary root link resolves outside the system temporary directory'))
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) failures.push(error)
    }
    try {
      unlinkTemporaryLink(rootPath, undefined, temporaryDirectory, label)
    } catch (error) {
      failures.push(error)
    }
    return failures
  }
  try {
    rootRealPath = realpathSync(rootPath)
    if (!isPathWithin(temporaryDirectory, rootRealPath)) failures.push(new Error(label + ' temporary root real path escaped the system temporary directory'))
    else {
      auditTemporaryTree(rootPath, label)
      removeTemporaryTree(rootPath, rootRealPath, temporaryDirectory, label, true)
    }
  } catch (error) {
    failures.push(error)
  }
  return failures
}

function cleanupTemporaryRoots(roots) {
  const failures = []
  for (const [root, label] of roots) {
    try {
      failures.push(...cleanupTemporaryRoot(root, label))
    } catch (error) {
      failures.push(error)
    }
  }
  return failures
}

function finishWithCleanup(primaryError, hasPrimaryError, cleanupFailures, label) {
  if (hasPrimaryError && cleanupFailures.length !== 0) throw new AggregateError([primaryError, ...cleanupFailures], label + ' and cleanup failed', { cause: primaryError })
  if (hasPrimaryError) throw primaryError
  if (cleanupFailures.length === 1) throw cleanupFailures[0]
  if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, label + ' cleanup failed')
}

function assertRegularFixture(path, label) {
  let metadata
  try {
    metadata = lstatSync(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') fail('fixture is missing: ' + label)
    throw error
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail('fixture must be a regular non-symlink file: ' + label)
}

function assertFixtureDirectory(path, label) {
  let metadata
  try {
    metadata = lstatSync(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') fail('fixture directory is missing: ' + label)
    throw error
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail('fixture directory must be a non-symlink directory: ' + label)
  const repositoryRoot = realpathSync(cwd)
  const fixturesRoot = realpathSync(join(cwd, 'fixtures'))
  const realPath = realpathSync(path)
  if (!isPathWithin(repositoryRoot, fixturesRoot) || !isPathWithin(fixturesRoot, realPath)) fail('fixture directory resolves outside the repository fixtures root: ' + label)
}

function checkFixtureShapeNegativeCases() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-buddy-fixture-shape-'))
  const outside = mkdtempSync(join(tmpdir(), 'dsh-buddy-fixture-outside-'))
  const regular = join(root, 'regular.tgz')
  const link = join(root, 'link.tgz')
  const directoryLink = join(root, 'directory-link')
  const parentLink = join(root, 'parent-link')
  const escapedDirectory = join(parentLink, 'nested')
  writeFileSync(regular, 'fixture')
  mkdirSync(join(outside, 'nested'))
  symlinkSync(regular, link)
  symlinkSync(root, directoryLink, 'dir')
  symlinkSync(outside, parentLink, 'dir')
  try {
    let linkRejected = false
    try {
      assertRegularFixture(link, 'link.tgz')
    } catch (error) {
      if (error instanceof Error && error.message.includes('regular non-symlink')) linkRejected = true
      else throw error
    }
    if (!linkRejected) fail('fixture validator accepted a symlink tarball')
    let directoryRejected = false
    try {
      assertFixtureDirectory(directoryLink, 'directory-link')
    } catch (error) {
      if (error instanceof Error && error.message.includes('non-symlink directory')) directoryRejected = true
      else throw error
    }
    if (!directoryRejected) fail('fixture validator accepted a symlink fixture directory')
    let escapeRejected = false
    try {
      assertFixtureDirectory(escapedDirectory, 'escaped-directory')
    } catch (error) {
      if (error instanceof Error && error.message.includes('resolves outside')) escapeRejected = true
      else throw error
    }
    if (!escapeRejected) fail('fixture validator accepted a directory escaping the repository fixtures root')
  } finally {
    rmSync(link, { force: true })
    rmSync(directoryLink, { force: true })
    rmSync(parentLink, { force: true })
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
  ok('fixture validator rejects symlink tarballs and directories')
}

function fixturePackagePath(record) {
  const path = join(cwd, 'fixtures', 'alpha1', record.file)
  assertRegularFixture(path, record.file)
  return path
}

function installedPackagePath(consumer, name) {
  const parts = name.split('/')
  return join(consumer, 'node_modules', ...parts)
}

function fixtureRecordForRange(records, name, range) {
  const candidates = [...records.values()].filter((record) => record.name === name && (range === null || satisfiesSemver(record.version, range)))
  if (candidates.length !== 1) fail('consumer cannot choose one fixture for ' + name + (range === null ? '' : ' (' + range + ')'))
  return candidates[0]
}

function consumerDirectDependencies(tarball, sourcePackage, records) {
  const dependencies = { [packageName]: 'file:' + tarball }
  const directRecords = new Map()
  const queue = []
  const addDirect = (record) => {
    if (directRecords.has(record.name)) return
    directRecords.set(record.name, record)
    queue.push(record)
  }
  for (const [name, range] of Object.entries(sourcePackage.peerDependencies ?? {})) {
    if (typeof range !== 'string') fail('source package.json has an invalid peer range for consumer ' + name)
    addDirect(fixtureRecordForRange(records, name, range))
  }
  addDirect(fixtureRecordForRange(records, '@deepseek-ai/dsh-client-modules', null))
  while (queue.length > 0) {
    const parentRecord = queue.shift()
    const manifest = fixtureManifests.get(packageKey(parentRecord.name, parentRecord.version))
    for (const [name, range] of Object.entries(manifest?.peerDependencies ?? {})) {
      if (typeof range !== 'string') fail('fixture peer dependency range is invalid for consumer ' + parentRecord.name + ' -> ' + name)
      const candidates = [...records.values()].filter((record) => record.name === name && satisfiesSemver(record.version, range))
      if (candidates.length === 1) addDirect(candidates[0])
      else if (candidates.length > 1) fail('consumer cannot choose one direct peer fixture for ' + parentRecord.name + ' -> ' + name)
    }
  }
  for (const record of directRecords.values()) dependencies[record.name] = 'file:' + fixturePackagePath(record)
  return dependencies
}

function scopedConsumerOverrides(sourcePackage, records) {
  const overrides = {}
  const addOverride = (parent, record) => {
    const key = parent + '>' + record.name
    const spec = 'file:' + fixturePackagePath(record)
    if (overrides[key] !== undefined && overrides[key] !== spec) fail('consumer has conflicting scoped overrides for ' + key)
    overrides[key] = spec
  }
  const edges = expectedProvenanceEdges(sourcePackage, records, fixtureManifests, fixtureRuntimeImports)
  for (const edge of edges) {
    if (!['dependencies', 'optionalDependencies', 'peerDependencies'].includes(edge.field)) continue
    const record = records.get(edge.child)
    if (!record) fail('consumer override target is not pinned: ' + edge.child)
    addOverride(edge.parent, record)
  }
  for (const parentRecord of records.values()) {
    const manifest = fixtureManifests.get(packageKey(parentRecord.name, parentRecord.version))
    const peers = manifest?.peerDependencies
    if (!isRecord(peers)) continue
    for (const [name, range] of Object.entries(peers)) {
      if (typeof range !== 'string') fail('fixture peer dependency range is invalid for ' + parentRecord.name + ' -> ' + name)
      const candidates = [...records.values()].filter((record) => record.name === name && satisfiesSemver(record.version, range))
      if (candidates.length === 1) addOverride(packageKey(parentRecord.name, parentRecord.version), candidates[0])
      else if (candidates.length > 1) fail('consumer cannot choose one scoped peer override for ' + packageKey(parentRecord.name, parentRecord.version) + ' -> ' + name)
    }
  }
  return overrides
}

function checkConsumer(tarball, provenance, sourcePackage) {
  let consumer
  let storeDirectory
  const temporaryRoots = []
  let primaryError
  let hasPrimaryError = false
  try {
    consumer = mkdtempSync(join(tmpdir(), 'dsh-buddy-consumer-'))
    temporaryRoots.push([consumer, 'consumer'])
    storeDirectory = mkdtempSync(join(tmpdir(), 'dsh-buddy-store-'))
    temporaryRoots.push([storeDirectory, 'store'])
    if (readdirSync(storeDirectory).length !== 0) fail('fresh pnpm store is not empty before install')
    const records = new Map(provenance.packages.map((record) => [packageKey(record.name, record.version), record]))
    const dependencies = consumerDirectDependencies(tarball, sourcePackage, records)
    const overrides = scopedConsumerOverrides(sourcePackage, records)
    if (Object.keys(dependencies).length >= records.size) fail('consumer dumped every fixture package as a direct dependency')
    if (Object.keys(dependencies).some((name) => name !== packageName && !records.values().some((record) => record.name === name))) fail('consumer direct dependency is not pinned to a fixture')
    const overridesAreVersionScoped = Object.keys(overrides).length > 0 && Object.keys(overrides).every((key) => {
      const separator = key.indexOf('>')
      if (separator <= 0) return false
      const parent = key.slice(0, separator)
      const versionSeparator = parent.lastIndexOf('@')
      const minimumSeparator = parent.startsWith('@') ? parent.indexOf('/') : -1
      return versionSeparator > minimumSeparator && versionSeparator < parent.length - 1
    })
    if (!overridesAreVersionScoped) fail('consumer overrides must be scoped parent@version>child selectors')
    const consumerPackage = {
      name: 'dsh-buddy-artifact-consumer',
      version: '1.0.0',
      private: true,
      type: 'module',
      dependencies,
      pnpm: { overrides },
    }
    writeFileSync(join(consumer, 'package.json'), JSON.stringify(consumerPackage, null, 2) + newline)
    const environment = cleanEnvironment(storeDirectory)
    command('pnpm', ['install', '--offline', '--ignore-scripts', '--config.auto-install-peers=false', '--store-dir', storeDirectory], { cwd: consumer, env: environment })
    const lock = readFileSync(join(consumer, 'pnpm-lock.yaml'), 'utf8')
    if (lock.includes('resolution: {directory:') || /\btype: directory\b/.test(lock) || /\blink:[^ ]/.test(lock)) fail('consumer lockfile contains a workspace/source link')
    const installed = installedPackagePath(consumer, packageName)
    if (!existsSync(installed)) fail('consumer did not install the packed package')
    for (const name of Object.keys(dependencies)) {
      const packagePath = installedPackagePath(consumer, name)
      if (!existsSync(packagePath)) fail('consumer did not install ' + name)
      const resolved = realpathSync(packagePath)
      if (!resolved.startsWith(consumer + sep) || resolved.startsWith(cwd + sep) || resolved.startsWith(join(cwd, 'fixtures') + sep)) fail('consumer package resolves outside its installed tree: ' + name)
    }
    const installedPackageJson = parseJson(readFileSync(join(realpathSync(installed), 'package.json'), 'utf8'), 'installed dsh-buddy package.json')
    if (installedPackageJson.name !== packageName || installedPackageJson.version !== packageVersion) fail('installed package manifest mismatch')
    checkNoDependencyAliases(installedPackageJson, 'installed dsh-buddy package.json')
    ok('regular package install succeeded with a fresh empty store, invalid registry, offline/no-audit/no-fund, scripts disabled, and clear NODE_PATH')

    const hostSmoke = [
      "const { Context } = await import('@deepseek-ai/cordis')",
      "const plugin = await import('dsh-buddy')",
      "const registeredRoutes = []",
      "const context = new Context()",
      "if (!Context.is(context)) throw new Error('Host smoke did not construct a Cordis Context')",
      "context.provide('webServer', { host: '127.0.0.1', port: 3082, register(route) { registeredRoutes.push(route); return () => {} } })",
      "context.provide('connection', { authenticatedUrl(origin) { return origin + '/?token=artifact-smoke' }, requestRejection() { return undefined }, authorizeIndex() { return true } })",
      "context.provide('sessions', { list() { return [] } })",
      "context.provide('agents', { list() { return [] } })",
      "context.provide('workspaceRegistry', { archivedSessionIds: [] })",
      "plugin.apply(context)",
      "await context.fiber.restart()",
      "if (registeredRoutes.length !== 6) throw new Error('Host apply did not register its routes')",
      "const navigateRoute = registeredRoutes.find((route) => route.kind === 'exact' && route.path === '/buddy/navigate')",
      "if (!navigateRoute) throw new Error('Packed navigate route missing')",
      "const routeRequest = { method: 'POST', url: '/buddy/navigate', headers: { host: '127.0.0.1:3082', 'content-type': 'text/plain' }, destroyed: false, destroy() { this.destroyed = true } }",
      "const routeResponse = { destroyed: false, writableEnded: false, headersSent: false, status: undefined, writeHead(status) { this.status = status; this.headersSent = true }, end() { this.writableEnded = true } }",
      "await navigateRoute.handler(routeRequest, routeResponse)",
      "if (routeResponse.status !== 415 || !routeRequest.destroyed) throw new Error('Packed navigate route smoke failed')",
    ].join(newline)
    command(process.execPath, ['--input-type=module', '-e', hostSmoke], { cwd: consumer, env: environment })
    ok('public Host import passed with NODE_PATH cleared')
    const clientSmoke = [
      'const bootstrapRegistrations = []',
      "const bootstrapTarget = { mode: 'queue', pendingQueue: [], load(record) { bootstrapRegistrations.push(record) } }",
      'globalThis.window = { __ModuleLoader__: bootstrapTarget }',
      "await import('@deepseek-ai/dsh-client-modules/client')",
      "await import('@deepseek-ai/dsh-client-connection/client')",
      "await import('@deepseek-ai/dsh-client-ui-session/client')",
      "const loaderRegistration = bootstrapRegistrations.find((record) => record.id === '@deepseek-ai/dsh-client-modules')",
      "if (!loaderRegistration) throw new Error('official ModuleLoader registration missing')",
      "const loaderExports = loaderRegistration.factory(() => { throw new Error('unexpected ModuleLoader dependency') })",
      "if (typeof loaderExports.ClientModuleSystem !== 'function') throw new Error('official ClientModuleSystem export missing')",
      "const target = { mode: 'queue', pendingQueue: [], load(record) { target.pendingQueue.push(record) } }",
      "globalThis.window.__ModuleLoader__ = target",
      "const system = new loaderExports.ClientModuleSystem({ manifest: { rev: 'smoke', modules: [{ id: 'dsh-buddy', url: 'dsh-buddy.js?rev=smoke', rev: 'smoke', inject: [], external: [], initialUrl: 'dsh-buddy.js?rev=smoke' }], plugins: [] }, staticModules: {}, registrationTarget: target, bootstrapModule: { id: '@deepseek-ai/dsh-client-modules', exports: loaderExports }, loadBundle: async (url) => { if (url !== 'dsh-buddy.js?rev=smoke') throw new Error('unexpected bundle URL ' + url); await import('dsh-buddy/client') } })",
      "const loaded = await system.import('dsh-buddy')",
      "if (!loaded || typeof loaded.apply !== 'function') throw new Error('client apply export missing')",
      "if (await system.import('dsh-buddy') !== loaded) throw new Error('ModuleLoader did not memoize materialization')",
      "if (!bootstrapRegistrations.some((record) => record.id === '@deepseek-ai/dsh-client-connection')) throw new Error('connection browser factory missing')",
      "if (!bootstrapRegistrations.some((record) => record.id === '@deepseek-ai/dsh-client-ui-session')) throw new Error('ui-session browser factory missing')",
    ].join(newline)
    command(process.execPath, ['--input-type=module', '-e', clientSmoke], { cwd: consumer, env: environment })
    ok('official browser factories and ModuleLoader execution passed')
  } catch (error) {
    primaryError = error
    hasPrimaryError = true
  } finally {
    let cleanupFailures
    try {
      cleanupFailures = cleanupTemporaryRoots(temporaryRoots)
    } catch (error) {
      cleanupFailures = [error]
    }
    finishWithCleanup(primaryError, hasPrimaryError, cleanupFailures, 'artifact consumer')
  }
}

let currentTarball
function main() {
  const sourcePackage = parseJson(readFileSync(join(cwd, 'package.json'), 'utf8'), 'source package.json')
  checkNoDependencyAliases(sourcePackage, 'source package.json')
  checkTarTextNegativeCases()
  checkTarEntriesNegativeCases()
  checkDependencyAliasNegativeCases()
  checkRuntimeImportScannerNegativeCases()
  checkPageClosureNegativeCases()
  checkFixtureShapeNegativeCases()
  checkSubprocessEnvironmentNegativeCases()
  checkTemporaryCleanupNegativeCases()
  checkAlpha1Fixtures(sourcePackage)
  checkKioskLauncher()
  const provenance = parseJson(readFileSync(join(cwd, 'fixtures', 'alpha1', 'provenance.json'), 'utf8'), 'alpha1 fixture provenance')
  command('pnpm', ['run', 'build'])
  ok('build succeeded')
  let packDirectory
  const temporaryRoots = []
  let primaryError
  let hasPrimaryError = false
  try {
    packDirectory = mkdtempSync(join(tmpdir(), 'dsh-buddy-pack-'))
    temporaryRoots.push([packDirectory, 'pack'])
    const packOutput = command('pnpm', ['pack', '--pack-destination', packDirectory, '--json'])
    const parsed = parseJson(packOutput, 'pnpm pack output')
    const record = Array.isArray(parsed) ? (parsed.length === 1 ? parsed[0] : undefined) : parsed
    if (!isRecord(record) || typeof record.filename !== 'string') fail('pnpm pack JSON did not contain exactly one filename')
    currentTarball = resolve(record.filename)
    if (!currentTarball.startsWith(resolve(packDirectory) + sep)) fail('pnpm pack escaped its destination')
    const packed = readdirSync(packDirectory).filter((entry) => entry.endsWith('.tgz'))
    if (packed.length !== 1 || resolve(packDirectory, packed[0]) !== currentTarball) fail('expected exactly one real tarball in pack destination')
    const metadata = lstatSync(currentTarball)
    if (metadata.isSymbolicLink() || !metadata.isFile()) fail('packed tarball must be a regular non-symlink file')
    if (metadata.size < 1024) fail('packed tarball is unexpectedly small')
    const gzipHeader = readFileSync(currentTarball)
    if (gzipHeader[0] !== 0x1f || gzipHeader[1] !== 0x8b) fail('packed artifact is not gzip')
    ok('real tarball consumed (' + String(metadata.size) + ' bytes)')
    const entries = tarEntries(currentTarball)
    checkPackReport(record, entries)
    const packageJson = parseJson(tarText(currentTarball, packageEntry('package.json')), 'packed package.json')
    if (packageJson.name !== packageName || packageJson.version !== packageVersion) fail('packed package identity mismatch')
    checkNoDependencyAliases(packageJson, 'packed package.json')
    checkPackageExportsAndFiles(entries, packageJson)
    checkForbiddenEntries(entries)
    checkPageClosure(entries)
    checkStaticClosure(entries, packageJson)
    checkConsumer(currentTarball, provenance, sourcePackage)
  } catch (error) {
    primaryError = error
    hasPrimaryError = true
  } finally {
    let cleanupFailures
    try {
      cleanupFailures = cleanupTemporaryRoots(temporaryRoots)
    } catch (error) {
      cleanupFailures = [error]
    }
    finishWithCleanup(primaryError, hasPrimaryError, cleanupFailures, 'artifact pack')
  }
}

function errorMessage(error) {
  if (error instanceof AggregateError) return [error.message, ...error.errors.map(errorMessage)].join(newline)
  return error instanceof Error ? error.message : String(error)
}

try {
  main()
  console.log('[artifact-gate] ALL CHECKS PASSED')
} catch (error) {
  console.error(errorMessage(error))
  process.exitCode = 1
}
