import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { ignores: ["main.js", "node_modules/**", "version-bump.mjs", "scripts/**", ".test-build/**"] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*", "esbuild.config.*"],
        },
      },
    },
    rules: {
      // "Linkwarden" is a third-party brand name (see SPEC.md); "Obsidian"
      // is kept from the rule's defaults since a custom brands list replaces them.
      "obsidianmd/ui/sentence-case": ["warn", { brands: ["Obsidian", "Linkwarden"] }],
    },
  },
  {
    // Build script runs in Node.js only; it is not shipped in the plugin bundle.
    files: ["esbuild.config.mjs"],
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
    },
  },
  {
    // Pure DOM module, also exercised under jsdom by scripts/test-readable.mjs —
    // it must not depend on Obsidian's createEl prototype extensions.
    files: ["src/readable.ts"],
    rules: {
      "obsidianmd/prefer-create-el": "off",
    },
  },
]);
