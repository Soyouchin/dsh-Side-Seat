/**
 * Packaging integrity.
 *
 * The bundle is installed from a git checkout or a packed tarball, so a file
 * that `package.json` promises but the repository does not carry is a broken
 * install for everyone else — and a local `link:` install hides it, because the
 * whole directory is present regardless of `files`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

const exists = async (relative) => {
  try {
    await access(join(root, relative))
    return true
  } catch {
    return false
  }
}

test('every export target exists and is a file the bundle ships', async () => {
  const targets = Object.values(manifest.exports ?? {})
  assert.ok(targets.length > 0)
  for (const target of targets) {
    assert.equal(typeof target, 'string', 'exports must point at a path')
    const normalized = target.replace(/^\.\//, '')

    if (normalized.includes('*')) {
      // A wildcard export must still resolve to at least one shipped file.
      const [dir, pattern] = [normalized.slice(0, normalized.indexOf('*')).replace(/\/$/, ''),
        normalized.slice(normalized.indexOf('*') + 1)]
      const entries = await readdir(join(root, dir)).catch(() => [])
      const suffix = pattern.replace(/^\*/, '')
      const hits = entries.filter(name => name.endsWith(suffix))
      assert.ok(hits.length > 0, `${target} matches no file in ${dir}`)
      continue
    }

    assert.ok(await exists(normalized), `missing export target ${target}`)
    // A runtime file must be inside `files`, or a packed install loses it.
    const shipped = manifest.files.some(pattern => {
      if (pattern === normalized) return true
      if (pattern.endsWith('/*.js')) return normalized.startsWith(pattern.slice(0, -4)) && normalized.endsWith('.js')
      if (pattern.endsWith('/*.json')) return normalized.startsWith(pattern.slice(0, -5)) && normalized.endsWith('.json')
      return false
    })
    assert.ok(shipped, `${target} is exported but not listed in "files"`)
  }
})

test('the bundle and client declarations point at real files', async () => {
  assert.ok(await exists(manifest.dsh.bundle.patch), 'the bundle patch must exist')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(await exists('client.js'), 'the client entry must exist')
  assert.match(manifest.exports['./client'], /client\.js$/)

  const patch = await readFile(join(root, manifest.dsh.bundle.patch), 'utf8')
  assert.match(patch, new RegExp(`name:\\s*'?${manifest.name}'?`), 'the patch must insert this package')
})

test('the client module registers under the package name', async () => {
  // The browser module id must equal the package name, or the loader and the
  // installed bundle disagree about who owns the module.
  const client = await readFile(join(root, 'client.js'), 'utf8')
  assert.match(client, new RegExp(`id:\\s*'${manifest.name}'`), 'client.js must load under the package name')
})

test('the manifest advertises the repository fields a public repo needs', async () => {
  assert.ok(manifest.description && manifest.description.length > 20)
  assert.ok(manifest.license, 'a public repo needs a license field')
  assert.ok(await exists('LICENSE'), 'the license field must have a matching file')
  assert.ok(manifest.repository?.url, 'fill in repository.url before publishing')
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0)
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0)
})

test('the icon is a valid, self-contained SVG', async () => {
  const svg = await readFile(join(root, 'icon.svg'), 'utf8')
  assert.match(svg, /^<svg[\s>]/)
  assert.match(svg, /viewBox="0 0 /)
  assert.ok(!/href="http/.test(svg), 'the icon must not reference external resources')
})
