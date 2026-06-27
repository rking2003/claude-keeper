/**
 * PromptTracker — best-effort reconstruction of the user's last submitted
 * prompt from the raw keystroke stream, for the "replay" resume strategy.
 *
 * Terminal input is messy: besides printable characters it carries control
 * codes (Enter, Backspace, Ctrl-U/W/C) and ANSI escape sequences (arrow keys,
 * Home/End, bracketed-paste markers, SS3, OSC ...). The previous inline
 * implementation mis-handled CSI sequences — e.g. an Up-arrow `ESC [ A` leaked a
 * literal `A` into the captured prompt because `[` (0x5b) falls inside the
 * "final byte" range. This class runs a small, explicit state machine so escape
 * sequences are fully consumed and never pollute the buffer.
 *
 * It models:
 *  - 7-bit AND 8-bit (C1) escape introducers (ESC[ / 0x9B CSI, ESC O / 0x8F SS3,
 *    ESC] / 0x9D OSC, DCS/SOS/PM/APC),
 *  - bracketed paste (`CSI 200~` .. `CSI 201~`): newlines *inside* a paste are
 *    kept as content rather than treated as submit, so multi-line / code-block
 *    prompts are captured whole,
 *  - code-point-safe editing (backspace/cap operate on whole code points, so
 *    astral characters / emoji aren't corrupted).
 *
 * It is a *linear* reconstruction: it does not model cursor position, so
 * mid-line editing via arrow keys is ignored rather than applied (a documented
 * limitation — the UI also offers an explicit replay-prompt override). Pure and
 * Electron-free; unit-tested in isolation.
 */

type Mode = 'normal' | 'esc' | 'csi' | 'ss3' | 'osc';

const ESC = 0x1b;
const BEL = 0x07;
const CR = 0x0d;
const LF = 0x0a;
const DEL = 0x7f;
const BS = 0x08;
const CTRL_C = 0x03;
const CTRL_U = 0x15;
const CTRL_W = 0x17;

// 8-bit C1 control introducers (when the input stream is decoded such that these
// appear as single code points).
const C1_SS3 = 0x8f;
const C1_DCS = 0x90;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const C1_PM = 0x9e;
const C1_APC = 0x9f;

export class PromptTracker {
  /** Soft cap on a single reconstructed line, in code points. */
  static readonly MAX_LEN = 8192;

  /** Current line as an array of whole code points (edit-safe). */
  private chars: string[] = [];
  private last = '';
  private mode: Mode = 'normal';
  /** Accumulated CSI parameter/intermediate bytes, to detect paste markers. */
  private csiBuf = '';
  /** Bracketed-paste nesting depth (>0 means we are inside a paste). */
  private pasteDepth = 0;
  /** Tracks a just-seen CR inside a paste, to collapse CRLF into one newline. */
  private pasteSawCr = false;

  /** The most recently committed (Enter-terminated) non-empty line. */
  get lastPrompt(): string {
    return this.last;
  }

  /** The current, not-yet-submitted input line (for previews/diagnostics). */
  get pending(): string {
    return this.chars.join('');
  }

  /** Clear everything — call when a brand-new session starts. */
  reset(): void {
    this.chars = [];
    this.last = '';
    this.mode = 'normal';
    this.csiBuf = '';
    this.pasteDepth = 0;
    this.pasteSawCr = false;
  }

  /** Explicitly set the last prompt (e.g. user typed it into a prompt bar). */
  setLast(text: string): void {
    this.last = text.trim();
  }

  /** Feed a chunk of accepted user keystrokes. Safe to call across chunks. */
  push(data: string): void {
    for (const ch of data) {
      const code = ch.codePointAt(0) ?? 0;

      // ESC always (re)starts escape parsing, in any mode. This also makes the
      // ST terminator (ESC \) of OSC/DCS strings consume its trailing byte.
      if (code === ESC) {
        this.mode = 'esc';
        continue;
      }

      switch (this.mode) {
        case 'esc':
          this.afterEsc(code);
          break;
        case 'csi':
          this.inCsi(ch, code);
          break;
        case 'ss3':
          // SS3 (ESC O) addresses a single following byte (e.g. app-mode arrows).
          this.mode = 'normal';
          break;
        case 'osc':
          // OSC/string sequences terminate on BEL or 8-bit ST (ESC-ST handled above).
          if (code === BEL || code === C1_ST) this.mode = 'normal';
          break;
        default:
          this.normal(ch, code);
      }
    }
  }

