/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { TextEncoder } from 'node:util';
import {
  Storage,
  GeminiEventType,
  type ServerGeminiStreamEvent,
} from '@google/gemini-cli-core';
import { GeminiCliAgent, type GeminiCliSession } from '@google/gemini-cli-sdk';
import type { OpenFilesManager } from './open-files-manager.js';
import type { DiffManager } from './diff-manager.js';

type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatEntry {
  id: string;
  role: Role;
  text: string;
  kind?: 'thought';
  title?: string;
}

export interface SessionSummary {
  sessionId: string;
  lastUpdated: string;
  title: string;
}

interface PanelState {
  workspaceRoot: string;
  sessionId?: string;
  busy: boolean;
  status: string;
  entries: ChatEntry[];
  sessions: SessionSummary[];
}

interface DiffPreview {
  filePath: string;
  newContent: string;
  originalContent?: string;
}

interface DiffAcceptedParams {
  filePath: string;
  content: string;
}

interface ConversationRecordLike {
  sessionId?: string;
  messages?: Array<{ type?: string; content?: unknown }>;
}

interface ViewMessage {
  type:
    | 'ready'
    | 'sendPrompt'
    | 'newSession'
    | 'resumeLatest'
    | 'cancel'
    | 'refreshSessions';
  prompt?: string;
}

interface HostMessage {
  type:
    | 'state'
    | 'append'
    | 'replace'
    | 'sessions'
    | 'error'
    | 'session-start'
    | 'diff-preview';
  state?: PanelState;
  entry?: ChatEntry;
  sessions?: SessionSummary[];
  message?: string;
  diff?: DiffPreview;
}

const textEncoder = new TextEncoder();
const MAX_RECENT_SESSIONS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function id(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (isRecord(part)) {
          const record = part;
          if (typeof record.text === 'string') return record.text;
          if (typeof record.thought === 'string') return record.thought;
        }
        return '';
      })
      .join('');
  }
  if (isRecord(content)) {
    const record = content;
    if (typeof record.text === 'string') return record.text;
    return JSON.stringify(content, null, 2);
  }
  return '';
}

function buildInstructions(openFiles: OpenFilesManager): string {
  const files = openFiles.state.workspaceState?.openFiles ?? [];
  if (files.length === 0) return 'Open files: none.';
  return [
    'Open files:',
    ...files.map((file) => {
      const cursor = file.cursor
        ? `:${file.cursor.line}:${file.cursor.character}`
        : '';
      const selected = file.selectedText
        ? `\nSelected text:\n${file.selectedText}`
        : '';
      return `${file.path}${cursor}${selected}`;
    }),
  ].join('\n');
}

function parseDiffPreview(value: unknown): DiffPreview | undefined {
  if (!isRecord(value)) return undefined;
  const record = value;
  if (
    typeof record.fileName !== 'string' ||
    typeof record.newContent !== 'string'
  ) {
    return undefined;
  }
  return {
    filePath:
      typeof record.filePath === 'string' ? record.filePath : record.fileName,
    newContent: record.newContent,
    originalContent:
      typeof record.originalContent === 'string'
        ? record.originalContent
        : undefined,
  };
}

function isDiffAcceptedParams(value: unknown): value is DiffAcceptedParams {
  return (
    isRecord(value) &&
    typeof value.filePath === 'string' &&
    typeof value.content === 'string'
  );
}

async function loadSessionHistory(
  storage: Storage,
  filePath: string,
): Promise<ChatEntry[]> {
  const record =
    await storage.loadProjectTempFile<ConversationRecordLike>(filePath);
  const entries: ChatEntry[] = [];
  for (const message of record?.messages ?? []) {
    const text = contentToText(message.content).trim();
    if (!text) continue;
    const role: Role =
      message.type === 'gemini'
        ? 'assistant'
        : message.type === 'developer'
          ? 'system'
          : 'user';
    entries.push({ id: id(role), role, text });
  }
  return entries;
}

