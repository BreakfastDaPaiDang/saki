/** Streaming terminal-control sanitizer for the line-oriented first release. */

import { Buffer } from 'node:buffer'

/** OSC marker emitted by the controlled bash before each prompt. */
export const PROMPT_MARKER_PREFIX = '133;D;'

/** Exact printable prompt emitted after the private marker. */
export const CONTROLLED_PROMPT = 'dsh> '

interface CursorPositionRequest {
  /** One-based column: exact line start or a conservative non-zero position. */
  readonly column: 1 | 2
}

/** One sanitized chunk plus recognized terminal protocol facts. */
export interface SanitizedChunk {
  text: string
  prompt: boolean
  /** Printable text after the latest owned marker in this chunk. */
  promptTail?: string
  /** The first exact ANSI cursor-position request removed from this chunk. */
  cursorPositionRequest?: CursorPositionRequest
}

/**
 * Remove CSI/OSC/short escape sequences while preserving split-sequence carry.
 * Full terminal emulation is deliberately deferred; ordinary line output and
 * the private prompt marker are the supported contract.
 */
export class TerminalSanitizer {
  private pending = ''
  private discardMode: 'osc' | 'csi' | undefined
  private discardOscEscape = false
  private trailingCarriageReturn = false
  private trackingPromptTail = false
  private atLineStart = true

  constructor(private readonly maxPendingBytes: number) {}

  /**
   * Consume one decoded `node-pty` data chunk.
   * @param chunk - decoded terminal data.
   * @returns Printable text, private prompt state, and the first removed exact cursor-position request.
   */
  push(chunk: string): SanitizedChunk {
    this.pending += this.discardPrefix(chunk)
    let text = ''
    let prompt = false
    let cursorPositionRequest: CursorPositionRequest | undefined
    let includePromptTail = this.trackingPromptTail
    let promptTail = ''
    let index = 0
    const appendText = (value: string): void => {
      text += value
      if (this.trackingPromptTail) promptTail += value
      this.trackLineStart(value)
    }
    while (index < this.pending.length) {
      const escape = this.pending.indexOf('\x1b', index)
      if (escape < 0) {
        appendText(this.pending.slice(index))
        index = this.pending.length
        break
      }
      appendText(this.pending.slice(index, escape))
      if (escape + 1 >= this.pending.length) {
        index = escape
        break
      }
      const kind = this.pending[escape + 1]
      if (kind === ']') {
        const bel = this.pending.indexOf('\x07', escape + 2)
        const stringTerminator = this.pending.indexOf('\x1b\\', escape + 2)
        let end = -1
        if (bel >= 0 && stringTerminator >= 0) end = Math.min(bel + 1, stringTerminator + 2)
        else if (bel >= 0) end = bel + 1
        else if (stringTerminator >= 0) end = stringTerminator + 2
        if (end < 0) {
          index = escape
          break
        }
        const terminatorBytes = this.pending[end - 1] === '\x07' ? 1 : 2
        const content = this.pending.slice(escape + 2, end - terminatorBytes)
        if (content.startsWith(PROMPT_MARKER_PREFIX)) {
          prompt = true
          this.trackingPromptTail = true
          includePromptTail = true
          promptTail = ''
        }
        index = end
        continue
      }
      if (kind === '[') {
        let end = escape + 2
        while (end < this.pending.length) {
          const code = this.pending.charCodeAt(end)
          if (code >= 0x40 && code <= 0x7e) break
          end += 1
        }
        if (end >= this.pending.length) {
          index = escape
          break
        }
        const sequence = this.pending.slice(escape, end + 1)
        if (sequence === '\x1b[6n' && cursorPositionRequest === undefined) {
          cursorPositionRequest = { column: this.atLineStart ? 1 : 2 }
        }
        const final = sequence.at(-1)
        if (final !== 'm' && final !== 'n' && sequence !== '\x1b[?1h' && sequence !== '\x1b[?1l') {
          this.atLineStart = false
        }
        index = end + 1
        continue
      }
      // Two-byte escape family (save/restore cursor and similar).
      this.atLineStart = false
      index = escape + 2
    }
    this.pending = this.pending.slice(index)
    this.enforcePendingBound()
    return {
      text: this.normalizeText(text),
      prompt,
      ...includePromptTail ? { promptTail } : {},
      ...cursorPositionRequest !== undefined ? { cursorPositionRequest } : {},
    }
  }

  /**
   * Flush a trailing printable fragment when the PTY exits.
   * @returns Remaining printable text; incomplete escapes are discarded.
   */
  flush(): string {
    const text = this.pending.startsWith('\x1b') ? '' : this.pending
    this.pending = ''
    this.discardMode = undefined
    this.discardOscEscape = false
    this.trackingPromptTail = false
    const normalized = this.normalizeText(text)
    if (!this.trailingCarriageReturn) return normalized
    this.trailingCarriageReturn = false
    return `${normalized}\n`
  }

  private normalizeText(text: string): string {
    let complete = this.trailingCarriageReturn ? `\r${text}` : text
    this.trailingCarriageReturn = false
    if (complete.endsWith('\r')) {
      complete = complete.slice(0, -1)
      this.trailingCarriageReturn = true
    }
    return normalizeTerminalText(complete)
  }

  private trackLineStart(text: string): void {
    for (const character of text) {
      if (character === '\r' || character === '\n') this.atLineStart = true
      else if (character !== '\x07' && character !== '\0') this.atLineStart = false
    }
  }

  private enforcePendingBound(): void {
    if (Buffer.byteLength(this.pending) <= this.maxPendingBytes) return
    this.discardMode = this.pending[1] === ']' ? 'osc' : 'csi'
    if (this.discardMode === 'csi') this.atLineStart = false
    this.pending = ''
  }

  private discardPrefix(chunk: string): string {
    if (this.discardMode === undefined) return chunk
    if (this.discardMode === 'csi') {
      for (let index = 0; index < chunk.length; index += 1) {
        const code = chunk.charCodeAt(index)
        if (code >= 0x40 && code <= 0x7e) {
          this.discardMode = undefined
          return chunk.slice(index + 1)
        }
      }
      return ''
    }

    let index = 0
    if (this.discardOscEscape) {
      this.discardOscEscape = false
      if (chunk.startsWith('\\')) {
        this.discardMode = undefined
        return chunk.slice(1)
      }
    }
    while (index < chunk.length) {
      if (chunk[index] === '\x07') {
        this.discardMode = undefined
        return chunk.slice(index + 1)
      }
      if (chunk[index] === '\x1b') {
        if (chunk[index + 1] === '\\') {
          this.discardMode = undefined
          return chunk.slice(index + 2)
        }
        if (index + 1 === chunk.length) this.discardOscEscape = true
      }
      index += 1
    }
    return ''
  }
}

/**
 * Normalize CRLF and standalone carriage returns for line-oriented rendering.
 * @param text - sanitized terminal text.
 * @returns Line-normalized text with BEL removed.
 */
export function normalizeTerminalText(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\x07', '')
}
