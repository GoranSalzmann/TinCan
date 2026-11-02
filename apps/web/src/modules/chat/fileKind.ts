// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Box,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
  Type,
  type LucideIcon,
} from "lucide-react";

/** What a file is, for its icon and the type word beside it (23 §6). */
export type FileKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "archive"
  | "code"
  | "text"
  | "model"
  | "font"
  | "other";

const EXTENSIONS: Record<Exclude<FileKind, "other">, string> = {
  image: "png jpg jpeg gif webp avif bmp tif tiff svg ico heic heif",
  video: "mp4 m4v mov webm mkv avi wmv mpg mpeg ogv 3gp",
  audio: "mp3 m4a aac wav flac ogg oga opus weba wma aiff mid midi",
  pdf: "pdf",
  document: "doc docx odt rtf pages dot dotx wpd",
  spreadsheet: "xls xlsx ods numbers xlsm csv tsv",
  presentation: "ppt pptx odp key pps ppsx",
  archive: "zip rar 7z tar gz tgz bz2 xz zst cab iso dmg",
  code: "js mjs cjs ts tsx jsx py rb go rs java kt swift c h cc cpp hpp cs php sh bash ps1 bat sql lua pl r css scss less html htm xml json jsonl yml yaml toml ini sh vue svelte",
  text: "txt text md markdown rst log tex srt vtt diff patch nfo",
  model: "stl obj fbx gltf glb 3ds blend dae step stp",
  font: "ttf otf woff woff2 eot",
};

const BY_EXTENSION = new Map<string, FileKind>();
// Later entries must not override earlier ones: csv is a spreadsheet, json is code.
for (const [kind, list] of Object.entries(EXTENSIONS) as [FileKind, string][])
  for (const ext of list.split(" ")) if (!BY_EXTENSION.has(ext)) BY_EXTENSION.set(ext, kind);

const BY_TYPE: [RegExp, FileKind][] = [
  [/^image\//, "image"],
  [/^video\//, "video"],
  [/^audio\//, "audio"],
  [/^application\/pdf$/, "pdf"],
  [/(msword|wordprocessingml|opendocument\.text|rtf)/, "document"],
  [/(ms-excel|spreadsheetml|opendocument\.spreadsheet|text\/csv|text\/tab-separated)/, "spreadsheet"],
  [/(ms-powerpoint|presentationml|opendocument\.presentation)/, "presentation"],
  [/(zip|x-rar|x-7z|x-tar|gzip|x-bzip|x-xz|zstd)/, "archive"],
  [/^model\//, "model"],
  [/^font\/|application\/(x-font|font-)/, "font"],
  [/(json|javascript|typescript|xml|x-sh|x-python|html|x-yaml|yaml|sql)/, "code"],
  [/^text\//, "text"],
];

/**
 * The kind of a file. The content type wins when it says something specific; uploads are often plain
 * `application/octet-stream` (and html/xml are stored that way on purpose), so the extension decides then.
 */
export function fileKind(contentType: string, filename: string): FileKind {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  const byExt = BY_EXTENSION.get(ext);
  if (type && type !== "application/octet-stream") {
    // An extension is more precise than a general text/* or xml type (a .md or .py file is text/plain).
    const byType = BY_TYPE.find(([re]) => re.test(type))?.[1];
    if (byType && !(byExt && (byType === "text" || byType === "code"))) return byType;
  }
  return byExt ?? "other";
}

const ICONS: Record<FileKind, LucideIcon> = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  archive: FileArchive,
  code: FileCode,
  text: FileText,
  model: Box,
  font: Type,
  other: FileIcon,
};

export const fileIcon = (kind: FileKind): LucideIcon => ICONS[kind];

/** i18n key of the visible type word shown beside the icon, so the kind is never carried by the icon alone. */
export const fileKindLabelKey = (kind: FileKind) => `file.kind.${kind}` as const;