  private afterEsc(code: number): void {
    if (code === 0x5b) {
      this.mode = 'csi'; // '['
      this.csiBuf = '';
    } else if (code === 0x4f) {
      this.mode = 'ss3'; // 'O'
    } else if (code === 0x5d) {
      this.mode = 'osc'; // ']' OSC
    } else if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
      this.mode = 'osc'; // DCS/SOS/PM/APC
    } else if (code === CR || code === LF) {
      // A lone ESC followed by Enter (e.g. vi-mode "discard then submit"): drop
      // the ESC and treat the Enter as a real line commit instead of swallowing it.
      this.mode = 'normal';
      this.commit();
    } else {
      this.mode = 'normal'; // two-byte escape (ESC b, ESC f, ESC \\, ...): consume this byte
    }
  }

  private inCsi(ch: string, code: number): void {
    // Final byte (0x40-0x7e) ends the sequence; everything before it is a
    // parameter (0x30-0x3f) or intermediate (0x20-0x2f) byte we accumulate so we
    // can recognize bracketed-paste markers `CSI 200~` / `CSI 201~`.
    if (code >= 0x40 && code <= 0x7e) {
      if (ch === '~') {
        if (this.csiBuf === '200') this.pasteDepth += 1;
        else if (this.csiBuf === '201') this.pasteDepth = Math.max(0, this.pasteDepth - 1);
      }
      this.csiBuf = '';
      this.mode = 'normal';
    } else {
      this.csiBuf += ch;
    }
  }

  private normal(ch: string, code: number): void {
    // Inside a bracketed paste, the content is literal: keep newlines as part of
    // the prompt instead of submitting, so multi-line prompts survive intact.
    if (this.pasteDepth > 0) {
      if (code === CR) {
        this.append('\n');
        this.pasteSawCr = true;
        return;
      }
      if (code === LF) {
        // Collapse CRLF into the single newline already emitted for the CR.
        if (!this.pasteSawCr) this.append('\n');
        this.pasteSawCr = false;
        return;
      }
      this.pasteSawCr = false;
      if (code >= 0x20 && code !== DEL && !(code >= 0x80 && code <= 0x9f)) this.append(ch);
      return;
    }

    if (code === CR || code === LF) {
      this.commit();
    } else if (code === DEL || code === BS) {
      this.chars.pop();
    } else if (code === CTRL_U) {
      this.chars = []; // kill whole line
    } else if (code === CTRL_W) {
      this.killWord();
    } else if (code === CTRL_C) {
      this.chars = []; // cancel current line; nothing committed
    } else if (code === C1_CSI) {
      this.mode = 'csi';
      this.csiBuf = '';
    } else if (code === C1_SS3) {
      this.mode = 'ss3';
    } else if (code === C1_OSC || code === C1_DCS || code === C1_PM || code === C1_APC) {
      this.mode = 'osc';
    } else if (code >= 0x80 && code <= 0x9f) {
      // Other C1 controls: ignore rather than emit a garbage glyph.
    } else if (code >= 0x20 && code !== DEL) {
      this.append(ch);
    }
    // Any other C0 control byte (Tab, Ctrl-D, bells, etc.) is ignored.
  }

  private append(ch: string): void {
    if (this.chars.length < PromptTracker.MAX_LEN) this.chars.push(ch);
  }

  private commit(): void {
    const line = this.chars.join('').trim();
    if (line.length > 0) this.last = line;
    this.chars = [];
  }

  private killWord(): void {
    const s = this.chars.join('').replace(/\s+$/, '').replace(/\S+$/, '');
    this.chars = Array.from(s);
  }
}
