/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference types="vitest" />
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@google\/gemini-cli-core$/,
        replacement: path.resolve(__dirname, '../core/src/index.ts'),
      },
      {
        find: /^@google\/gemini-cli-sdk$/,
        replacement: path.resolve(__dirname, '../sdk/src/index.ts'),
      },
      {
        find: /^@google\/gemini-cli-core\/src\/ide\/detect-ide\.js$/,
        replacement: path.resolve(__dirname, '../core/src/ide/detect-ide.ts'),
      },
      {
        find: /^@google\/gemini-cli-core\/src\/ide\/types\.js$/,
        replacement: path.resolve(__dirname, '../core/src/ide/types.ts'),
      },
      {
        find: /^@google\/gemini-cli-core\/src\/ide\/constants\.js$/,
        replacement: path.resolve(__dirname, '../core/src/ide/constants.ts'),
      },
    ],
  },
  test: {
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    globals: true,
    reporters: ['default', 'junit'],
    silent: true,
    outputFile: {
      junit: 'junit.xml',
    },
    setupFiles: ['./test-setup.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    server: {
      deps: {
        inline: [/@google\/gemini-cli-core/],
      },
    },
  },
});
