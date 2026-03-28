/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { applyAcceptedDiff } from './gemini-chat-panel.js';

vi.mock('vscode', () => ({
  workspace: {
    fs: {
      writeFile: vi.fn(),
    },
  },
  Uri: {
    file: vi.fn((filePath: string) => ({ fsPath: filePath })),
  },
}));

describe('applyAcceptedDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the accepted diff content back to the workspace', async () => {
    await applyAcceptedDiff({
      method: 'ide/diffAccepted',
      params: {
        filePath: '/tmp/example.txt',
        content: 'updated content',
      },
    });

    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
      { fsPath: '/tmp/example.txt' },
      expect.any(Uint8Array),
    );
  });

  it('ignores non-accepted notifications', async () => {
    await applyAcceptedDiff({
      method: 'ide/diffRejected',
      params: {
        filePath: '/tmp/example.txt',
        content: 'updated content',
      },
    });

    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });
});
