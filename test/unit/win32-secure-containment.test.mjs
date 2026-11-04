import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendPrivateFile,
  ensurePrivateDirectory,
  publishPrivateGenerationDirectory,
  readPrivateDirectoryNames,
  readPrivateFileText,
  setSecureAtomicBeforeRenameHookForTests,
  writePrivateFileAtomic,
  writePrivateFileNoReplace,
} from "../../.tmp/unit/secure-atomic-write.js";

// lstat reports a junction as a symbolic link, so canonicalization refuses it
// as "not a directory" before any open, exactly like a POSIX symlink.
const LINK_REFUSED = /not a directory|symlink or junction|changed during write/;

// Native Windows has no O_NOFOLLOW. These cases use junctions and hard links,
// which an unprivileged account can create (file/dir symlinks need Developer
// Mode), to exercise the win32 containment branch directly.
const onlyWin32 = { skip: process.platform !== "win32" && "win32-only containment branch" };
const project = () => mkdtemp(join(tmpdir(), "pi-win32-containment-"));

test("win32: secure writers reject a junction ancestor for every publication mode", onlyWin32, async () => {
  const root = await project();
  const outside = await project();
  const junction = join(root, "junction");
  try {
    await symlink(outside, junction, "junction");
    await assert.rejects(() => appendPrivateFile(join(junction, "append"), "x"), LINK_REFUSED);
    await assert.rejects(() => writePrivateFileAtomic(join(junction, "atomic"), "x"), LINK_REFUSED);
    await assert.rejects(() => writePrivateFileNoReplace(join(junction, "no-replace"), "x"), LINK_REFUSED);
    await assert.rejects(() => publishPrivateGenerationDirectory(join(junction, "generation"), "owner", "x"), LINK_REFUSED);
    await assert.rejects(() => writePrivateFileAtomic(join(junction, "nested", "deep"), "x"), LINK_REFUSED);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("win32: secure readers reject a junction ancestor or final directory", onlyWin32, async () => {
  const root = await project();
  const outside = await project();
  const junction = join(root, "junction");
  try {
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(outside, junction, "junction");
    await assert.rejects(() => readPrivateFileText(join(junction, "secret.txt")), LINK_REFUSED);
    await assert.rejects(() => readPrivateDirectoryNames(junction), LINK_REFUSED);
    await assert.rejects(() => ensurePrivateDirectory(junction), LINK_REFUSED);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("win32: private reader rejects a hard-linked file", onlyWin32, async () => {
  const root = await project();
  try {
    const original = join(root, "original.json");
    await writePrivateFileAtomic(original, "{}");
    await link(original, join(root, "alias.json"));
    await assert.rejects(() => readPrivateFileText(original), /hard-linked/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("win32: private writers and readers round-trip in a plain directory", onlyWin32, async () => {
  const root = await project();
  try {
    const dir = join(root, "state", "nested");
    await ensurePrivateDirectory(dir);

    const atomic = join(dir, "value.json");
    await writePrivateFileAtomic(atomic, "first");
    await writePrivateFileAtomic(atomic, "second");
    assert.equal(await readPrivateFileText(atomic), "second");

    const log = join(dir, "log.txt");
    await appendPrivateFile(log, "a");
    await appendPrivateFile(log, "b");
    assert.equal(await readFile(log, "utf8"), "ab");

    const once = join(dir, "once.json");
    await writePrivateFileNoReplace(once, "1");
    await assert.rejects(() => writePrivateFileNoReplace(once, "2"));
    assert.equal(await readFile(once, "utf8"), "1");

    const generation = join(dir, "generation");
    await publishPrivateGenerationDirectory(generation, "owner", "me");
    assert.equal(await readFile(join(generation, "owner"), "utf8"), "me");
    await assert.rejects(() => publishPrivateGenerationDirectory(generation, "owner", "other"));

    const names = await readPrivateDirectoryNames(dir);
    assert.deepEqual(names.filter((name) => !name.endsWith(".tmp")).sort(), ["generation", "log.txt", "once.json", "value.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("win32: junction under a created path is refused, not followed", onlyWin32, async () => {
  const root = await project();
  const outside = await project();
  try {
    await mkdir(join(root, "a"));
    await symlink(outside, join(root, "a", "b"), "junction");
    await assert.rejects(() => ensurePrivateDirectory(join(root, "a", "b", "c")), LINK_REFUSED);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("win32: parent swapped for a junction after validation is caught by handle identity", onlyWin32, async () => {
  const root = await project();
  const outside = await project();
  const parent = join(root, "parent");
  try {
    await ensurePrivateDirectory(parent);
    // Swap the already-opened parent for a junction right before the commit.
    // The held handle still names the original directory, so the bigint
    // identity check must refuse to publish through the junction.
    setSecureAtomicBeforeRenameHookForTests(async () => {
      await rename(parent, join(root, "parent-moved"));
      await symlink(outside, parent, "junction");
    });
    await assert.rejects(() => writePrivateFileAtomic(join(parent, "value.json"), "x"), /changed during write/);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    setSecureAtomicBeforeRenameHookForTests(undefined);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
