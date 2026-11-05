/**
 * Message recall for the DeepSeek Harness Web conversation.
 *
 * The shipped user-message row renders a bubble plus a copy/time action row.
 * That row is not an extension slot, so this plugin replaces the keyed
 * `conversation.chat.node` renderer for the `user` kind and keeps the host's
 * own `conversation.chat.user.content` factory for the bubble itself: text,
 * attachments, reference summary, and skill chips stay host markup, and only
 * the action row (time, recall, copy) belongs to this plugin.
 *
 * The session log is append-only, so recall never rewrites it. Recalling a
 * message forks the session at the event immediately before that message,
 * opens the fork, puts the recalled text back into the fork's composer, and
 * archives the superseded source conversation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

/** Client locale namespace owned by this plugin. */
const NS = 'messageRecall'
/** Stable style-tag identity; one tag per installed plugin generation. */
const STYLE_ID = '@kaus-io/dsh-message-recall/MessageRecall.css'

/** Translate seat handed to the slot component by the Client locale service. */
type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** One attachment carried by a user message, in the shape the content factory expects. */
type UserAttachment =
  | { readonly type: 'image'; readonly image: { readonly attachment: unknown } }
  | { readonly type: 'file'; readonly file: unknown }

/** Split user content into the factory's text/attachment/extra shape. */
interface ContentParts {
  readonly text: string
  readonly attachments: readonly UserAttachment[]
  readonly rest: readonly unknown[]
}

/** Durable payload of one `user` Chat node (only the fields this plugin reads). */
interface UserNodeData {
  readonly seq?: number
  readonly time: number
  readonly content: readonly unknown[]
  readonly referenceLabels?: readonly string[]
  readonly skillNames?: readonly string[]
}

/** Minimal shape of the live Chat snapshot used for the follow-up count. */
interface ChatSnapshotLike {
  readonly nodes: { values(): readonly { readonly anchorSeq: number; readonly kind: string }[] }
}

/** Owner currency plus the framework props this renderer consumes. */
interface RecallRowProps {
  readonly node: { readonly anchorSeq: number; readonly data: UserNodeData }
  readonly renderFactorySlot: (name: string, input: Readonly<Record<string, unknown>>) => ReactNode
  readonly loadImage: (image: unknown) => string | undefined
  readonly t: Translate
  readonly sessionId: string
  readonly useChat: <T>(selector: (snapshot: ChatSnapshotLike) => T) => T
  readonly useAccess: (action: string) => boolean
  readonly useSessionStatus: (selector: (statuses: ReadonlyMap<string, { readonly running?: boolean }>) => boolean) => boolean
  readonly recall: (sessionId: string, atSeq: number, text: string) => Promise<string>
}

/** Recall worker returned by {@link createRecall}. */
interface RecallWorker {
  dispose(): void
  recall(sessionId: string, atSeq: number, text: string): Promise<string>
}

/** Client services this plugin uses. */
interface ClientContext {
  effect(factory: () => (() => void) | void, label?: string): void
  get(name: string): unknown
  locale: { register(namespace: string, dicts: Record<string, Record<string, string>>): () => void }
  slots: {
    inject(key: string, callback: () => () => void): void
    register(options: Record<string, unknown>, component: (props: RecallRowProps) => ReactElement): () => void
  }
  sessions: {
    fork(args: { readonly sessionId: string; readonly atSeq: number }): Promise<string>
    binding(id: string): unknown
  }
  uiWorkspace: {
    openSession(id: string): void
    archiveSession(id: string, options?: { readonly stopActivity?: boolean }): Promise<void>
  }
}

/** Conversation input resolver shape used for the composer hand-back. */
interface InputResolver {
  requestDraftInitialization(binding: unknown, options: { prompt: string; clearPreviousDraft: boolean }): string
}

const zh: Record<string, string> = {
  copy: '复制',
  copied: '已复制',
  recall: '撤回这条消息',
  recallUnavailable: '当前无法撤回：请等待本轮回复结束',
  recallFirst: '这是本会话的第一条消息，无法撤回',
  confirmOne: '撤回这条消息？',
  confirmMore: '撤回这条消息及其后 {count} 条提问？',
  confirm: '确定',
  cancel: '取消',
  recalling: '正在撤回…',
  failed: '撤回失败：{message}',
  'clock.md': '{m}月{d}日',
  'clock.ymd': '{y}年{m}月{d}日',
}

