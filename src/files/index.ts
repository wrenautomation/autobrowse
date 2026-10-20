/**
 * `@wrenautomation/autobrowse/files`: the sealed file store (designs/2026-10-20-files.md) for
 * other projects. `fileStore(dir, cipher)` is the sealed dir; `memoryFiles()` is for tests.
 */
export {
  backedUpFiles,
  bucketFiles,
  describeFile,
  FILE_KINDS,
  FILE_MAX_BYTES,
  FILE_TYPES,
  type FileBucket,
  type FileKind,
  type FileLine,
  type FileMeta,
  type FileRecord,
  type FileSets,
  type FileStore,
  type FileType,
  fileLine,
  fileOf,
  filePayload,
  fileRef,
  fileSchema,
  fileStore,
  filesInSets,
  memoryFiles,
  PAPER_IDS,
  PAPER_TYPES,
  sniffType,
} from "./store.js";
export { TEXT_MAX_CHARS, textOf } from "./text.js";