export class GeminiSessionController {
  private readonly storage: Storage;
  private readonly agent: GeminiCliAgent;
  private session: GeminiCliSession | undefined;
  private abortController: AbortController | undefined;
  private state: PanelState;

  constructor(
    private readonly workspaceRoot: string,
    private readonly openFiles: OpenFilesManager,
    private readonly diffManager: DiffManager,
    private readonly postMessage: (message: HostMessage) => void,
    private readonly log: (message: string) => void,
  ) {
    this.storage = new Storage(workspaceRoot);
    this.agent = new GeminiCliAgent({
      cwd: workspaceRoot,
      instructions: () =>
        [
          'You are Gemini CLI running inside a VS Code panel.',
          'Be concise and practical.',
          buildInstructions(openFiles),
        ].join('\n\n'),
    });
    this.state = {
      workspaceRoot,
      busy: false,
      status: 'Idle',
      entries: [],
      sessions: [],
    };
  }

  async initialize(): Promise<void> {
    await this.storage.initialize();
    await this.refreshSessions();
  }

  getState(): PanelState {
    return {
      ...this.state,
      entries: [...this.state.entries],
      sessions: [...this.state.sessions],
    };
  }

  async refreshSessions(): Promise<void> {
    await this.storage.initialize();
    const files = await this.storage.listProjectChatFiles();
    const summaries: SessionSummary[] = [];
    for (const file of files.slice(0, MAX_RECENT_SESSIONS)) {
      try {
        const record =
          await this.storage.loadProjectTempFile<ConversationRecordLike>(
            file.filePath,
          );
        const sessionId = record?.sessionId;
        if (!sessionId) continue;
        const firstMessage = record?.messages?.find(
          (message) => message.type === 'user',
        );
        summaries.push({
          sessionId,
          lastUpdated: file.lastUpdated,
          title:
            contentToText(firstMessage?.content).trim() ||
            sessionId.slice(0, 8),
        });
      } catch (error) {
        this.log(
          `Failed to inspect session ${file.filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.state = { ...this.state, sessions: summaries };
    this.postMessage({ type: 'sessions', sessions: summaries });
    this.postMessage({ type: 'state', state: this.getState() });
  }

  async startNewSession(): Promise<void> {
    await this.initialize();
    this.session = this.agent.session();
    this.state = {
      ...this.state,
      sessionId: this.session.id,
      busy: false,
      status: 'New session ready',
      entries: [],
    };
    this.postMessage({
      type: 'session-start',
      message: `Started session ${this.session.id.slice(0, 8)}`,
    });
    this.postMessage({ type: 'state', state: this.getState() });
  }

  async resumeLatestSession(): Promise<void> {
    await this.initialize();
    const files = await this.storage.listProjectChatFiles();
    if (files.length === 0) {
      this.state = { ...this.state, status: 'No previous sessions found' };
      this.postMessage({
        type: 'error',
        message: 'No previous sessions found.',
      });
      this.postMessage({ type: 'state', state: this.getState() });
      return;
    }

    const record =
      await this.storage.loadProjectTempFile<ConversationRecordLike>(
        files[0].filePath,
      );
    const sessionId = record?.sessionId;
    if (!sessionId)
      throw new Error(`Could not read session id from ${files[0].filePath}`);

    this.session = await this.agent.resumeSession(sessionId);
    this.state = {
      ...this.state,
      sessionId,
      busy: false,
      status: `Resumed session ${sessionId.slice(0, 8)}`,
      entries: await loadSessionHistory(this.storage, files[0].filePath),
    };
    this.postMessage({
      type: 'session-start',
      message: `Resumed session ${sessionId.slice(0, 8)}`,
    });
    this.postMessage({ type: 'state', state: this.getState() });
  }

  cancelActivePrompt(): void {
    this.abortController?.abort();
    this.abortController = undefined;
    this.state = { ...this.state, busy: false, status: 'Prompt cancelled' };
    this.postMessage({ type: 'state', state: this.getState() });
  }

  async sendPrompt(prompt: string): Promise<void> {
    try {
      if (!this.session) await this.startNewSession();
      if (!this.session) throw new Error('Gemini session is not available.');

      const text = prompt.trim();
      if (!text) return;

      const userEntry: ChatEntry = { id: id('user'), role: 'user', text };
      const assistantEntry: ChatEntry = {
        id: id('assistant'),
        role: 'assistant',
        text: '',
      };
      this.state = {
        ...this.state,
        busy: true,
        status: 'Generating response...',
        entries: [...this.state.entries, userEntry, assistantEntry],
      };
      this.abortController = new AbortController();
      this.postMessage({ type: 'append', entry: userEntry });
      this.postMessage({ type: 'append', entry: assistantEntry });
      this.postMessage({ type: 'state', state: this.getState() });

      const stream = this.session.sendStream(text, this.abortController.signal);
      for await (const event of stream) {
        this.handleEvent(event, assistantEntry.id);
      }
      this.state = { ...this.state, busy: false, status: 'Ready' };
      this.postMessage({ type: 'state', state: this.getState() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorEntry: ChatEntry = {
        id: id('error'),
        role: 'system',
        text: `Error: ${message}`,
      };
      this.state = {
        ...this.state,
        busy: false,
        status: message,
        entries: [...this.state.entries, errorEntry],
      };
      this.postMessage({ type: 'append', entry: errorEntry });
      this.postMessage({ type: 'error', message });
      this.postMessage({ type: 'state', state: this.getState() });
    } finally {
      this.abortController = undefined;
    }
  }

  private handleEvent(
    event: ServerGeminiStreamEvent,
    assistantEntryId: string,
  ): void {
    switch (event.type) {
      case GeminiEventType.Content: {
        const current = this.state.entries.find(
          (entry) => entry.id === assistantEntryId,
        );
        const next = `${current?.text ?? ''}${event.value}`;
        this.state.entries = this.state.entries.map((entry) =>
          entry.id === assistantEntryId ? { ...entry, text: next } : entry,
        );
        this.postMessage({
          type: 'replace',
          entry: { id: assistantEntryId, role: 'assistant', text: next },
        });
        break;
      }
      case GeminiEventType.Thought: {
        const entry: ChatEntry = {
          id: id('thought'),
          role: 'system',
          kind: 'thought',
          title: event.value.subject?.trim() || 'Thinking',
          text: event.value.description.trim(),
        };
        this.state = { ...this.state, entries: [...this.state.entries, entry] };
        this.postMessage({ type: 'append', entry });
        break;
      }
      case GeminiEventType.ToolCallRequest: {
        const entry: ChatEntry = {
          id: id('tool'),
          role: 'tool',
          text: `Tool request: ${event.value.name}\n${JSON.stringify(event.value.args, null, 2)}`,
        };
        this.state = { ...this.state, entries: [...this.state.entries, entry] };
        this.postMessage({ type: 'append', entry });
        break;
      }
      case GeminiEventType.ToolCallResponse: {
        const text =
          event.value.error?.message ||
          contentToText(event.value.responseParts).trim() ||
          'Tool completed.';
        const entry: ChatEntry = { id: id('tool'), role: 'tool', text };
        this.state = { ...this.state, entries: [...this.state.entries, entry] };
        this.postMessage({ type: 'append', entry });

        const diffPreview = parseDiffPreview(event.value.resultDisplay);
        if (diffPreview) {
          this.diffManager
            .showDiff(diffPreview.filePath, diffPreview.newContent)
            .catch((error) => {
              this.log(
                `Failed to show diff: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
          this.postMessage({ type: 'diff-preview', diff: diffPreview });
        }
        break;
      }
      case GeminiEventType.AgentExecutionStopped: {
        const entry: ChatEntry = {
          id: id('system'),
          role: 'system',
          text: event.value.systemMessage?.trim() || event.value.reason,
        };
        this.state = {
          ...this.state,
          busy: false,
          status: entry.text,
          entries: [...this.state.entries, entry],
        };
        this.postMessage({ type: 'append', entry });
        this.postMessage({ type: 'state', state: this.getState() });
        break;
      }
      case GeminiEventType.AgentExecutionBlocked: {
        const entry: ChatEntry = {
          id: id('system'),
          role: 'system',
          text: `Agent execution blocked: ${event.value.systemMessage?.trim() || event.value.reason}`,
        };
        this.state = { ...this.state, entries: [...this.state.entries, entry] };
        this.postMessage({ type: 'append', entry });
        break;
      }
      case GeminiEventType.LoopDetected: {
        const entry: ChatEntry = {
          id: id('system'),
          role: 'system',
          text: 'Loop detected, stopping execution.',
        };
        this.state = { ...this.state, entries: [...this.state.entries, entry] };
        this.postMessage({ type: 'append', entry });
        break;
      }
      case GeminiEventType.MaxSessionTurns: {
        const entry: ChatEntry = {
          id: id('system'),
          role: 'system',
          text: 'Maximum session turns reached.',
        };
        this.state = { ...this.state, entries: [...this.state.entries, entry] };
        this.postMessage({ type: 'append', entry });
        break;
      }
      case GeminiEventType.Error: {
        const entry: ChatEntry = {
          id: id('system'),
          role: 'system',
          text: `Error: ${event.value.error instanceof Error ? event.value.error.message : String(event.value.error)}`,
        };
        this.state = { ...this.state, entries: [...this.state.entries, entry] };
        this.postMessage({ type: 'append', entry });
        break;
      }
      case GeminiEventType.Finished:
      case GeminiEventType.UserCancelled:
        this.state = { ...this.state, busy: false };
        this.postMessage({ type: 'state', state: this.getState() });
        break;
      default:
        break;
    }
  }
}