const en: Record<string, string> = {
  copy: 'Copy',
  copied: 'Copied',
  recall: 'Recall this message',
  recallUnavailable: 'Not now: wait for the running turn to finish',
  recallFirst: 'The first message of a conversation cannot be recalled',
  confirmOne: 'Recall this message?',
  confirmMore: 'Recall this message and the {count} questions after it?',
  confirm: 'Recall',
  cancel: 'Cancel',
  recalling: 'Recalling…',
  failed: 'Recall failed: {message}',
  'clock.md': '{m}/{d}',
  'clock.ymd': '{y}/{m}/{d}',
}

const S = {
  row: 'dshRecall_row',
  later: 'dshRecall_later',
  actionRow: 'dshRecall_actionRow',
  time: 'dshRecall_time',
  action: 'dshRecall_action',
  confirm: 'dshRecall_confirm',
  confirmText: 'dshRecall_confirmText',
  confirmButton: 'dshRecall_confirmButton',
  confirmPrimary: 'dshRecall_confirmPrimary',
  error: 'dshRecall_error',
} as const

/* Layout and metrics are copied from the shipped MessageItem/MessageIconActions
 * styles so the synthesized row sits exactly where the host's own copy row sat.
 * Only theme tokens are referenced. */
const CSS = [
  `.${S.row}{flex-direction:column;align-items:flex-end;gap:6px;display:flex}`,
  `.${S.actionRow}{height:calc(28px + var(--dsh-content-font-delta,0px));align-items:center;gap:8px;display:flex}`,
  `.${S.time}{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);white-space:nowrap;padding-right:12px}`,
  `.${S.action}{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}`,
  `.${S.action} svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}`,
  `.${S.action}:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}`,
  `.${S.action}:disabled{cursor:default;opacity:.4}`,
  `.${S.action}:disabled:hover{color:var(--dsw-alias-label-tertiary);background:0 0}`,
  `.${S.action}:focus-visible{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}`,
  `.${S.confirm}{min-height:calc(28px + var(--dsh-content-font-delta,0px));box-sizing:border-box;align-items:center;gap:2px;max-width:100%;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);padding:2px 4px 2px 12px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:18px;display:flex}`,
  `.${S.confirmText}{min-width:0;padding-right:4px;overflow-wrap:anywhere}`,
  `.${S.confirmButton}{border:none;border-radius:999px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;white-space:nowrap;cursor:pointer;padding:4px 10px}`,
  `.${S.confirmButton}:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}`,
  `.${S.confirmButton}:disabled{cursor:default;opacity:.4}`,
  `.${S.confirmPrimary}{color:var(--dsw-alias-state-error-primary)}`,
  `.${S.confirmPrimary}:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}`,
  `.${S.confirmButton}:focus-visible{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}`,
  `.${S.error}{max-width:100%;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}`,
  '@media (hover:hover){',
  `.${S.later} .${S.actionRow}{opacity:0;transition:opacity 80ms}`,
  `.${S.later}:hover .${S.actionRow},.${S.later}:focus-within .${S.actionRow}{opacity:1}`,
  '}',
  '@media (prefers-reduced-motion:reduce){',
  `.${S.later} .${S.actionRow}{transition:none}`,
  '}',
].join('')

/** Install the plugin stylesheet for the plugin's lifetime. */
function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = '@kaus-io/dsh-message-recall'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}

const pad2 = (value: number): string => (value < 10 ? `0${String(value)}` : String(value))

/**
 * Compact local timestamp, matching the shipped message action row: bare clock
 * for today, date templates for older events.
 */
function formatClock(time: number, t: Translate, now: number = Date.now()): string {
  const date = new Date(time)
  const today = new Date(now)
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()) {
    return clock
  }
  const params = { y: String(date.getFullYear()), m: String(date.getMonth() + 1), d: String(date.getDate()) }
  const stamp = date.getFullYear() === today.getFullYear() ? t('clock.md', params) : t('clock.ymd', params)
  return `${stamp} ${clock}`
}

