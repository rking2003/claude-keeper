import { describe, it, expect } from 'vitest';
import { PromptTracker } from '../src/core/prompt-tracker';

/** Convenience: build common terminal byte sequences. */
const ESC = '\x1b';
const BEL = '\x07';
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const RIGHT = `${ESC}[C`;
const LEFT = `${ESC}[D`;
const HOME = `${ESC}[H`;
const CTRL_LEFT = `${ESC}[1;5D`;
const SS3_UP = `${ESC}OA`;
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

function track(...chunks: string[]): PromptTracker {
  const t = new PromptTracker();
  for (const c of chunks) t.push(c);
  return t;
}

describe('PromptTracker', () => {
  it('captures a simple line on Enter', () => {
    expect(track('hello world\r').lastPrompt).toBe('hello world');
  });

  it('accepts \\n as a line terminator too', () => {
    expect(track('build the app\n').lastPrompt).toBe('build the app');
  });

  it('does not commit an unterminated line', () => {
    const t = track('still typing');
    expect(t.lastPrompt).toBe('');
    expect(t.pending).toBe('still typing');
  });

  it('keeps the most recent committed line', () => {
    expect(track('first\rsecond\rthird\r').lastPrompt).toBe('third');
  });

  it('handles CRLF without committing a phantom empty line', () => {
    expect(track('hello\r\n').lastPrompt).toBe('hello');
  });

  it('ignores a commit of a blank/whitespace-only line', () => {
    expect(track('real\r   \r').lastPrompt).toBe('real');
    expect(track('   \r').lastPrompt).toBe('');
  });

  it('trims surrounding whitespace on commit', () => {
    expect(track('   spaced out   \r').lastPrompt).toBe('spaced out');
  });

  it('applies backspace mid-stream correctly', () => {
    // "hellp" -> (1x BS) "hell" -> +"o" -> "hello"
    expect(track('hellp\x7fo\r').lastPrompt).toBe('hello');
  });

  it('backspace removes the last char', () => {
    expect(track('abc\x7f\r').lastPrompt).toBe('ab');
    expect(track('abc\b\b\r').lastPrompt).toBe('a');
  });

  it('backspace on empty buffer is a no-op', () => {
    expect(track('\x7f\x7fok\r').lastPrompt).toBe('ok');
  });

  it('Ctrl-U kills the whole line', () => {
    expect(track('throwaway\x15real prompt\r').lastPrompt).toBe('real prompt');
  });

  it('Ctrl-C cancels the current line (nothing committed)', () => {
    const t = track('half typed\x03');
    expect(t.pending).toBe('');
    expect(t.lastPrompt).toBe('');
  });

  it('Ctrl-C does not erase a previously committed prompt', () => {
    expect(track('keep me\rnow cancel\x03').lastPrompt).toBe('keep me');
  });

  it('Ctrl-W kills the previous word (and trailing space)', () => {
    expect(track('delete this word\x17\r').lastPrompt).toBe('delete this');
    expect(track('oneword\x17\r').lastPrompt).toBe('');
  });

  // --- escape sequences must be fully consumed (the core P8 fix) ---

  it('ignores arrow keys (CSI) — no leaked final byte', () => {
    expect(track(`abc${UP}${DOWN}${LEFT}${RIGHT}def\r`).lastPrompt).toBe('abcdef');
  });

  it('ignores Home/End and parametrized CSI (Ctrl-Left)', () => {
    expect(track(`x${HOME}y${CTRL_LEFT}z\r`).lastPrompt).toBe('xyz');
  });

  it('ignores SS3 sequences (app-mode arrows ESC O A)', () => {
    expect(track(`go${SS3_UP}now\r`).lastPrompt).toBe('gonow');
  });

  it('handles an escape sequence split across push() calls', () => {
    // ESC in one chunk, "[A" in the next — must still be swallowed.
    expect(track('foo', ESC, '[A', 'bar\r').lastPrompt).toBe('foobar');
  });

  it('captures bracketed-paste content but drops the markers', () => {
    expect(track(`${PASTE_START}pasted text${PASTE_END}\r`).lastPrompt).toBe('pasted text');
  });

  it('swallows an OSC sequence terminated by BEL', () => {
    expect(track(`a${ESC}]0;window title${BEL}b\r`).lastPrompt).toBe('ab');
  });

  it('swallows an OSC sequence terminated by ST (ESC \\)', () => {
    expect(track(`a${ESC}]0;title${ESC}\\b\r`).lastPrompt).toBe('ab');
  });

  it('swallows two-byte escapes (ESC b / ESC f word nav)', () => {
    expect(track(`word${ESC}bmore\r`).lastPrompt).toBe('wordmore');
  });

  it('keeps unicode / multi-byte characters intact', () => {
    expect(track('café ☕ 日本語\r').lastPrompt).toBe('café ☕ 日本語');
  });

  it('ignores tab and other stray control bytes', () => {
    expect(track('a\tb\x00c\r').lastPrompt).toBe('abc');
  });

  it('caps the buffer length at MAX_LEN', () => {
    const huge = 'a'.repeat(PromptTracker.MAX_LEN + 500);
    const t = track(huge + '\r');
    expect(t.lastPrompt.length).toBe(PromptTracker.MAX_LEN);
  });

  it('reset() clears pending and last', () => {
    const t = track('something\rpending');
    t.reset();
    expect(t.lastPrompt).toBe('');
    expect(t.pending).toBe('');
  });

  it('setLast() overrides the captured prompt (trimmed)', () => {
    const t = track('typed\r');
    t.setLast('  explicit override  ');
    expect(t.lastPrompt).toBe('explicit override');
  });

  // --- P8 hardening (adversarial review findings) ---

  it('keeps newlines inside a bracketed paste as one multi-line prompt', () => {
    const t = track(`${PASTE_START}fix this:\r\nline 1\r\nline 2${PASTE_END}\r`);
    expect(t.lastPrompt).toBe('fix this:\nline 1\nline 2');
  });

  it('does not commit on newlines that occur inside a paste', () => {
    // Without paste-awareness the first \r would commit "alpha" and lose the rest.
    const t = track(`${PASTE_START}alpha\rbeta${PASTE_END}\r`);
    expect(t.lastPrompt).toBe('alpha\nbeta');
  });

  it('backspace deletes a whole astral code point, not a half surrogate', () => {
    // Type an emoji then delete it; the buffer must be empty (no dangling surrogate).
    const t = track('hi 😀\x7f world\r');
    expect(t.lastPrompt).toBe('hi  world');
  });

  it('caps MAX_LEN by code points even with astral characters', () => {
    const huge = '😀'.repeat(PromptTracker.MAX_LEN + 50);
    const t = track(huge + '\r');
    // Code-point count is capped; UTF-16 length would be 2x if mis-counted.
    expect(Array.from(t.lastPrompt).length).toBe(PromptTracker.MAX_LEN);
  });

  it('swallows an 8-bit C1 CSI sequence (0x9b) like a 7-bit ESC[', () => {
    expect(track('foo\x9bAbar\r').lastPrompt).toBe('foobar');
  });

  it('ignores stray 8-bit C1 control bytes instead of emitting glyphs', () => {
    expect(track('a\x84\x99b\r').lastPrompt).toBe('ab');
  });

  it('commits on Enter after a lone ESC (vi-mode discard-then-submit)', () => {
    expect(track(`hello${ESC}\r`).lastPrompt).toBe('hello');
  });
});

