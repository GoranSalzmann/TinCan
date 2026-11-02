// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import en from "../../core/i18n/en.json";
import { fileIcon, fileKind, fileKindLabelKey, type FileKind } from "./fileKind.js";
import { formatDuration, formatSize } from "./media.js";

describe("fileKind", () => {
  it.each([
    ["image/png", "a.png", "image"],
    ["video/mp4", "a.mp4", "video"],
    ["audio/mpeg", "a.mp3", "audio"],
    ["application/pdf", "report.pdf", "pdf"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx", "document"],
    ["application/msword", "a.doc", "document"],
    ["application/vnd.ms-excel", "a.xls", "spreadsheet"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "a.xlsx", "spreadsheet"],
    ["application/vnd.ms-powerpoint", "a.ppt", "presentation"],
    ["application/zip", "a.zip", "archive"],
    ["application/gzip", "a.tar.gz", "archive"],
    ["application/json", "a.json", "code"],
    ["text/plain", "notes.txt", "text"],
    ["text/csv", "table.csv", "spreadsheet"],
    ["model/gltf-binary", "a.glb", "model"],
    ["font/woff2", "a.woff2", "font"],
  ] as [string, string, FileKind][])("%s %s → %s", (type, name, kind) => {
    expect(fileKind(type, name)).toBe(kind);
  });

  it("uses the extension when the type says nothing", () => {
    expect(fileKind("application/octet-stream", "slides.pptx")).toBe("presentation");
    expect(fileKind("application/octet-stream", "Archive.ZIP")).toBe("archive");
    expect(fileKind("application/octet-stream", "page.html")).toBe("code");
    expect(fileKind("application/octet-stream", "main.rs")).toBe("code");
    expect(fileKind("application/octet-stream", "README.md")).toBe("text");
    expect(fileKind("application/octet-stream", "model.stl")).toBe("model");
    expect(fileKind("application/octet-stream", "face.ttf")).toBe("font");
    expect(fileKind("", "clip.mov")).toBe("video");
  });

  it("lets a specific extension refine a general text type", () => {
    expect(fileKind("text/plain", "script.py")).toBe("code");
    expect(fileKind("text/plain", "notes.md")).toBe("text");
    expect(fileKind("text/plain", "a.csv")).toBe("spreadsheet");
  });

  it("falls back to a plain file", () => {
    expect(fileKind("application/octet-stream", "mystery")).toBe("other");
    expect(fileKind("application/x-something", "thing.zzz")).toBe("other");
  });

  it("has an icon and a visible, translated word for every kind", () => {
    const kinds: FileKind[] = [
      "image",
      "video",
      "audio",
      "pdf",
      "document",
      "spreadsheet",
      "presentation",
      "archive",
      "code",
      "text",
      "model",
      "font",
      "other",
    ];
    for (const k of kinds) {
      expect(fileIcon(k), k).toBeTruthy();
      expect(en[fileKindLabelKey(k)], k).toBeTruthy();
    }
  });
});

describe("formatting", () => {
  it("formats sizes and durations", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatDuration(83)).toBe("1:23");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(5)).toBe("0:05");
    expect(formatDuration(NaN)).toBe("");
  });
});