/** Split a user message into the shape the official content factory expects. */
function contentParts(content: readonly unknown[]): ContentParts {
  const texts: string[] = []
  const attachments: UserAttachment[] = []
  const rest: unknown[] = []
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block === null || typeof block !== 'object') {
        rest.push(block)
        continue
      }
      const record = block as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string') {
        texts.push(record.text)
      } else if (record.type === 'image' && record.attachment !== undefined) {
        attachments.push({ type: 'image', image: { attachment: record.attachment } })
      } else if (record.type === 'file' && record.attachment !== undefined) {
        attachments.push({ type: 'file', file: record.attachment })
      } else {
        rest.push(block)
      }
    }
  }
  return { text: texts.join(''), attachments, rest }
}

/** Clipboard write with a boolean outcome; no fallback path mutates the page. */
function writeClipboard(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return Promise.resolve(false)
  if (typeof navigator.clipboard.writeText !== 'function') return Promise.resolve(false)
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  )
}

function RecallGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.8 3.6 3 6.4l2.8 2.8" />
      <path d="M3 6.4h6.1A3.9 3.9 0 0 1 13 10.3v.9" />
    </svg>
  )
}

function CopyGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x={5.7} y={5.7} width={7.6} height={7.6} rx={1.7} />
      <path d="M10.3 3.5H4.9A1.4 1.4 0 0 0 3.5 4.9v5.4" />
    </svg>
  )
}

function CheckGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3.5 8.4 2.9 2.9 6.1-6.6" />
    </svg>
  )
}

/**
 * Recall worker bound to the plugin context.
 * @param ctx - plugin context carrying the Client services.
 */
function createRecall(ctx: ClientContext): RecallWorker {
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (fn: () => void, ms: number): void => {
    const id = setTimeout(() => {
      timers.delete(id)
      fn()
    }, ms)
    timers.add(id)
  }

  /**
   * Put recalled text into a freshly opened Session's composer. The shell for
   * the fork may still be coming up, so a bounded retry loop applies the draft
   * once the new generation is retained and addressable.
   */
  const prefill = (sessionId: string, text: string): void => {
    if (text === '') return
    const conversation = ctx.get('conversation') as { input?: InputResolver } | undefined
    if (conversation === undefined || conversation.input === undefined) return
    const input = conversation.input
    let attempts = 0
    const applyDraft = (): void => {
      attempts += 1
      const binding = ctx.sessions.binding(sessionId)
      if (binding !== undefined) {
        try {
          const outcome = input.requestDraftInitialization(binding, { prompt: text, clearPreviousDraft: true })
          if (outcome === 'applied') return
        } catch {
          /* The fork's generation is not the retained one yet: retry. */
        }
      }
      if (attempts < 80) later(applyDraft, 50)
    }
    later(applyDraft, 0)
  }

  return {
    dispose() {
      for (const id of timers) clearTimeout(id)
      timers.clear()
    },
    /**
     * Fork at `atSeq`, open the fork, restore the prompt, archive the source.
     * @param sessionId - source Session.
     * @param atSeq - inclusive cut: the event immediately before the recalled message.
     * @param text - recalled prompt text restored into the fork's composer.
     * @returns the fork's Session identity.
     */
    async recall(sessionId: string, atSeq: number, text: string): Promise<string> {
      const childId = await ctx.sessions.fork({ sessionId, atSeq })
      ctx.uiWorkspace.openSession(childId)
      prefill(childId, text)
      try {
        await ctx.uiWorkspace.archiveSession(sessionId, { stopActivity: true })
      } catch (error) {
        console.warn('[dsh-message-recall] could not archive the recalled conversation:', error)
      }
      return childId
    },
  }
}

/**
 * Keyed `user` Chat renderer: the host bubble plus this plugin's action row.
 */
