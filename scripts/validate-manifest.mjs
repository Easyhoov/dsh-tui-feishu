import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const spec = resolve(root, '..', '..', 'dsh-ecosystem-spec')
// Community v0.15 moved the plugin schema into the pinned dsh-std submodule.
const stdManifest = resolve(spec, 'vendor', 'dsh-std', 'packages', 'manifest')
const load = async path => JSON.parse(await readFile(path, 'utf8'))
const [manifest, schema, registry, permissionRegistry] = await Promise.all([
  load(resolve(root, 'dsh-plugin.json')),
  load(resolve(stdManifest, 'schema', 'dsh-plugin-0.15.schema.json')),
  load(resolve(spec, 'registry', 'registry-0.15.json')),
  load(resolve(spec, 'registry', 'permissions-0.1.json')),
])

function resolveRef(rootSchema, ref) {
  assert.ok(ref.startsWith('#/'), `unsupported external ref: ${ref}`)
  return ref.slice(2).split('/').reduce((value, key) => value[key.replace(/~1/g, '/').replace(/~0/g, '~')], rootSchema)
}

function check(value, node, rootSchema, where = '$') {
  if (node.$ref) return check(value, resolveRef(rootSchema, node.$ref), rootSchema, where)
  if (node.oneOf) {
    let matches = 0
    for (const variant of node.oneOf) {
      try { check(value, variant, rootSchema, where); matches += 1 } catch {}
    }
    assert.equal(matches, 1, `${where}: expected one oneOf match`)
    return
  }
  if (node.const !== undefined) assert.deepEqual(value, node.const, `${where}: const mismatch`)
  if (node.enum) assert.ok(node.enum.includes(value), `${where}: not in enum`)
  if (node.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${where}: expected object`)
    for (const key of node.required ?? []) assert.ok(key in value, `${where}.${key}: required`)
    if (node.additionalProperties === false) {
      for (const key of Object.keys(value)) assert.ok(node.properties?.[key], `${where}.${key}: additional property`)
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      if (key in value) check(value[key], child, rootSchema, `${where}.${key}`)
    }
  } else if (node.type === 'array') {
    assert.ok(Array.isArray(value), `${where}: expected array`)
    if (node.minItems !== undefined) assert.ok(value.length >= node.minItems, `${where}: too few items`)
    if (node.maxItems !== undefined) assert.ok(value.length <= node.maxItems, `${where}: too many items`)
    value.forEach((item, index) => check(item, node.items, rootSchema, `${where}[${index}]`))
    if (node.uniqueItems) assert.equal(new Set(value.map(JSON.stringify)).size, value.length, `${where}: duplicate items`)
  } else if (node.type === 'string') {
    assert.equal(typeof value, 'string', `${where}: expected string`)
    if (node.minLength !== undefined) assert.ok(value.length >= node.minLength, `${where}: too short`)
    if (node.maxLength !== undefined) assert.ok(value.length <= node.maxLength, `${where}: too long`)
    if (node.pattern) assert.match(value, new RegExp(node.pattern), `${where}: pattern mismatch`)
    if (node.format === 'uri') assert.match(value, /^[A-Za-z][A-Za-z0-9+.-]*:\/\//, `${where}: invalid URI`)
  } else if (node.type === 'boolean') {
    assert.equal(typeof value, 'boolean', `${where}: expected boolean`)
  }
}

check(manifest, schema, schema)
assert.ok(registry.facetApiVersions.includes(manifest.facets.host.apiVersion), 'unregistered host facet apiVersion')
// Registry v0.15 splits contract coordinates across std imports, profile
// definitions, and private extensions - a requires/contributes reference may
// resolve in any of the three.
const registryEntries = [...registry.imports, ...registry.definitions, ...registry.extensions]
const contracts = new Map(registryEntries.map(entry => [`${entry.coordinates.apiVersion}#${entry.coordinates.kind}`, entry]))
for (const ref of manifest.requires.contracts) {
  assert.ok(contracts.has(`${ref.apiVersion}#${ref.kind}`), `unknown contract ${ref.apiVersion}#${ref.kind}`)
  if (ref.optional) assert.ok(ref.fallback, `optional contract has no fallback: ${ref.apiVersion}#${ref.kind}`)
}
const permissions = new Set(permissionRegistry.permissions.map(permission => permission.name))
for (const permission of manifest.permissions) assert.ok(permissions.has(permission.name), `unknown permission ${permission.name}`)
assert.equal(new Set(manifest.contributes.commands.map(command => command.id)).size, manifest.contributes.commands.length, 'duplicate command id')
console.log('dsh-plugin.json passes Community v0.15 schema and registry checks')
