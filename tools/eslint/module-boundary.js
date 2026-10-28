// SPDX-License-Identifier: AGPL-3.0-or-later
// 04 §11 / 05 §2: feature modules never reach into each other. Inside apps/server/src/modules/<a>/,
// an import that resolves into modules/<b>/ (b ≠ a) is an error unless it is a type-only import of
// <b>'s `api` file, the ModuleApi that module chose to export.
import path from "node:path";

const MODULE_DIR = /\/modules\/([^/]+)\/(.*)$/;

function moduleOf(file) {
  const m = MODULE_DIR.exec(file.replaceAll("\\", "/"));
  return m ? { name: m[1], rest: m[2] } : null;
}

const isApiFile = (rest) => /^api(\.[cm]?[jt]sx?)?$/.test(rest) || /^api\/index(\.[cm]?[jt]sx?)?$/.test(rest);

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      crossModule:
        'Module "{{from}}" must not import from module "{{to}}" ({{spec}}). Use events, a shared port, or a type-only import of its api file (04 §5).',
      valueApi:
        'Import of "{{to}}"\'s api file must be type-only (`import type`): modules share types, not code (04 §5).',
    },
  },
  create(context) {
    const self = moduleOf(path.resolve(context.filename));
    if (!self) return {};

    function check(node, spec, typeOnly) {
      if (typeof spec !== "string" || !spec.startsWith(".")) return;
      const target = moduleOf(path.resolve(path.dirname(context.filename), spec));
      if (!target || target.name === self.name) return;
      if (!isApiFile(target.rest)) {
        context.report({ node, messageId: "crossModule", data: { from: self.name, to: target.name, spec } });
      } else if (!typeOnly) {
        context.report({ node, messageId: "valueApi", data: { to: target.name } });
      }
    }

    return {
      ImportDeclaration(node) {
        const typeOnly =
          node.importKind === "type" ||
          (node.specifiers.length > 0 && node.specifiers.every((s) => s.importKind === "type"));
        check(node, node.source.value, typeOnly);
      },
      ExportAllDeclaration(node) {
        check(node, node.source.value, node.exportKind === "type");
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source.value, node.exportKind === "type");
      },
      ImportExpression(node) {
        if (node.source.type === "Literal") check(node, node.source.value, false);
      },
    };
  },
};
