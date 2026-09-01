import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  BuddyCounts,
  BuddyMood,
  BuddySessionView,
  BuddySnapshot,
  PendingKind,
  SessionStatus,
} from '../contract.ts'

export const STATUS_ORDER: readonly SessionStatus[] = ['attention', 'error', 'running', 'done', 'idle']

export const MOOD_ORDER: readonly BuddyMood[] = ['needs-you', 'error', 'working', 'done-unseen', 'idle']

export interface BuddySession {
  id: SessionId
  title: string
  origin?: 'subagent'
  cwd?: string
  blank: boolean
  running: boolean
  pendingKind?: PendingKind
  lastError?: string
  completedUnseen: boolean
  updatedAt: number
}

export function classifyStatus(session: BuddySession): SessionStatus | null {
  if (session.origin === 'subagent') return null
  if (session.pendingKind !== undefined) return 'attention'
  if (session.lastError !== undefined && !session.running) return 'error'
  if (session.running) return 'running'
  if (session.completedUnseen) return 'done'
  if (session.blank) return null
  return 'idle'
}

export function reasonFor(session: BuddySession, status: SessionStatus): string {
  if (session.pendingKind === 'approval') return '等待审批'
  if (session.pendingKind === 'plan-review') return '计划待审'
  if (session.pendingKind === 'question') return '等待回答'
  if (status === 'running') return '运行中'
  if (status === 'done') return '已完成 · 未查看'
  if (status === 'error') return session.lastError !== undefined && session.lastError !== '' ? session.lastError : '出错'
  return '空闲'
}

export function sessionLabel(session: BuddySession): string {
  const title = session.title.trim()
  if (title !== '') return title
  if (session.cwd !== undefined && session.cwd !== '') {
    const parts = session.cwd.replace(/\\/g, '/').split('/').filter(Boolean)
    const base = parts.at(-1)
    if (base !== undefined) return base
  }
  if (session.blank) return '新会话'
  return '未命名会话'
}

export function moodOf(status: SessionStatus): BuddyMood {
  if (status === 'attention') return 'needs-you'
  if (status === 'error') return 'error'
  if (status === 'running') return 'working'
  if (status === 'done') return 'done-unseen'
  return 'idle'
}

export function aggregateMood(sessions: readonly BuddySession[]): BuddyMood {
  let best: BuddyMood = 'idle'
  for (const session of sessions) {
    const status = classifyStatus(session)
    if (status === null) continue
    const mood = moodOf(status)
    if (MOOD_ORDER.indexOf(mood) < MOOD_ORDER.indexOf(best)) best = mood
  }
  return best
}

export function emptyCounts(): BuddyCounts {
  return { attention: 0, error: 0, running: 0, done: 0, idle: 0 }
}

export function toSessionView(session: BuddySession, status: SessionStatus): BuddySessionView {
  return {
    id: String(session.id),
    title: sessionLabel(session),
    status,
    reason: reasonFor(session, status),
    ...(session.pendingKind !== undefined ? { pendingKind: session.pendingKind } : {}),
    ...(session.lastError !== undefined ? { lastError: session.lastError } : {}),
    updatedAt: session.updatedAt,
  }
}

export function buildSnapshot(sessions: readonly BuddySession[], revision: number): BuddySnapshot {
  const counts = { attention: 0, error: 0, running: 0, done: 0, idle: 0 }
  const rows: BuddySessionView[] = []
  for (const session of sessions) {
    const status = classifyStatus(session)
    if (status === null) continue
    counts[status] += 1
    rows.push(toSessionView(session, status))
  }
  rows.sort((a, b) => {
    const rank = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
    if (rank !== 0) return rank
    return b.updatedAt - a.updatedAt
  })
  return {
    mood: aggregateMood(sessions),
    counts,
    sessions: rows,
    revision,
  }
}

export function mergePendingKind(
  hostKind: PendingKind | undefined,
  muxKind: PendingKind | undefined,
): PendingKind | undefined {
  if (muxKind !== undefined) return muxKind
  return hostKind
}

export function questionKindOf(questions: readonly { intent?: { kind?: string } }[]): PendingKind {
  if (questions.some((item) => item.intent?.kind === 'plan-review')) return 'plan-review'
  return 'question'
}
