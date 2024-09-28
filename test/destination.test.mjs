/**
 * `--out`, and the three independent ways a destination destroys a file nobody
 * named.
 *
 * Each hole gets its own test because no one of them catches the others:
 *
 *   1. A symbolic link AT the destination -- `realpath` resolves it, and
 *      resolving is the dangerous act, so it is refused on sight by `lstat`.
 *   2. A symbolically linked PARENT -- an escape from a root. This tool has no
 *      root, so there is nothing to escape from and the link is followed,
 *      exactly as `cp` and shell redirection follow it. That is asserted here as
 *      behaviour, because documenting a confinement the code does not perform
 *      reads as coverage and is worse than silence.
 *   3. A HARD LINK to an input -- no target to resolve and no shared path, so
 *      `realpath` and string comparison both call it a different file. Only
 *      device plus inode sees that it is the same file.
 *
 * The allowed cases are pinned too: a guard that refuses everything passes every
 * data-loss test while making the tool useless.
 */

import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { link, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { WRITE_NO_FOLLOW } from '../src/destination.mjs'
import { cleanup, filler, makeTree, resultsDocument, runCli, section } from './helpers.mjs'

const DOCUMENT = resultsDocument([
  {
    id: 'call-1',
    tool: 'some.tool',
    status: 'succeeded',
    sections: [
      section('id', 'identifier', 'abc'),
      { ...section('body', 'evidence', filler(200), { pointer: 'runs/body.txt' }), priority: 1 },
    ],
  },
])

async function fixture(t) {
  const root = await makeTree({ 'results.json': DOCUMENT })
  t.after(() => cleanup(root))
  return root
}

const run = (root, out) => runCli([
  '--results', join(root, 'results.json'), '--budget-chars', '4000', '--out', out, '--json',
])

test('hole 1: a symbolic link at the destination is refused, and its target is untouched', async (t) => {
  const root = await fixture(t)
  const victim = join(root, 'precious.txt')
  await writeFile(victim, 'keep me')
  await symlink(victim, join(root, 'out.json'))

  const result = run(root, join(root, 'out.json'))

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '', 'a refused destination is a configuration error: stdout stays empty')
  assert.match(result.stderr, /symbolic link/)
  assert.equal(await readFile(victim, 'utf8'), 'keep me')
})

test('hole 1b: a symbolic link pointing at a path that does not exist yet is refused too', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, 'outside'))
  await symlink(join(root, 'outside', 'created.json'), join(root, 'out.json'))

  const result = run(root, join(root, 'out.json'))

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  await assert.rejects(readFile(join(root, 'outside', 'created.json')), { code: 'ENOENT' })
})

test('hole 2: this tool has no root, so a symbolically linked parent is followed and says so', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, 'real'))
  await symlink(join(root, 'real'), join(root, 'link'))

  const result = run(root, join(root, 'link', 'summary.json'))

  assert.equal(result.status, 0)
  const written = JSON.parse(await readFile(join(root, 'real', 'summary.json'), 'utf8'))
  assert.equal(written.verdict, 'succeeded')

  const help = runCli(['--help'])
  assert.match(help.stdout, /NOT confined to any root/)
  assert.match(help.stdout, /symbolically linked PARENT[\s\S]*?is followed/)
})

test('hole 3: a hard link to an input is refused, and the input survives', async (t) => {
  const root = await fixture(t)
  const destination = join(root, 'out.json')
  await link(join(root, 'results.json'), destination)

  const result = run(root, destination)

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /same file as an input/)
  assert.equal(await readFile(join(root, 'results.json'), 'utf8'), DOCUMENT)
})

test('the destination may not be the input by name either', async (t) => {
  const root = await fixture(t)
  const result = run(root, join(root, 'results.json'))

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.equal(await readFile(join(root, 'results.json'), 'utf8'), DOCUMENT)
})

test('allowed: a destination that does not exist yet is created, carrying the summary', async (t) => {
  const root = await fixture(t)
  const result = run(root, join(root, 'summary.json'))

  assert.equal(result.status, 0)
  assert.match(result.stderr, /wrote a \d+ character summary/)
  const written = JSON.parse(await readFile(join(root, 'summary.json'), 'utf8'))
  assert.equal(written.schemaVersion, '1')
  assert.equal(written.verdict, 'succeeded')
  assert.equal(written.text.length, written.usedChars)
})

test('allowed: an existing regular file that is not an input is overwritten', async (t) => {
  const root = await fixture(t)
  const destination = join(root, 'summary.json')
  await writeFile(destination, 'stale')

  const result = run(root, destination)

  assert.equal(result.status, 0)
  assert.equal(JSON.parse(await readFile(destination, 'utf8')).verdict, 'succeeded')
})

test('a destination that is a directory is refused', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, 'summaries'))

  const result = run(root, join(root, 'summaries'))

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /not a regular file/)
})

test('a destination whose parent directory does not exist is refused, not created', async (t) => {
  const root = await fixture(t)
  const result = run(root, join(root, 'missing', 'summary.json'))

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /directory that does not exist/)
})

test('nothing is written when no summary was produced', async (t) => {
  const root = await fixture(t)
  const destination = join(root, 'summary.json')
  const result = runCli([
    '--results', join(root, 'results.json'), '--budget-chars', '20', '--out', destination, '--json',
  ])

  assert.equal(result.status, 1)
  assert.match(result.stderr, /No summary was produced, so nothing was written/)
  await assert.rejects(readFile(destination), { code: 'ENOENT' })
})

test('the open flag is the second, independent refusal of a link at the destination', async (t) => {
  // assertWritableDestination refuses a link on sight; this is what closes the
  // window between that check and the open. The claim was a comment on a
  // constant until now: nothing failed when O_NOFOLLOW was taken out of it.
  const root = await fixture(t)
  const victim = join(root, 'precious.txt')
  await writeFile(victim, 'keep me')
  const planted = join(root, 'planted.json')
  await symlink(victim, planted)

  await assert.rejects(
    writeFile(planted, 'through the link', { encoding: 'utf8', flag: WRITE_NO_FOLLOW }),
    (error) => error.code === 'ELOOP' || error.code === 'EMLINK',
  )
  assert.equal(await readFile(victim, 'utf8'), 'keep me')

  // Without the flag the same open follows the link and destroys the target,
  // which is what makes the flag the thing doing the work.
  await writeFile(planted, 'through the link', { encoding: 'utf8', flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC })
  assert.equal(await readFile(victim, 'utf8'), 'through the link')
})
