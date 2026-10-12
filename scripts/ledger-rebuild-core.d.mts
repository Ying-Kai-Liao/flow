// Types for the test that imports ledger-rebuild-core.mjs.
type Tokens = { input: number; write5m: number; write1h: number; read: number; output: number }
type Bucket = Tokens & { long?: Tokens }
type Entry = Record<string, any>
type Reply = { id: string; model?: string; usage?: unknown; toolUse: boolean; at: number }
type Session = { first?: number; replies: Reply[] }
type Found = { sessions: Session[]; agentTexts: (key: string) => string[] | undefined }
type Row = { key: string; entry: Entry; next?: Entry; flagged?: string; outside?: boolean }

export const PRICES: Record<string, unknown>
export const FAMILIES: Record<string, string>
export const ZERO: Tokens
export function priceOf(model: string): unknown
export function costOf(model: string, b: Bucket): number | undefined
export function repliesOf(texts: string[]): Reply[]
export function summarize(replies: Reply[]): { models: Record<string, Bucket>; turns: number; first?: number; last?: number }
export function rebuild(ledger: Record<string, Entry>, found: Found): { ledger: Record<string, Entry | any>; rows: Row[] }
export function report(rows: Row[]): string
export function backupName(date: string, exists: (name: string) => boolean): string