function UserRecallRow(props: RecallRowProps): ReactElement {
  const { node, renderFactorySlot, loadImage, t, sessionId, useChat, useAccess, useSessionStatus, recall } = props
  const data = node.data
  const content = data.content
  const parts = useMemo(() => contentParts(content), [content])
  const prepared = useMemo(
    () => ({
      text: parts.text,
      attachments: parts.attachments,
      extraBlocks: parts.rest,
      ...(data.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels }),
    }),
    [parts, data.referenceLabels],
  )
  const facts = useMemo(
    () => ({
      ...(data.referenceLabels === undefined ? {} : { sessionLabels: data.referenceLabels }),
      ...(data.skillNames === undefined ? {} : { skillNames: data.skillNames }),
    }),
    [data.referenceLabels, data.skillNames],
  )
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'busy'>('idle')
  const [failure, setFailure] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    },
    [],
  )
  const messageSeq = typeof data.seq === 'number' ? data.seq : node.anchorSeq
  /** Later human messages decide both the confirm count and hover reveal. */
  const laterUsers = useChat((snapshot) => {
    let count = 0
    for (const candidate of snapshot.nodes.values()) {
      if (candidate.anchorSeq > node.anchorSeq && (candidate.kind === 'user' || candidate.kind === 'steering')) count += 1
    }
    return count
  })
  const canFork = useAccess('session/fork')
  const running = useSessionStatus((statuses) => statuses.get(sessionId)?.running === true)
  const unavailable = messageSeq <= 0 ? t('recallFirst') : running ? t('recallUnavailable') : null

  const onCopy = useCallback(() => {
    if (copied) return
    writeClipboard(parts.text).then((ok) => {
      if (!ok) return
      setCopied(true)
      copyTimer.current = setTimeout(() => {
        copyTimer.current = null
        setCopied(false)
      }, 1000)
    })
  }, [copied, parts.text])

  const onConfirm = useCallback(async () => {
    setPhase('busy')
    setFailure(null)
    try {
      await recall(sessionId, messageSeq - 1, parts.text)
      setPhase('idle')
    } catch (error) {
      setPhase('idle')
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }, [messageSeq, parts.text, recall, sessionId])

  const confirming = phase === 'confirm' || phase === 'busy'
  const rowClass = S.row + (laterUsers > 0 && !confirming ? ` ${S.later}` : '')

  return (
    <div className={rowClass} data-message-recall="">
      {renderFactorySlot('conversation.chat.user.content', { content: prepared, loadImage, facts, interactive: true })}
      {confirming ? (
        <div className={S.confirm} role="group" aria-label={t('recall')}>
          <span className={S.confirmText}>
            {phase === 'busy' ? t('recalling') : laterUsers > 0 ? t('confirmMore', { count: laterUsers }) : t('confirmOne')}
          </span>
          <button type="button" className={`${S.confirmButton} ${S.confirmPrimary}`} disabled={phase === 'busy'} onClick={onConfirm}>
            {t('confirm')}
          </button>
          <button type="button" className={S.confirmButton} disabled={phase === 'busy'} onClick={() => setPhase('idle')}>
            {t('cancel')}
          </button>
        </div>
      ) : (
        <div className={S.actionRow}>
          <span className={S.time}>{formatClock(data.time, t)}</span>
          {canFork ? (
            <button
              type="button"
              className={S.action}
              aria-label={t('recall')}
              title={unavailable ?? t('recall')}
              disabled={unavailable !== null}
              onClick={() => setPhase('confirm')}
            >
              <RecallGlyph />
            </button>
          ) : null}
          <button
            type="button"
            className={S.action}
            aria-label={copied ? t('copied') : t('copy')}
            title={copied ? t('copied') : t('copy')}
            onClick={onCopy}
          >
            {copied ? <CheckGlyph /> : <CopyGlyph />}
          </button>
        </div>
      )}
      {failure === null ? null : (
        <div className={S.error} role="status">
          {t('failed', { message: failure })}
        </div>
      )}
    </div>
  )
}

/** Services the Client context must provide before this plugin activates. */
export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => installStyles(), 'message-recall: styles')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'message-recall: dictionaries')
  const worker = createRecall(ctx)
  ctx.effect(() => () => worker.dispose(), 'message-recall: pending timers')
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register(
      {
        name: 'conversation.chat.node',
        key: 'user',
        /* Lowest priority wins a keyed cell; the shipped renderer sits at 0. */
        priority: -10,
        locale: NS,
        inject: () => ({ recall: worker.recall }),
      },
      UserRecallRow,
    ),
  )
}