export class GeminiChatPanel {
  private static currentPanel: GeminiChatPanel | undefined;

  static async createOrShow(
    context: vscode.ExtensionContext,
    workspaceRoot: string,
    openFiles: OpenFilesManager,
    diffManager: DiffManager,
    log: (message: string) => void,
  ): Promise<GeminiChatPanel> {
    if (GeminiChatPanel.currentPanel) {
      if (GeminiChatPanel.currentPanel.workspaceRoot === workspaceRoot) {
        GeminiChatPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
        return GeminiChatPanel.currentPanel;
      }
      GeminiChatPanel.currentPanel.panel.dispose();
    }

    const panel = vscode.window.createWebviewPanel(
      'geminiCliPanel',
      'Gemini CLI',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    const created = new GeminiChatPanel(
      context,
      panel,
      workspaceRoot,
      openFiles,
      diffManager,
      log,
    );
    GeminiChatPanel.currentPanel = created;
    return created;
  }

  private readonly controller: GeminiSessionController;
  private readonly log: (message: string) => void;
  private readonly _workspaceRoot: string;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
    workspaceRoot: string,
    openFiles: OpenFilesManager,
    diffManager: DiffManager,
    log: (message: string) => void,
  ) {
    this._workspaceRoot = workspaceRoot;
    this.controller = new GeminiSessionController(
      workspaceRoot,
      openFiles,
      diffManager,
      (message) => this.panel.webview.postMessage(message),
      log,
    );
    this.log = log;

    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.webview.onDidReceiveMessage(
      (message: ViewMessage) => {
        void this.handleMessage(message).catch((error) => {
          const messageText =
            error instanceof Error ? error.message : String(error);
          this.panel.webview.postMessage({
            type: 'error',
            message: messageText,
          });
        });
      },
      undefined,
      context.subscriptions,
    );
    this.panel.onDidDispose(
      () => this.dispose(),
      undefined,
      context.subscriptions,
    );
    void this.initialize().catch((error) => {
      this.log(
        `Failed to initialize Gemini panel: ${error instanceof Error ? error.message : String(error)}`,
      );
      void this.panel.webview.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  dispose(): void {
    this.controller.cancelActivePrompt();
    if (GeminiChatPanel.currentPanel === this) {
      GeminiChatPanel.currentPanel = undefined;
    }
  }

  get workspaceRoot(): string {
    return this._workspaceRoot;
  }

  private async initialize(): Promise<void> {
    await this.controller.initialize();
    this.panel.webview.postMessage({
      type: 'state',
      state: this.controller.getState(),
    });
  }

  private async handleMessage(message: ViewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
      case 'refreshSessions':
        await this.controller.refreshSessions();
        break;
      case 'newSession':
        await this.controller.startNewSession();
        break;
      case 'resumeLatest':
        await this.controller.resumeLatestSession();
        break;
      case 'sendPrompt':
        await this.controller.sendPrompt(message.prompt ?? '');
        break;
      case 'cancel':
        this.controller.cancelActivePrompt();
        break;
      default:
        break;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = id('nonce');
    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <style>
          body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); }
          .wrap { display: grid; grid-template-rows: auto 1fr auto; height: 100vh; }
          header, footer { border-color: var(--vscode-widget-border); }
          header { padding: 12px; border-bottom: 1px solid var(--vscode-widget-border); }
          footer { padding: 12px; border-top: 1px solid var(--vscode-widget-border); }
          .toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
          button { border: 0; border-radius: 6px; padding: 8px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
          button.secondary { background: transparent; color: var(--vscode-editor-foreground); border: 1px solid var(--vscode-widget-border); }
          #transcript { overflow: auto; padding: 12px; }
          .entry { white-space: pre-wrap; padding: 10px 12px; margin-bottom: 10px; border-radius: 8px; border: 1px solid var(--vscode-widget-border); }
          .user { border-left: 4px solid var(--vscode-charts-blue); }
          .assistant { border-left: 4px solid var(--vscode-charts-green); }
          .tool { border-left: 4px solid var(--vscode-charts-orange); }
          .system { border-left: 4px solid var(--vscode-charts-purple); color: var(--vscode-descriptionForeground); }
          textarea { width: 100%; min-height: 90px; resize: vertical; box-sizing: border-box; border-radius: 8px; padding: 10px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
          .status { margin-top: 8px; color: var(--vscode-descriptionForeground); font-size: 12px; }
          .sessions { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
          .session { padding: 6px 10px; border: 1px solid var(--vscode-widget-border); border-radius: 999px; font-size: 12px; color: var(--vscode-descriptionForeground); }
        </style>
      </head>
      <body>
        <div class="wrap">
          <header>
            <div><strong>Gemini CLI</strong></div>
            <div id="status" class="status">Loading...</div>
            <div class="toolbar">
              <button id="newSession">New Session</button>
              <button id="resumeLatest" class="secondary">Resume Latest</button>
              <button id="refreshSessions" class="secondary">Refresh Sessions</button>
              <button id="cancelPrompt" class="secondary">Cancel</button>
            </div>
            <div id="sessions" class="sessions"></div>
          </header>
          <main id="transcript"></main>
          <footer>
            <textarea id="prompt" placeholder="Ask Gemini to inspect, explain, or edit the workspace..."></textarea>
            <div class="toolbar">
              <button id="sendPrompt">Send</button>
            </div>
          </footer>
        </div>
        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          const transcript = document.getElementById('transcript');
          const status = document.getElementById('status');
          const sessions = document.getElementById('sessions');
          const prompt = document.getElementById('prompt');

          function entryNode(entry) {
            if (entry.kind === 'thought') {
              const details = document.createElement('details');
              details.className = 'entry thought';
              details.dataset.entryId = entry.id;
              details.open = false;
              const summary = document.createElement('summary');
              summary.textContent = entry.title || 'Thinking';
              const body = document.createElement('div');
              body.className = 'thought-body';
              body.textContent = entry.text || '';
              details.appendChild(summary);
              details.appendChild(body);
              return details;
            }
            const node = document.createElement('div');
            node.className = 'entry ' + entry.role;
            node.dataset.entryId = entry.id;
            node.textContent = entry.text;
            return node;
          }

          function renderState(state) {
            status.textContent = state.status + (state.busy ? ' · Busy' : ' · Idle') + (state.sessionId ? ' · ' + state.sessionId.slice(0, 8) : '');
            transcript.innerHTML = '';
            for (const entry of state.entries || []) {
              transcript.appendChild(entryNode(entry));
            }
            renderSessions(state.sessions || []);
          }

          function renderSessions(list) {
            sessions.innerHTML = '';
            if (!list.length) {
              const empty = document.createElement('div');
              empty.className = 'session';
              empty.textContent = 'No recent sessions';
              sessions.appendChild(empty);
              return;
            }
            for (const session of list) {
              const chip = document.createElement('div');
              chip.className = 'session';
              chip.textContent = session.title + ' · ' + session.sessionId.slice(0, 8);
              sessions.appendChild(chip);
            }
          }

          function appendEntry(entry) {
            transcript.appendChild(entryNode(entry));
            transcript.scrollTop = transcript.scrollHeight;
          }

          window.addEventListener('message', (event) => {
            const message = event.data;
            if (!message) return;
            switch (message.type) {
              case 'state':
                renderState(message.state);
                break;
              case 'append':
              case 'replace': {
                const existing = transcript.querySelector('[data-entry-id="' + message.entry.id + '"]');
                if (existing) {
                  existing.textContent = message.entry.text;
                } else {
                  appendEntry(message.entry);
                }
                break;
              }
              case 'sessions':
                renderSessions(message.sessions || []);
                break;
              case 'error':
              case 'session-start':
                if (message.message) status.textContent = message.message;
                break;
              case 'diff-preview':
                appendEntry({ id: 'diff-' + Date.now(), role: 'system', text: 'Diff ready for ' + message.diff.filePath });
                break;
            }
          });

          document.getElementById('newSession').addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
          document.getElementById('resumeLatest').addEventListener('click', () => vscode.postMessage({ type: 'resumeLatest' }));
          document.getElementById('refreshSessions').addEventListener('click', () => vscode.postMessage({ type: 'refreshSessions' }));
          document.getElementById('cancelPrompt').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
          document.getElementById('sendPrompt').addEventListener('click', () => {
            vscode.postMessage({ type: 'sendPrompt', prompt: prompt.value });
            prompt.value = '';
            prompt.focus();
          });
          prompt.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              vscode.postMessage({ type: 'sendPrompt', prompt: prompt.value });
              prompt.value = '';
            }
          });

          vscode.postMessage({ type: 'ready' });
        </script>
      </body>
      </html>`;
  }
}

export class GeminiChatSidebarViewProvider
  implements vscode.WebviewViewProvider
{
  private controller: GeminiSessionController | undefined;
  private webviewView: vscode.WebviewView | undefined;
  private workspaceRoot: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly openFiles: OpenFilesManager,
    private readonly diffManager: DiffManager,
    private readonly log: (message: string) => void,
    workspaceRoot: string,
  ) {
    this.workspaceRoot = workspaceRoot;
  }

  show(workspaceRoot: string): void {
    this.workspaceRoot = workspaceRoot;
    void vscode.commands.executeCommand(
      'workbench.view.extension.geminiCliSidebar',
    );
    if (this.webviewView) {
      void this.initialize(this.webviewView).catch((error) => {
        this.log(
          `Failed to refresh Gemini sidebar: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(
      (message: ViewMessage) => {
        void this.handleMessage(message).catch((error) => {
          const messageText =
            error instanceof Error ? error.message : String(error);
          webviewView.webview.postMessage({
            type: 'error',
            message: messageText,
          });
        });
      },
      undefined,
      this.context.subscriptions,
    );
    webviewView.onDidDispose(
      () => this.dispose(),
      undefined,
      this.context.subscriptions,
    );
    void this.initialize(webviewView).catch((error) => {
      this.log(
        `Failed to initialize Gemini sidebar: ${error instanceof Error ? error.message : String(error)}`,
      );
      void webviewView.webview.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  dispose(): void {
    this.controller?.cancelActivePrompt();
    this.webviewView = undefined;
    this.controller = undefined;
  }

  private async initialize(webviewView: vscode.WebviewView): Promise<void> {
    if (
      !this.controller ||
      this.controller.getState().workspaceRoot !== this.workspaceRoot
    ) {
      this.controller?.cancelActivePrompt();
      this.controller = new GeminiSessionController(
        this.workspaceRoot,
        this.openFiles,
        this.diffManager,
        (message) => webviewView.webview.postMessage(message),
        this.log,
      );
    }

    await this.controller.initialize();
    webviewView.webview.postMessage({
      type: 'state',
      state: this.controller.getState(),
    });
  }

  private async handleMessage(message: ViewMessage): Promise<void> {
    if (!this.controller || !this.webviewView) {
      return;
    }
    switch (message.type) {
      case 'ready':
      case 'refreshSessions':
        await this.controller.refreshSessions();
        break;
      case 'newSession':
        await this.controller.startNewSession();
        break;
      case 'resumeLatest':
        await this.controller.resumeLatestSession();
        break;
      case 'sendPrompt':
        await this.controller.sendPrompt(message.prompt ?? '');
        break;
      case 'cancel':
        this.controller.cancelActivePrompt();
        break;
      default:
        break;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = id('nonce');
    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <style>
          body { margin: 0; height: 100%; font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
          .wrap { display: grid; grid-template-rows: auto 1fr auto; height: 100%; min-height: 100%; }
          header, footer { border-color: var(--vscode-widget-border); }
          header { padding: 12px; border-bottom: 1px solid var(--vscode-widget-border); }
          footer { padding: 12px; border-top: 1px solid var(--vscode-widget-border); }
          .toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
          button { border: 0; border-radius: 6px; padding: 8px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
          button.secondary { background: transparent; color: var(--vscode-editor-foreground); border: 1px solid var(--vscode-widget-border); }
          #transcript { overflow: auto; padding: 12px; }
          .entry { white-space: pre-wrap; padding: 10px 12px; margin-bottom: 10px; border-radius: 8px; border: 1px solid var(--vscode-widget-border); }
          .user { border-left: 4px solid var(--vscode-charts-blue); }
          .assistant { border-left: 4px solid var(--vscode-charts-green); }
          .tool { border-left: 4px solid var(--vscode-charts-orange); }
          .system { border-left: 4px solid var(--vscode-charts-purple); color: var(--vscode-descriptionForeground); }
          details.entry.thought { padding: 0; overflow: hidden; }
          details.entry.thought > summary { cursor: pointer; list-style: none; padding: 10px 12px; border-left: 4px solid var(--vscode-charts-purple); color: var(--vscode-editor-foreground); }
          details.entry.thought > summary::-webkit-details-marker { display: none; }
          .thought-body { padding: 0 12px 12px; color: var(--vscode-descriptionForeground); white-space: pre-wrap; }
          textarea { width: 100%; min-height: 90px; resize: vertical; box-sizing: border-box; border-radius: 8px; padding: 10px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
          .status { margin-top: 8px; color: var(--vscode-descriptionForeground); font-size: 12px; }
          .sessions { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
          .session { padding: 6px 10px; border: 1px solid var(--vscode-widget-border); border-radius: 999px; font-size: 12px; color: var(--vscode-descriptionForeground); }
        </style>
      </head>
      <body>
        <div class="wrap">
          <header>
            <div><strong>Gemini CLI</strong></div>
            <div id="status" class="status">Loading...</div>
            <div class="toolbar">
              <button id="newSession">New Session</button>
              <button id="resumeLatest" class="secondary">Resume Latest</button>
              <button id="refreshSessions" class="secondary">Refresh Sessions</button>
              <button id="cancelPrompt" class="secondary">Cancel</button>
            </div>
            <div id="sessions" class="sessions"></div>
          </header>
          <main id="transcript"></main>
          <footer>
            <textarea id="prompt" placeholder="Ask Gemini to inspect, explain, or edit the workspace..."></textarea>
            <div class="toolbar">
              <button id="sendPrompt">Send</button>
            </div>
          </footer>
        </div>
        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          const transcript = document.getElementById('transcript');
          const status = document.getElementById('status');
          const sessions = document.getElementById('sessions');
          const prompt = document.getElementById('prompt');

          function entryNode(entry) {
            const node = document.createElement('div');
            node.className = 'entry ' + entry.role;
            node.dataset.entryId = entry.id;
            node.textContent = entry.text;
            return node;
          }

          function renderState(state) {
            status.textContent = state.status + (state.busy ? ' · Busy' : ' · Idle') + (state.sessionId ? ' · ' + state.sessionId.slice(0, 8) : '');
            transcript.innerHTML = '';
            for (const entry of state.entries || []) {
              transcript.appendChild(entryNode(entry));
            }
            renderSessions(state.sessions || []);
          }

          function renderSessions(list) {
            sessions.innerHTML = '';
            if (!list.length) {
              const empty = document.createElement('div');
              empty.className = 'session';
              empty.textContent = 'No recent sessions';
              sessions.appendChild(empty);
              return;
            }
            for (const session of list) {
              const chip = document.createElement('div');
              chip.className = 'session';
              chip.textContent = session.title + ' · ' + session.sessionId.slice(0, 8);
              sessions.appendChild(chip);
            }
          }

          function appendEntry(entry) {
            transcript.appendChild(entryNode(entry));
            transcript.scrollTop = transcript.scrollHeight;
          }

          window.addEventListener('message', (event) => {
            const message = event.data;
            if (!message) return;
            switch (message.type) {
              case 'state':
                renderState(message.state);
                break;
              case 'append':
              case 'replace': {
                const existing = transcript.querySelector('[data-entry-id="' + message.entry.id + '"]');
                if (existing) {
                  existing.textContent = message.entry.text;
                } else {
                  appendEntry(message.entry);
                }
                break;
              }
              case 'sessions':
                renderSessions(message.sessions || []);
                break;
              case 'error':
              case 'session-start':
                if (message.message) status.textContent = message.message;
                break;
              case 'diff-preview':
                appendEntry({ id: 'diff-' + Date.now(), role: 'system', text: 'Diff ready for ' + message.diff.filePath });
                break;
            }
          });

          document.getElementById('newSession').addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
          document.getElementById('resumeLatest').addEventListener('click', () => vscode.postMessage({ type: 'resumeLatest' }));
          document.getElementById('refreshSessions').addEventListener('click', () => vscode.postMessage({ type: 'refreshSessions' }));
          document.getElementById('cancelPrompt').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
          document.getElementById('sendPrompt').addEventListener('click', () => {
            vscode.postMessage({ type: 'sendPrompt', prompt: prompt.value });
            prompt.value = '';
            prompt.focus();
          });
          prompt.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              vscode.postMessage({ type: 'sendPrompt', prompt: prompt.value });
              prompt.value = '';
            }
          });

          vscode.postMessage({ type: 'ready' });
        </script>
      </body>
      </html>`;
  }
}

export async function applyAcceptedDiff(notification: unknown): Promise<void> {
  if (!isRecord(notification)) {
    return;
  }
  if (notification.method !== 'ide/diffAccepted') {
    return;
  }
  if (!isDiffAcceptedParams(notification.params)) {
    return;
  }
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(notification.params.filePath),
    textEncoder.encode(notification.params.content),
  );
}
