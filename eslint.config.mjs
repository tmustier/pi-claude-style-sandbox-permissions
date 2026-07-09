import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const nodeLanguageOptions = {
  ecmaVersion: "latest",
  sourceType: "module",
  globals: globals.node,
};

const sharedRules = {
  "no-restricted-syntax": [
    "error",
    {
      selector: "FunctionDeclaration[id.name='isRecord'], VariableDeclarator[id.name='isRecord']",
      message:
        "Do not define `isRecord`. Generic record guards usually mean an unknown boundary leaked inward. Parse external input into a named DTO/domain type first; if a guard remains, give it a domain-specific name and type.",
    },
  ],
};

export default tseslint.config(
  {
    ignores: ["node_modules/**", "coverage/**", "dist/**", "*.tgz"],
  },
  {
    files: ["**/*.{js,mjs}"],
    extends: [js.configs.recommended],
    languageOptions: nodeLanguageOptions,
    rules: {
      ...sharedRules,
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: nodeLanguageOptions,
    rules: {
      ...sharedRules,
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-unused-vars": "off",
    },
  },
);
