import js from "@eslint/js";
import globals from "globals";
import security from "eslint-plugin-security";

export default [
  js.configs.recommended,
  security.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
      sourceType: "module",
    },
  },
];