/** Bridges MCP Apps `ui/message` requests from the visualization iframe into Pi. */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { DdvizRequestHandler } from './client.js';

/** The Pi surface the `ui/message` adapter depends on. */
export type PiUiMessageApi = Pick<ExtensionAPI, 'on'>;

/** Editor and notification UI the draft flow uses, narrowed from `ctx.ui`. */
export type DraftUi = Pick<ExtensionContext['ui'], 'getEditorText' | 'setEditorText' | 'notify' | 'setStatus'>;

/** Session context the draft flow needs, narrowed from `ExtensionContext`. */
export type PiSessionContext = { mode: ExtensionContext['mode']; ui: DraftUi };

/** Pi user-message content block, as parsed from a `ui/message` request. */
export interface PiUserContentBlock {
  type: 'text';
  text: string;
}

/** Sanity cap on a single `ui/message` payload; chart interactions are short. */
export const MAX_UI_MESSAGE_CHARS = 20_000;

const invalid = (message: string): Error => new Error(`Invalid message format: ${message}`);

/**
 * Validate an MCP Apps `ui/message` request payload and normalize it to Pi
 * user-message content. Throws on anything unsupported — the JSON-RPC layer
 * turns the thrown error into a `-32000` response for that request alone.
 */
export const parseUiMessage = (params: unknown): PiUserContentBlock[] => {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw invalid('params must be an object');
  }

  const { role, content } = params as Record<string, unknown>;
  // The MCP Apps spec currently defines "user" as the only supported role.
  if (role !== 'user') {
    throw invalid('only "user" messages are supported');
  }
  if (!Array.isArray(content)) {
    throw invalid('content must be an array');
  }
  if (content.length === 0) {
    throw invalid('content must not be empty');
  }

  const blocks: PiUserContentBlock[] = [];
  let chars = 0;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      throw invalid('content blocks must be objects');
    }
    const { type, text } = block as Record<string, unknown>;
    // Only text is advertised; other modalities are rejected rather than
    // silently dropped, so a mixed message never loses part of its meaning.
    if (type !== 'text') {
      throw invalid(`unsupported content type: ${String(type)}`);
    }
    if (typeof text !== 'string') {
      throw invalid('text block must contain text');
    }
    chars += text.length;
    blocks.push({ type: 'text', text });
  }

  if (!blocks.some((block) => block.text.trim().length > 0)) {
    throw invalid('message must contain non-whitespace text');
  }
  if (chars > MAX_UI_MESSAGE_CHARS) {
    throw invalid(`message is too large (over ${MAX_UI_MESSAGE_CHARS} characters)`);
  }
  return blocks;
};

/**
 * Handle visualization `ui/message` requests.
 *
 * - Fill an empty editor with a draft for the user to edit, discard, or submit.
 * - Silently replace our previous draft if its text is unchanged.
 * - Otherwise preserve the editor, warn the user, and return a JSON-RPC error.
 * - Warn when a draft starts with "/" or "!": Enter would run it on the
 *   user's behalf, so they must verify it before sending.
 */
export const createUiMessageHandler = (pi: PiUiMessageApi): DdvizRequestHandler<'ui/message'> => {
  // The session context is only reachable from event handlers; capture it as
  // sessions start so request handlers can reach the editor.
  let session: PiSessionContext | null = null;
  // Our last draft, as long as the user has not edited it; null when unknown.
  let proposal: string | null = null;
  pi.on('session_start', (_event, ctx) => {
    session = ctx;
    // A new session starts with a fresh editor, not our old draft.
    proposal = null;
  });
  pi.on('input', (event) => {
    // Only an interactive submit empties the editor; text reappearing there
    // later is recalled history — the user's, never replaceable by us.
    if (event.source === 'interactive') {
      proposal = null;
    }
  });
  // Shell text ("!"/"!!") runs before the input pipeline, so the input
  // event never fires for it; the editor was still consumed the same way.
  pi.on('user_bash', () => {
    proposal = null;
  });

  return (params) => {
    const content = parseUiMessage(params);

    if (session === null || session.mode !== 'tui') {
      // No editor to draft into; never send without the user's confirmation.
      return {};
    }

    const ui: DraftUi = session.ui;
    const current = ui.getEditorText();
    const text = content.map((block) => block.text).join('\n\n');
    // Anything the user typed is theirs — even whitespace. Our own draft is
    // the only non-empty text we may replace, and only while unedited.
    if (current !== '' && current !== proposal) {
      ui.notify(
        'Visualization proposal not inserted: your input already contains text. Clear or send it, then click again.',
        'warning',
      );
      throw new Error('Cannot insert visualization proposal: editor is not empty');
    }
    // Replacing our own draft is silent — only a first insert needs pointing out.
    const firstInsert = current === '';
    ui.setEditorText(text);
    // The editor normalizes tabs and line endings on storage; read the stored
    // form back so an untouched draft still compares equal on the next click.
    proposal = ui.getEditorText();
    // Pi runs "/"-commands and "!"/"!!"-shell text on Enter; warn the user
    // that this proposal would run on their behalf, every time one lands.
    if (/^[\/!]/.test(text.trimStart())) {
      ui.notify(
        'Visualization proposal starts with "/" or "!": Enter may run it on your behalf. Verify it is what you expect.',
        'warning',
      );
    } else if (firstInsert) {
      ui.notify('Visualization proposal added. Edit it or press Enter to send.', 'info');
    } else {
      // Workaround: clearing an unused status triggers a repaint without showing a message.
      // Fix upstream in Pi: setEditorText should request a render itself.
      ui.setStatus('datadog-viz', undefined);
    }
    // Explicit empty object: serializes as `"result": {}` per the spec.
    return {};
  };
};
